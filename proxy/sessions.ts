import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type * as net from 'net';
import { WebSocket, type RawData } from 'ws';

/** Where a client reattaches, relative to the proxy's own URL, so a reverse
 *  proxy's path prefix stays in front of it. */
export const RESUME_PATH = 'resume';

/** The most unacknowledged game output (as framed) the relay keeps for one
 *  session. A memory ceiling chosen here, not derived from a measured traffic
 *  rate: past it the session ends with a stated reason rather than dropping
 *  bytes out of a stream the client could no longer parse. There is no time
 *  limit. */
export const MAX_RETAINED_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How many connections may hold a resume reservation at once, from
 *  SESSION_RESUME_MAX — a chosen operator ceiling (default 32; at most 32 ×
 *  MAX_RETAINED_OUTPUT_BYTES = 512 MiB of retained game output), not a
 *  performance standard. The reservation is taken atomically with the offer; a
 *  plain connection's goes when its socket closes, a session that took the game
 *  over keeps it until the session ends, and a resume keeps its session's
 *  slot. */
export const MAX_RESUMABLE_SESSIONS = readSessionLimit(process.env.SESSION_RESUME_MAX);

function readSessionLimit(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 32;
}

export const DEFAULT_RESUME_ORIGIN = 'https://web.mudlet.org';
// Offer admission only; the resume endpoint still requires its secret and pinned Origin.
export const RESUME_ORIGINS = new Set((process.env.SESSION_RESUME_ORIGINS ?? DEFAULT_RESUME_ORIGIN)
    .split(',').map(origin => origin.trim()).filter(Boolean));

/** The reservations themselves. A constructor here takes one atomically, so the
 *  offer/accept trace can never exceed the limit. */
const reserved = new Set<RelaySession>();

const VERSION = 1;

type Control = Record<string, unknown>;

/** Sessions that opted in, by id. Memory only: a relay restart ends them all. */
const sessions = new Map<string, RelaySession>();

// WebSocket close.reason is capped at 123 bytes by the spec; trim defensively.
function clipReason(text: string): string {
    return text.length > 120 ? text.slice(0, 120) : text;
}

export function safeClose(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(code, clipReason(reason)); } catch { /* ignore */ }
    }
}

/** Out-of-band control message to the client. Sent as a **text** frame; MUD
 *  bytes always travel as binary frames, so the client can route the two apart
 *  without an envelope. Proxies predating TLS support simply never send these,
 *  which is what lets the client detect an out-of-date proxy. */
export function sendControl(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
}

const toBuffer = (data: RawData): Buffer =>
    Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

const isControl = (value: unknown): value is Control =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseControl(bytes: Buffer): Control | null {
    try {
        const msg: unknown = JSON.parse(bytes.toString());
        return isControl(msg) ? msg : null;
    } catch {
        return null;
    }
}

/** Offsets travel as decimal strings so JSON never rounds them. */
const offsetOf = (value: unknown): bigint | null =>
    typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;

/** One game-stream range: an unsigned 64-bit big-endian starting offset, then the bytes. */
function frame(offset: bigint, bytes: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(offset);
    return Buffer.concat([head, bytes]);
}

/**
 * One browser's connection to one game, as the proxy sees it.
 *
 * Until the client accepts the offer this is the plain proxy: every frame is
 * game bytes, and the game goes when the socket does. After `session.accept` the
 * relay, not the browser socket, owns the game connection: a lost frontend only
 * detaches, output is numbered and kept until acknowledged, and a replacement
 * socket that proves the session id and secret takes over the same game
 * connection — no new dial, no new login. There is no detach timer: it ends on
 * an authenticated end, when the game closes, or when a real limit is hit.
 */
export class RelaySession {
    /** The game connection, set by the proxy once dialled. */
    tcp: net.Socket | null = null;
    private readonly id = randomUUID();
    private readonly secret = randomBytes(32);
    private readonly offerId: string | null;
    private enabled = false;
    private connected = false;
    /** Game input accepted from the client, counted from its first byte. */
    private input = 0n;
    /** Game output read from the backend, counted from its first byte. */
    private output = 0n;
    /** Output the client has acknowledged. */
    private released = 0n;
    /** Output sent and not yet acknowledged: each range already framed, so the
     *  one buffer is both what the socket sends and what a resume replays. */
    private retained: { end: bigint; framed: Buffer }[] = [];
    private retainedBytes = 0;
    /** The game link's negotiated TLS facts, said again on every resume: the
     *  frontend may have been away, or half-open, when they were first said. */
    private tlsEstablished: Control | null = null;

    /** `ws` is the current frontend; a resume replaces it. With `offer`, the
     *  client is invited at once to opt in; an old client ignores the unknown
     *  control and carries on as before. */
    constructor(private ws: WebSocket | null, private readonly origin: string | null, offer: boolean) {
        if (offer && reserved.size >= MAX_RESUMABLE_SESSIONS) offer = false;   // full: the plain proxy, as ever
        if (offer) reserved.add(this);
        this.offerId = offer ? randomUUID() : null;
        if (this.offerId !== null) this.control({ type: 'session.offer', versions: [VERSION], offerId: this.offerId });
    }

    /** A control message to whichever frontend is attached now. */
    control(payload: Control): void {
        if (payload.type === 'tls.established') this.tlsEstablished = payload;
        if (this.ws) sendControl(this.ws, payload);
    }

    gameConnected(): void {
        this.connected = true;
        this.control({ type: 'game.connected' });
    }

    fromGame(chunk: Buffer): void {
        const offset = this.output;
        this.output += BigInt(chunk.length);
        if (!this.enabled) {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk, { binary: true });
            return;
        }
        const framed = frame(offset, chunk);
        this.retained.push({ end: this.output, framed });
        this.retainedBytes += framed.length;
        if (this.retainedBytes > MAX_RETAINED_OUTPUT_BYTES) this.close(1011, 'Retained output buffer exhausted', true);
        else this.send(framed);
    }

    fromClient(ws: WebSocket, data: RawData, isBinary: boolean): void {
        if (ws !== this.ws) return;                       // a replaced attachment can no longer write
        const bytes = toBuffer(data);
        if (!isBinary && this.handleControl(ws, bytes)) return;
        if (!this.enabled) {                              // the plain proxy: every frame is game input
            this.input += BigInt(bytes.length);
            this.write(bytes);
            return;
        }
        if (!isBinary) return;
        if (bytes.length < 8) { this.close(1002, 'Malformed input envelope', true); return; }
        const start = bytes.readBigUInt64BE(0);
        const end = start + BigInt(bytes.length - 8);
        if (start > this.input) { this.close(1002, 'Input range skipped bytes', true); return; }
        if (end > this.input) {                           // below the cursor was accepted already
            this.write(bytes.subarray(8 + Number(this.input - start)));
            this.input = end;
        }
        this.control({ type: 'session.ack', input: this.input.toString() });
    }

    /** The frontend went away: before opt-in the game goes with it, as it always
     *  has — and with it, a plain connection's reservation — after, the game
     *  stays and its output keeps being read and kept, held for the secret
     *  resume (or explicit end) that may still come. */
    frontClosed(ws: WebSocket): void {
        if (ws !== this.ws) return;
        this.ws = null;
        if (!this.enabled) {
            this.tcp?.destroy();
            reserved.delete(this);
        }
    }

    /** Session id and secret (and the Origin pinned at creation, which restricts
     *  browsers but is no substitute for the secret). */
    authorized(msg: Control, origin: string | null): boolean {
        if (origin !== this.origin || typeof msg.secret !== 'string') return false;
        const given = Buffer.from(msg.secret, 'base64');
        return given.length === this.secret.length && timingSafeEqual(given, this.secret);
    }

    /** Take over from the current frontend, if the client's cursors fit what this
     *  session holds. Nothing is displaced and nothing sent unless they do. */
    resume(ws: WebSocket, msg: Control): boolean {
        const read = offsetOf(msg.output);
        const acked = offsetOf(msg.inputAcked);
        const submitted = offsetOf(msg.inputEnd);
        if (read === null || acked === null || submitted === null
            || read < this.released || read > this.output || acked > this.input || this.input > submitted) return false;
        this.release(read);
        this.ws?.terminate();
        this.ws = ws;
        this.control({ type: 'session.resumed', input: this.input.toString(), catchupEnd: this.output.toString(), backendConnected: this.connected });
        if (this.tlsEstablished) this.control(this.tlsEstablished);   // before any replayed output is parsed
        for (const { framed } of this.retained) this.send(framed);
        return true;
    }

    /** End the session: the game closes, nothing unsent is flushed, no resume. */
    end(requester: WebSocket): void {
        if (requester !== this.ws) {
            sendControl(requester, { type: 'session.ended' });
            safeClose(requester, 1000, 'Session ended');
        }
        this.close(1000, 'Session ended');
    }

    /** True when the text frame was one of ours (and so is never game input). */
    private handleControl(ws: WebSocket, bytes: Buffer): boolean {
        const msg = parseControl(bytes);
        if (msg === null) return false;
        if (msg.type === 'session.cancel' && this.offerId !== null && msg.offerId === this.offerId) {
            // The client that was offered this session is cancelling it in its
            // offered stage, on the very socket the offer went to — whether its
            // accept reached us first or after this. The game goes with it;
            // nothing unsent is flushed.
            this.close(1000, 'Session cancelled before it was taken over');
            return true;
        }
        if (!this.enabled) {
            if (msg.type !== 'session.accept' || this.offerId === null || msg.offerId !== this.offerId) return false;
            this.enabled = true;
            this.released = this.output;                  // the raw prefix was delivered unretained
            sessions.set(this.id, this);
            this.control({
                type: 'session.enabled', sessionId: this.id, secret: this.secret.toString('base64'),
                resumePath: RESUME_PATH, input: this.input.toString(), output: this.output.toString(),
            });
        } else if (msg.type === 'session.ack') {
            const acked = offsetOf(msg.output);
            if (acked !== null && acked <= this.output) this.release(acked);
        } else if (msg.type === 'session.end' && this.authorized(msg, this.origin)) {
            this.end(ws);
        }
        return true;
    }

    private release(upTo: bigint): void {
        if (upTo <= this.released) return;
        this.released = upTo;
        let done = 0;
        while (done < this.retained.length && this.retained[done].end <= upTo) this.retainedBytes -= this.retained[done++].framed.length;
        this.retained.splice(0, done);
    }

    private send(framed: Buffer): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(framed, { binary: true });
    }

    private write(bytes: Buffer): void {
        if (!this.tcp?.writable) return;
        try {
            this.tcp.write(bytes);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[proxy] Failed to forward message:', message);
            this.close(1011, `Proxy: TCP write error: ${message}`);
        }
    }

    /** The end of this session, for whatever reason: the frontend is told (and,
     *  after opt-in, told it is final) and the game connection closes. `failed`
     *  says the relay ended it over a limit or a broken stream rather than the
     *  game or the player — the client must not answer that with a new game. */
    close(code: number, reason: string, failed = false): void {
        sessions.delete(this.id);
        reserved.delete(this);
        const ws = this.ws;
        this.ws = null;
        this.retained = [];
        this.retainedBytes = 0;
        if (ws) {
            if (this.enabled) sendControl(ws, { type: 'session.ended', failed });
            safeClose(ws, code, reason);
        }
        this.tcp?.destroy();
    }
}

/**
 * The reattachment endpoint. A socket here is unauthenticated: it never dials a
 * backend and nothing it sends reaches the game until its first message proves —
 * session id, secret and the Origin pinned at creation — that it owns a live
 * session. A refusal is generic and displaces nobody.
 */
export function acceptResume(ws: WebSocket, origin: string | null): void {
    let owner: RelaySession | null = null;
    const refuse = (reason: string): void => {
        sendControl(ws, { type: 'session.unavailable', reason });
        safeClose(ws, 1008, 'Resume request refused');
    };
    ws.on('close', () => owner?.frontClosed(ws));
    ws.on('error', () => owner?.frontClosed(ws));
    ws.once('message', (data, isBinary) => {
        const msg = isBinary ? null : parseControl(toBuffer(data));
        const session = typeof msg?.sessionId === 'string' ? sessions.get(msg.sessionId) : undefined;
        if (!msg || !session || !session.authorized(msg, origin)) { refuse('unavailable'); return; }
        if (msg.type === 'session.end') { session.end(ws); return; }
        if (msg.type !== 'session.resume' || !session.resume(ws, msg)) { refuse('cursor'); return; }
        owner = session;
        ws.on('message', (frameData, binary) => session.fromClient(ws, frameData, binary));
    });
}
