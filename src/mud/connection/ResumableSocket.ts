/**
 * The WebSocket MudClient talks to, made able to outlive its transport.
 *
 * A proxy that offers session resumption (proxy/sessions.ts) owns the game
 * connection itself, so losing the browser's socket need not end the game. Once
 * the offer is accepted, game bytes travel in sequenced envelopes (an unsigned
 * 64-bit big-endian offset, then the bytes) and a lost socket is a *detach*: the
 * parser, MCCP and telnet state and queued input all live above this class and
 * are untouched, and a new socket carrying the session id and secret reattaches
 * to the same game connection — no new dial, no new login. Only bytes the other
 * side has not acknowledged are resent, with their original offsets. Without an
 * offer this is a pass-through to one WebSocket. The secret and the cursors live
 * in memory only.
 */

const VERSION = 1;

/** Bound on input waiting for the game connection (sent but unacknowledged, or
 *  kept while the transport is away). Past it the session ends with a stated
 *  reason rather than dropping bytes the game never saw. A memory ceiling chosen
 *  here, not derived from a measured rate. */
const MAX_UNSETTLED_BYTES = 1024 * 1024;

type Control = Record<string, unknown>;
type MessageData = ArrayBuffer | string;

/** `plain`: no offer taken, a pass-through. `offered`: accept sent, marker not
 *  yet seen, sends held. `live`: enabled and attached. `away`: enabled, but the
 *  transport is lost or still catching up. `ended`: over, nothing resumes. */
type Phase = 'plain' | 'offered' | 'live' | 'away' | 'ended';

const isControl = (value: unknown): value is Control =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseControl(text: string): Control | null {
    try {
        const msg: unknown = JSON.parse(text);
        return isControl(msg) ? msg : null;
    } catch {
        return null;
    }
}

/** Offsets travel as decimal strings so JSON never rounds them. */
const offsetOf = (value: unknown): bigint | null =>
    typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;

function frame(offset: bigint, bytes: Uint8Array): Uint8Array {
    const framed = new Uint8Array(8 + bytes.length);
    new DataView(framed.buffer).setBigUint64(0, offset, false);
    framed.set(bytes, 8);
    return framed;
}

/** Keep opaque proxy query credentials and the reverse-proxy prefix on reattachment. */
const DIAL_PARAMS = new Set(['host', 'port', 'tls', 'tlsIgnoreExpired', 'tlsIgnoreSelfSigned', 'tlsIgnoreAll']);

function resumeUrl(base: string, path: string): string {
    const url = new URL(base);
    for (const name of DIAL_PARAMS) url.searchParams.delete(name);
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
    return url.toString();
}

export class ResumableSocket {
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<MessageData>) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    /** The transport was lost but the relay still holds the session. */
    ondetach: (() => void) | null = null;
    /** A replacement transport has caught up: sends and parsing may carry on. */
    onresume: (() => void) | null = null;
    /** A resume (or end) attempt closed without an answer: the proxy could not be reached. */
    onunreachable: (() => void) | null = null;

    private ws: WebSocket | null = null;
    /** A reattachment (or end) attempt in flight, before it is adopted. */
    private dialing: WebSocket | null = null;
    private watching: (() => void) | null = null;
    private phase: Phase = 'plain';
    private session: { id: string; secret: string; url: string } | null = null;
    /** The offer taken but not yet named by its marker, if one was. */
    private offerId: string | null = null;
    /** Raw game bytes sent / received before the marker, which must match the relay's. */
    private rawOut = 0n;
    private rawIn = 0n;
    /** Next input offset to assign, and the input the relay has accepted. */
    private sent = 0n;
    private acked = 0n;
    /** Next output offset expected, and where it must reach after a resume. */
    private received = 0n;
    private catchupEnd = 0n;
    /** Submitted, not yet accepted by the relay: resent with their original offsets. */
    private unacked: { offset: bigint; bytes: Uint8Array }[] = [];
    /** Sends made while the transport is away (or the marker pending), in call order. */
    private held: Uint8Array[] = [];
    private heldBytes = 0;
    private failure = false;

    constructor(private readonly baseUrl: string, protocols: string[] = []) {
        // Advertise subprotocols only when configured — passing an empty array
        // still sends an (empty) Sec-WebSocket-Protocol header, so omit the
        // argument entirely in the common case to keep the bare handshake.
        this.attach(protocols.length > 0 ? new WebSocket(baseUrl, protocols) : new WebSocket(baseUrl));
    }

    get protocol(): string { return this.ws?.protocol ?? ''; }
    get bufferedAmount(): number { return this.ws?.bufferedAmount ?? 0; }

    /** A retained session reads as open even between transports: sends are kept. */
    get readyState(): number {
        return this.phase === 'live' || this.phase === 'away' ? WebSocket.OPEN : (this.ws?.readyState ?? WebSocket.CLOSED);
    }

    /** The transport is gone or still catching up: typed input waits as a draft
     *  and no new parsing starts. */
    get away(): boolean { return this.phase === 'away'; }

    /** The user ended the session while the relay could not be told. */
    get endPending(): boolean { return this.phase === 'ended' && this.session !== null; }

    /** The session ended because it failed — a refused resume, a stream that
     *  cannot continue safely — not because the game or the player ended it. */
    get failed(): boolean { return this.failure; }

    send(data: Uint8Array): void {
        if (this.phase === 'plain') {
            this.rawOut += BigInt(data.length);
            this.ws?.send(data);
        } else if (this.phase === 'live') {
            this.submit(data);
        } else if (this.phase !== 'ended') {
            this.held.push(data);
            this.heldBytes += data.length;
        }
        if (this.heldBytes + Number(this.sent - this.acked) > MAX_UNSETTLED_BYTES) {
            this.abort('Too much input is waiting on the game connection; the session cannot continue safely.');
        }
    }

    /** Reattach now. True while a retained session is away — also when an attempt
     *  is already under way — so a caller never dials a second game. */
    resume(): boolean {
        if (this.phase !== 'away') return false;
        this.attempt();
        return true;
    }

    private attach(ws: WebSocket): void {
        this.ws = ws;
        // Binary frames, not base64 text: the proxy worker sends bytes directly,
        // and decoding base64 on every frame was the bulk of its (and our)
        // per-message CPU cost.
        ws.binaryType = 'arraybuffer';
        ws.onopen = event => { if (this.ws === ws) this.onopen?.(event); };
        ws.onmessage = (event: MessageEvent<MessageData>) => { if (this.ws === ws) this.message(event); };
        ws.onclose = event => { if (this.ws === ws) this.closed(event); };
        ws.onerror = event => { if (this.ws === ws) this.onerror?.(event); };
    }

    private message(event: MessageEvent<MessageData>): void {
        const { data } = event;
        if (typeof data === 'string') {
            const msg = parseControl(data);
            if (msg === null || !this.control(msg)) this.onmessage?.(event);
        } else if (this.phase === 'plain' || this.phase === 'offered') {
            this.rawIn += BigInt(data.byteLength);
            this.onmessage?.(event);
        } else if (this.phase !== 'ended') {
            this.range(data);
        }
    }

    /** The relay's own messages. Anything else (game.connected, tls.*) is the
     *  caller's — and until an offer is taken, so is everything but the offer. */
    private control(msg: Control): boolean {
        if (this.phase === 'plain' && msg.type !== 'session.offer') return false;
        switch (msg.type) {
            case 'session.offer': this.offered(msg); return true;
            case 'session.enabled': this.enabled(msg); return true;
            case 'session.ack': {
                const accepted = offsetOf(msg.input);
                if (accepted !== null) { this.release(accepted); this.settle(); }
                return true;
            }
            case 'session.ended':
                if (msg.failed === true) this.failure = true;   // a limit or a broken stream, not the game quitting
                this.finish();
                return true;                                    // the close that follows is the ordinary one
            default: return false;
        }
    }

    private offered(msg: Control): void {
        if (this.phase !== 'plain' || typeof msg.offerId !== 'string'
            || !Array.isArray(msg.versions) || !msg.versions.includes(VERSION)) return;
        this.offerId = msg.offerId;
        this.phase = 'offered';
        this.ws?.send(JSON.stringify({ type: 'session.accept', offerId: msg.offerId, version: VERSION }));
    }

    private enabled(msg: Control): void {
        if (this.phase !== 'offered') return;
        const { sessionId, secret, resumePath } = msg;
        if (typeof sessionId === 'string' && typeof secret === 'string' && typeof resumePath === 'string') {
            this.session = { id: sessionId, secret, url: resumeUrl(this.baseUrl, resumePath) };
        }
        // Both ends number the same bytes only if the marker matches what we sent and received so far.
        if (this.session === null || offsetOf(msg.input) !== this.rawOut || offsetOf(msg.output) !== this.rawIn) {
            this.abort('The proxy\'s session marker does not match this connection.');
            return;
        }
        this.phase = 'live';
        this.sent = this.acked = this.rawOut;
        this.received = this.rawIn;
        const waiting = this.held;
        this.held = [];
        this.heldBytes = 0;
        for (const bytes of waiting) this.submit(bytes);
    }

    private submit(bytes: Uint8Array): void {
        this.unacked.push({ offset: this.sent, bytes });
        this.ws?.send(frame(this.sent, bytes));
        this.sent += BigInt(bytes.length);
    }

    /** The relay accepted input up to `upTo`: that much never needs resending. */
    private release(upTo: bigint): void {
        if (upTo <= this.acked) return;
        this.acked = upTo;
        let done = 0;
        while (done < this.unacked.length && this.unacked[done].offset + BigInt(this.unacked[done].bytes.length) <= upTo) done++;
        this.unacked.splice(0, done);
    }

    /** One range of game output, handed on once and in order: a duplicate is
     *  dropped, an overlapping prefix trimmed, a forward gap never skipped. */
    private range(data: ArrayBuffer): void {
        if (data.byteLength < 8) { this.abort('Malformed output envelope.'); return; }
        const start = new DataView(data).getBigUint64(0, false);
        const end = start + BigInt(data.byteLength - 8);
        if (start > this.received) { this.abort('The game stream skipped bytes; the session cannot continue safely.'); return; }
        if (end > this.received) {
            const skip = Number(this.received - start);
            this.received = end;                           // ours before any callback can run on it
            this.onmessage?.(new MessageEvent('message', { data: data.slice(8 + skip) }));
        }
        this.ws?.send(JSON.stringify({ type: 'session.ack', output: this.received.toString() }));
        this.settle();
    }

    private closed(event: CloseEvent): void {
        this.ws = null;
        if (this.phase !== 'live' && this.phase !== 'away') {
            this.phase = 'ended';
            this.onclose?.(event);
            return;
        }
        const wasLive = this.phase === 'live';
        this.phase = 'away';
        if (wasLive) this.ondetach?.();
        this.watch();
    }

    /** One attempt now if the page is in the foreground, then one per later
     *  foreground visit — never a timer, never a loop. */
    private watch(): void {
        if (typeof document === 'undefined') return;
        if (document.visibilityState === 'visible') this.attempt();
        if (this.watching !== null) return;
        this.watching = () => { if (document.visibilityState === 'visible') this.attempt(); };
        document.addEventListener('visibilitychange', this.watching);
    }

    private unwatch(): void {
        if (this.watching !== null) document.removeEventListener('visibilitychange', this.watching);
        this.watching = null;
    }

    /** Open one reattachment socket and ask it to resume — or, once the user has
     *  ended the session, to end it. One in flight at a time. */
    private attempt(): void {
        const session = this.session;
        if (session === null || this.ws !== null || this.dialing !== null) return;
        let ws: WebSocket;
        try {
            ws = new WebSocket(session.url);
        } catch (error) {
            console.error('Failed to open the resume connection:', error);
            return;
        }
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            const { id: sessionId, secret } = session;
            ws.send(JSON.stringify(this.phase === 'ended'
                ? { type: 'session.end', sessionId, secret }
                : { type: 'session.resume', sessionId, secret, output: this.received.toString(), inputAcked: this.acked.toString(), inputEnd: this.sent.toString() }));
        };
        this.follow(ws);
    }

    /** Wait on `ws` for the relay's answer to a resume or an end. If it closes
     *  without one, say so: the next visit (or Connect) tries again. */
    private follow(ws: WebSocket): void {
        this.dialing = ws;
        ws.onmessage = (event: MessageEvent<MessageData>) => this.verdict(ws, event.data);
        ws.onclose = () => {
            if (this.dialing !== ws) return;
            this.dialing = null;
            this.onunreachable?.();
        };
    }

    private verdict(ws: WebSocket, data: MessageData): void {
        if (this.dialing !== ws || typeof data !== 'string') return;
        const msg = parseControl(data);
        const accepted = offsetOf(msg?.input);
        const catchupEnd = offsetOf(msg?.catchupEnd);
        if (msg?.type === 'session.resumed' && accepted !== null && catchupEnd !== null) {
            this.dialing = null;
            this.attach(ws);
            this.release(accepted);
            for (const { offset, bytes } of this.unacked) ws.send(frame(offset, bytes));   // the original ranges, not new commands
            this.catchupEnd = catchupEnd;
            // The game leg may have come up while we were away: say so as it would have been said.
            if (msg.backendConnected === true) this.onmessage?.(new MessageEvent('message', { data: '{"type":"game.connected"}' }));
            this.settle();
        } else if (msg?.type === 'session.ended' || msg?.type === 'session.unavailable') {
            const ending = this.phase === 'ended';          // the end was delivered, or the session was gone already
            this.dialing = null;
            ws.close();
            this.finish();
            if (!ending) this.report('The game session could not be resumed.');
        }
    }

    /** Once the replacement transport has delivered all the output the relay held
     *  and the relay has accepted all the input we had sent, the input kept while
     *  away is sent (with new offsets, in order) and parsing carries on. */
    private settle(): void {
        if (this.phase !== 'away' || this.ws === null || this.received < this.catchupEnd || this.acked < this.sent) return;
        this.phase = 'live';
        this.unwatch();
        const waiting = this.held;
        this.held = [];
        this.heldBytes = 0;
        for (const bytes of waiting) this.submit(bytes);
        this.onresume?.();
    }

    /** Hang up. A retained session is ended too — authenticated, flushing nothing
     *  — so the game does not stay online with nobody watching. The end stays
     *  pending, and its secret kept, until the relay answers it: on this socket if
     *  it is open, else on the resume endpoint, and again on later visits if the
     *  answer never comes. An offer taken but not yet named for (marker pending)
     *  is ended with an explicit cancellation on its own socket — our accept may
     *  already have made the relay take the game over, and only this socket can
     *  say so — flushing nothing. If the socket is already beyond sending, the
     *  cancellation cannot leave: the relay keeps a session this page was never
     *  named for, which nothing here can ever resume or end, and the admission
     *  limit is what bounds what that holds. */
    close(): void {
        const ws = this.ws;
        const session = this.session;
        this.ws = null;
        this.dialing?.close();
        this.dialing = null;
        this.phase = 'ended';
        this.held = [];
        this.heldBytes = 0;
        this.unacked = [];
        if (session === null && this.offerId !== null && ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'session.cancel', offerId: this.offerId }));
        }
        if (session !== null && ws?.readyState === WebSocket.OPEN) {
            this.follow(ws);                               // left open: a socket already closing drops the answer
            ws.send(JSON.stringify({ type: 'session.end', sessionId: session.id, secret: session.secret }));
        } else {
            if (session !== null) this.attempt();
            ws?.close();
        }
        if (session !== null) this.watch();
    }

    /** Nothing more will resume, retry or send. */
    private finish(): void {
        this.phase = 'ended';
        this.session = null;
        this.held = [];
        this.heldBytes = 0;
        this.unacked = [];
        this.unwatch();
    }

    /** The session cannot continue: end it, and say why as the close it is. */
    private abort(reason: string): void {
        this.close();
        this.report(reason);
    }

    private report(reason: string): void {
        this.failure = true;
        this.onclose?.(new CloseEvent('close', { code: 1011, reason, wasClean: false }));
    }
}
