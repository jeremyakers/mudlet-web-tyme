// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as tls from 'tls';
import * as zlib from 'zlib';
import type { Server } from 'http';
import { once } from 'node:events';
import { WebSocket as WsClient } from 'ws';
import { MudClient } from '../../src/mud/connection/MudClient';
import { EventBus } from '../../src/core/EventBus';
import type { MudClientEvents } from '../../src/mud/events';
import { MAX_RETAINED_OUTPUT_BYTES } from '../../proxy/sessions';

/** The default allowed browser origin (the official hosted client). The relay's
 *  admission reads the `Origin` header, so a client representing it sends it. */
const HOSTED_ORIGIN = 'https://web.mudlet.org';

/** The real Node proxy (SESSION_RESUME on or off), a real TCP "game", the real
 *  MudClient on Node's WebSocket, and `ws` clients that speak the wire protocol
 *  by hand. Nothing in the path is mocked. */

const DO_GMCP = '\xff\xfd\xc9';
const WILL_MCCP2 = '\xff\xfb\x56';
const DO_MCCP2 = '\xff\xfd\x56';
const MCCP2_START = '\xff\xfa\x56\xff\xf0';

/** A throwaway self-signed certificate for localhost, for the TLS game below
 *  (`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes
 *  -days 36500 -subj /CN=localhost -addext subjectAltName=DNS:localhost`). */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg07ovMpxiw5pX8FIl
nK3fGnXWi/+zJm2IQ2nHy1IPd5OhRANCAAT+nStZ64IfvXU2TMtvnqIlZm3cBdPT
m3LCXHBKegfbTFfQDJdSl3N/3ufavnRdSFNvIza45kkIKHM0U8ufK+lw
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlTCCATugAwIBAgIUDThmeGC0RNF5LfWXSOGVc2vO+S0wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwOTIwMDc0NFoYDzIxMjYxMDE2
MjAwNzQ0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT+nStZ64IfvXU2TMtvnqIlZm3cBdPTm3LCXHBKegfbTFfQDJdSl3N/
3ufavnRdSFNvIza45kkIKHM0U8ufK+lwo2kwZzAdBgNVHQ4EFgQUoNHG1pNICH3D
bwKBYmviqGYSbCEwHwYDVR0jBBgwFoAUoNHG1pNICH3DbwKBYmviqGYSbCEwDwYD
VR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3QwCgYIKoZIzj0EAwID
SAAwRQIgOwIQBpuL/IUs0JujajbnaVhvktkHPbf5gP7zBz6T5qICIQDCVSTv28qk
w+aXjbvswXdJJdBqXYLYUgRHisoPGTCPpQ==
-----END CERTIFICATE-----`;

type Control = Record<string, unknown>;

function portOf(server: net.Server): number {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server is not listening');
    return address.port;
}

/** `until(ok)` resolves once `ok()` holds, re-checked on every `poke()`. */
function watcher(): { poke: () => void; until: (ok: () => boolean) => Promise<void> } {
    let waiting: (() => void)[] = [];
    return {
        poke: () => { const run = waiting; waiting = []; run.forEach(check => check()); },
        until: ok => new Promise<void>(resolve => {
            const check = (): void => { if (ok()) resolve(); else waiting.push(check); };
            check();
        }),
    };
}

interface Game {
    host: string;
    port: number;
    connects: () => number;
    logins: () => number;
    received: () => string;
    closed: () => boolean;
    write: (text: string) => void;
    hangUp: () => void;
    compress: () => void;
    /** A TLS game accepts the TCP connection at once but holds its handshake until this. */
    open: () => void;
    until: (ok: () => boolean) => Promise<void>;
    close: () => void;
}

/** A line-mode game: a banner on connect and one `Welcome` per `login <name>`.
 *  It counts connections and logins, so "the same backend, no fresh login" is
 *  something it can say, and it can switch to one continuous zlib stream. */
async function startGame(secure = false): Promise<Game> {
    const host = secure ? 'localhost' : '127.0.0.1';
    let connects = 0;
    let logins = 0;
    let received = '';
    let closed = false;
    let live: net.Socket | null = null;
    let pending: net.Socket | null = null;
    let deflate: zlib.Deflate | null = null;
    const changes = watcher();
    const write = (text: string): void => {
        if (deflate) { deflate.write(text, 'latin1'); deflate.flush(); } else live?.write(text, 'latin1');
    };
    const onSocket = (sock: net.Socket): void => {
        live = sock;
        sock.on('data', chunk => {
            const text = chunk.toString('latin1');
            received += text;
            for (const m of text.matchAll(/login (\w+)/g)) { logins += 1; write(`Welcome, ${m[1]}\n`); }
            changes.poke();
        });
        sock.on('error', () => {});             // the relay may reset a connection that still has output queued
        sock.on('close', () => { closed = true; changes.poke(); });
        write('BANNER\n');
    };
    const tlsServer = tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, onSocket);
    const server = net.createServer({ pauseOnConnect: secure }, sock => {
        connects += 1;
        if (secure) pending = sock; else onSocket(sock);
    });
    await new Promise<void>(r => server.listen(0, host, r));
    return {
        host,
        port: portOf(server),
        connects: () => connects,
        logins: () => logins,
        received: () => received,
        closed: () => closed,
        write,
        hangUp: () => live?.end(),
        compress: () => {
            live?.write(MCCP2_START, 'latin1');
            deflate = zlib.createDeflate();
            deflate.on('data', (chunk: Buffer) => { live?.write(chunk); });
        },
        open: () => { if (pending) tlsServer.emit('connection', pending); },
        until: changes.until,
        close: () => { deflate?.end(); live?.destroy(); pending?.destroy(); server.close(); },
    };
}

/** A TCP path between client and relay that can be cut without any close
 *  frame — the phone losing its network. */
async function startNetwork(relayPort: number): Promise<{ port: number; cut: () => void; close: () => void }> {
    const links = new Set<net.Socket>();
    const server = net.createServer(client => {
        const upstream = net.connect(relayPort, '127.0.0.1');
        for (const s of [client, upstream]) { links.add(s); s.on('error', () => {}); s.on('close', () => links.delete(s)); }
        client.pipe(upstream);
        upstream.pipe(client);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const cut = (): void => { links.forEach(s => s.destroy()); };
    return { port: portOf(server), cut, close: () => { cut(); server.close(); } };
}

/** The real proxy module reads SESSION_RESUME, SESSION_RESUME_MAX and
 *  SESSION_RESUME_ORIGINS when it loads, so each mode gets its own module
 *  instance, listening on its own ephemeral port. */
async function startRelay(resume: boolean, max?: string, origins?: string): Promise<{ server: Server; port: number }> {
    vi.resetModules();
    process.env.PORT = '0';
    if (resume) process.env.SESSION_RESUME = '1'; else delete process.env.SESSION_RESUME;
    if (max === undefined) delete process.env.SESSION_RESUME_MAX; else process.env.SESSION_RESUME_MAX = max;
    if (origins === undefined) delete process.env.SESSION_RESUME_ORIGINS; else process.env.SESSION_RESUME_ORIGINS = origins;
    const { server } = await import('../../proxy/server');
    await once(server, 'listening');
    return { server, port: portOf(server) };
}

/** A `ws` client that queues the text controls it receives, so none is missed. */
class Raw {
    readonly sock: WsClient;
    readonly seen: Control[] = [];
    readonly frames: Buffer[] = [];
    /** Every message in arrival order: a control's type, or `frame`. */
    readonly order: string[] = [];
    readonly closed: Promise<[number, string]>;
    /** With `autoAck`, every game-output frame is acknowledged as it arrives. */
    autoAck = false;
    private ackedTo = 0n;
    private queue: Control[] = [];
    private changes = watcher();
    /** With no origin argument, this is the official hosted client's browser:
     *  its page sends its own Origin on every socket, and the relay's admission
     *  reads it. `null` is a CLI client without one. */
    constructor(url: string, origin: string | null = HOSTED_ORIGIN) {
        this.sock = new WsClient(url, origin ? { headers: { Origin: origin } } : undefined);
        this.sock.on('error', () => {});
        this.sock.on('open', () => this.changes.poke());
        this.sock.on('message', (data: Buffer, isBinary: boolean) => {
            this.order.push(isBinary ? 'frame' : String(JSON.parse(data.toString()).type));
            if (isBinary) {
                this.frames.push(data);
                if (this.autoAck) {
                    this.ackedTo = data.readBigUInt64BE(0) + BigInt(data.length - 8);
                    this.send({ type: 'session.ack', output: String(this.ackedTo) });
                }
            } else { const control: Control = JSON.parse(data.toString()); this.seen.push(control); this.queue.push(control); }
            this.changes.poke();
        });
        this.closed = new Promise(resolve => this.sock.once('close', (code: number, reason: Buffer) => resolve([code, reason.toString()])));
    }
    async control(type: string): Promise<Control> {
        await this.changes.until(() => this.queue.some(c => c.type === type));
        return this.queue.splice(this.queue.findIndex(c => c.type === type), 1)[0];
    }
    ready(): Promise<void> { return this.changes.until(() => this.sock.readyState === WsClient.OPEN); }
    send(message: Control | Buffer): void { this.sock.send(Buffer.isBuffer(message) ? message : JSON.stringify(message)); }
    sawFrame(): Promise<void> { return this.changes.until(() => this.frames.length > 0); }
    /** Resolves once output up to `offset` has been received and acknowledged. */
    acked(offset: bigint): Promise<void> { return this.changes.until(() => this.ackedTo >= offset); }
}

function envelope(offset: bigint, text: string): Buffer {
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(offset);
    return Buffer.concat([head, Buffer.from(text, 'latin1')]);
}

function counts(bus: EventBus<MudClientEvents>, ...names: (keyof MudClientEvents)[]): Record<string, number> {
    const seen: Record<string, number> = {};
    for (const name of names) { seen[name] = 0; bus.on(name, () => { seen[name] += 1; }); }
    return seen;
}

const nextEvent = (bus: EventBus<MudClientEvents>, name: keyof MudClientEvents): Promise<void> =>
    new Promise(resolve => { const off = bus.on(name, () => { off(); resolve(); }); });

describe('session resumption through the real proxy', () => {
    const servers: Server[] = [];
    let resumePort = 0;
    let plainPort = 0;
    let game: Game;
    const games: Game[] = [];
    let network: { port: number; cut: () => void; close: () => void } | null = null;
    const raws: Raw[] = [];

    /** The browser the hosted page runs in sends its own `Origin`; Node clients
     *  do not, so the MudClient here presents the default allowed origin the
     *  way its page would. */
    let pageWebSocket: unknown;
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        pageWebSocket = (globalThis as { WebSocket: unknown }).WebSocket;
        (globalThis as { WebSocket: unknown }).WebSocket = class extends WsClient {
            constructor(url: string | URL, protocols?: string | string[] | null) {
                super(url, protocols ?? undefined, { headers: { Origin: HOSTED_ORIGIN } });
            }
        };
        const resuming = await startRelay(true);
        const plain = await startRelay(false);
        servers.push(resuming.server, plain.server);
        resumePort = resuming.port;
        plainPort = plain.port;
    });
    afterAll(() => {
        (globalThis as { WebSocket: unknown }).WebSocket = pageWebSocket;
        servers.forEach(s => { s.closeAllConnections(); s.close(); });
        vi.restoreAllMocks();
    });
    afterEach(() => {
        raws.forEach(r => r.sock.terminate()); raws.length = 0;
        network?.close(); network = null;
        [game, ...games].forEach(g => g.close()); games.length = 0;
    });

    const proxyUrl = (port: number, target: Game = game): string => `ws://127.0.0.1:${port}/?host=${target.host}&port=${target.port}`;
    const resumeUrl = (port = resumePort): string => `ws://127.0.0.1:${port}/resume`;
    /** A fresh client. With no origin, this is the hosted client's browser;
     *  `null` is a CLI client without an Origin header. */
    const raw = (url: string, origin: string | null = HOSTED_ORIGIN): Raw => { const r = new Raw(url, origin); raws.push(r); return r; };

    /** Connect (with extra proxy `query`), send `prefix` as plain game input,
     *  accept the offer, and return the enabled session's credentials. `port`
     *  and `target` serve a relay/backup other than the shared ones. */
    async function enable(prefix = '', query = '', port = resumePort, target = game): Promise<{ raw: Raw; id: string; secret: string; input: string; output: string }> {
        const r = raw(proxyUrl(port, target) + query);
        const offer = await r.control('session.offer');
        if (prefix) r.send(Buffer.from(prefix, 'latin1'));
        r.send({ type: 'session.accept', offerId: offer.offerId, version: 1 });
        const marker = await r.control('session.enabled');
        return { raw: r, id: String(marker.sessionId), secret: String(marker.secret), input: String(marker.input), output: String(marker.output) };
    }

    /** A fresh socket on the resume endpoint with its first message sent. */
    async function onEndpoint(message: Control, origin?: string | null, url = resumeUrl()): Promise<Raw> {
        const r = raw(url, origin);
        await r.ready();
        r.send(message);
        return r;
    }

    it('keeps one backend and one login through two frontend drops, losing nothing and re-running nothing', async () => {
        game = await startGame();
        network = await startNetwork(resumePort);
        const bus = new EventBus<MudClientEvents>();
        const seen = counts(bus, 'client.connect', 'client.established', 'client.disconnect', 'client.detached', 'client.resumed');
        let shown = '';
        let incoming = '';
        const output = watcher();
        bus.on('flushLines', groups => { shown += groups.map(g => g.text).join(''); output.poke(); });
        bus.on('socket.incoming', data => { incoming += data; output.poke(); });
        const client = new MudClient({ url: proxyUrl(network.port) }, bus);

        client.connect();
        await output.until(() => shown.includes('BANNER'));
        client.send('login Alpha');
        await output.until(() => shown.includes('Welcome, Alpha'));

        // A telnet sequence split across the drop: the lone IAC waits in the
        // parser, and the rest of it only arrives once the transport is back.
        game.write('\xff');
        await output.until(() => incoming.endsWith('\xff'));
        let detached = nextEvent(bus, 'client.detached');
        network.cut();
        await detached;
        expect(game.connects()).toBe(1);
        expect(game.closed()).toBe(false);
        game.write('\xfb\xc9AWAY-ONE\n');
        let resumed = nextEvent(bus, 'client.resumed');
        expect(client.resumeTransport()).toBe(true);
        await resumed;
        await output.until(() => shown.includes('AWAY-ONE'));
        await game.until(() => game.received().includes(DO_GMCP));

        // From here the game's output is one continuous zlib stream: only the
        // inflater itself, kept across the next drop, can read what follows.
        game.write(WILL_MCCP2);
        await game.until(() => game.received().includes(DO_MCCP2));
        game.compress();
        game.write('PACKED-ONE\n');
        await output.until(() => shown.includes('PACKED-ONE'));
        detached = nextEvent(bus, 'client.detached');
        network.cut();
        await detached;
        client.send('while-away');
        game.write('PACKED-TWO\n');
        resumed = nextEvent(bus, 'client.resumed');
        client.resumeTransport();
        await resumed;
        await output.until(() => shown.includes('PACKED-TWO'));
        await game.until(() => game.received().includes('while-away\r\n'));
        client.send('after');
        await game.until(() => game.received().endsWith('after\r\n'));

        expect(game.connects()).toBe(1);
        expect(game.logins()).toBe(1);
        expect(game.received().split(DO_GMCP).length - 1).toBe(1);
        expect(game.received().split('while-away').length - 1).toBe(1);
        expect(game.received()).not.toContain('session.');
        expect(seen).toEqual({ 'client.connect': 1, 'client.established': 1, 'client.detached': 2, 'client.resumed': 2, 'client.disconnect': 0 });

        client.disconnect();
        await game.until(() => game.closed());
        expect(seen['client.disconnect']).toBe(1);
    });

    it('ends for real when the game closes the connection: an ordinary disconnect, with nothing left to resume', async () => {
        game = await startGame();
        const bus = new EventBus<MudClientEvents>();
        const seen = counts(bus, 'client.detached', 'client.resumed', 'client.disconnect', 'client.error', 'client.sessionFailed');
        const client = new MudClient({ url: proxyUrl(resumePort) }, bus);
        client.connect();
        await nextEvent(bus, 'client.established');
        game.hangUp();                                       // the game logs the player out
        await nextEvent(bus, 'client.disconnect');
        expect(seen).toEqual({ 'client.detached': 0, 'client.resumed': 0, 'client.disconnect': 1, 'client.error': 0, 'client.sessionFailed': 0 });
        expect(client.resumeTransport()).toBe(false);
        expect(game.connects()).toBe(1);
    });

    it('refuses a wrong secret, origin or cursor without displacing the attached client, and honours the right one', async () => {
        game = await startGame();
        const a = await enable();
        const resume = { type: 'session.resume', sessionId: a.id, secret: a.secret, output: a.output, inputAcked: '0', inputEnd: '0' };
        const refused = async (overrides: Control, origin?: string): Promise<unknown> =>
            (await (await onEndpoint({ ...resume, ...overrides }, origin)).control('session.unavailable')).type;
        await refused({ secret: Buffer.alloc(32).toString('base64') });
        await refused({}, 'https://evil.example');
        await refused({ output: '999999999999' });
        await refused({ inputAcked: '5' });
        expect(game.connects()).toBe(1);

        a.raw.send(envelope(0n, 'STILL-HERE\r\n'));            // never displaced: its input still lands
        await game.until(() => game.received().includes('STILL-HERE'));

        const b = await onEndpoint({ ...resume, inputEnd: '12' });
        expect(await b.control('session.resumed')).toMatchObject({ input: '12' });
        await a.raw.closed;                                     // the superseded attachment is fenced off
        b.send(envelope(12n, 'FROM-B\r\n'));
        await game.until(() => game.received().includes('FROM-B'));
        expect(game.connects()).toBe(1);
    });

    it('tells a resuming client the TLS handshake it missed, ahead of the replayed output, on every resume', async () => {
        game = await startGame(true);                          // its TLS handshake waits for open()
        const a = await enable('', '&tls=1&tlsIgnoreSelfSigned=1');
        a.raw.send(envelope(0n, 'look\r\n'));                  // typed while the handshake is still pending
        await a.raw.control('session.ack');
        a.raw.sock.terminate();                                // the frontend is lost…
        game.open();                                           // …and the handshake completes with nobody attached
        await game.until(() => game.received().includes('look'));   // which the relay can only send once it has
        const resume = { type: 'session.resume', sessionId: a.id, secret: a.secret, output: a.output, inputAcked: '6', inputEnd: '6' };
        for (const attempt of [1, 2]) {
            const b = await onEndpoint(resume);
            await b.sawFrame();                                // the banner, replayed
            expect(b.order.slice(0, 3), `resume ${attempt}`).toEqual(['session.resumed', 'tls.established', 'frame']);
            expect(b.seen.find(c => c.type === 'tls.established')).toMatchObject({ acceptedDespite: ['DEPTH_ZERO_SELF_SIGNED_CERT'] });
        }
        expect(game.connects()).toBe(1);
        expect(game.closed()).toBe(false);
    });

    it('ends on an authenticated end as the first message on the resume endpoint, and only then', async () => {
        game = await startGame();
        const a = await enable();
        a.raw.sock.terminate();
        const end = async (secret: string): Promise<unknown> => {
            const r = await onEndpoint({ type: 'session.end', sessionId: a.id, secret });
            return Promise.race([r.control('session.ended'), r.control('session.unavailable')]).then(m => m.type);
        };
        expect(await end('d3Jvbmc=')).toBe('session.unavailable');
        expect(game.closed()).toBe(false);
        expect(await end(a.secret)).toBe('session.ended');
        await game.until(() => game.closed());
        expect(await end(a.secret)).toBe('session.unavailable');    // a lost reply can be retried
    });

    it('writes each input range once and ends the session on a gap', async () => {
        game = await startGame();
        const a = await enable('PRE\r\n');                    // plain input before opting in is counted too
        expect(a.input).toBe('5');
        a.raw.send(envelope(5n, 'ONE\r\n'));
        a.raw.send(envelope(5n, 'ONE\r\n'));                 // its acknowledgement was lost: resent
        a.raw.send(envelope(5n, 'ONE\r\nTWO\r\n'));          // overlapping prefix with one new command
        const acks = [await a.raw.control('session.ack'), await a.raw.control('session.ack'), await a.raw.control('session.ack')];
        expect(acks.map(m => m.input)).toEqual(['10', '10', '15']);
        expect(game.received()).toBe('PRE\r\nONE\r\nTWO\r\n');

        a.raw.send(envelope(100n, 'GAP\r\n'));
        expect((await a.raw.closed)[0]).toBe(1002);
        await game.until(() => game.closed());
        expect(game.received()).not.toContain('GAP');
    });

    it('ends the session, naming why, when retained output outgrows its budget — dropping nothing', async () => {
        game = await startGame();
        const a = await enable();                             // and never acknowledges anything
        const mib = 'a'.repeat(1024 * 1024);
        for (let sent = 0; sent <= MAX_RETAINED_OUTPUT_BYTES; sent += mib.length) game.write(mib);
        const [code, reason] = await a.raw.closed;
        expect(code).toBe(1011);
        expect(reason).toMatch(/buffer/i);
        expect(await a.raw.control('session.ended')).toMatchObject({ failed: true });   // a limit, not the game quitting
        await game.until(() => game.closed());
    });

    it('frees output as it is acknowledged, so a client that keeps up outlives the retention budget', async () => {
        game = await startGame();
        const a = await enable();
        a.raw.autoAck = true;
        const mib = 'a'.repeat(1024 * 1024);
        let target = BigInt(a.output);
        for (let sent = 0; sent <= MAX_RETAINED_OUTPUT_BYTES + 2 * mib.length; sent += mib.length) {
            game.write(mib);
            target += BigInt(mib.length);
            await a.raw.acked(target);                       // one MiB in flight at a time
        }
        a.raw.send(envelope(0n, 'STILL-HERE\r\n'));
        await game.until(() => game.received().includes('STILL-HERE'));
        expect(game.closed()).toBe(false);
    });

    it('survives garbage on the unauthenticated resume endpoint', async () => {
        game = await startGame();
        const bad = raw(resumeUrl());
        await bad.ready();
        bad.sock.send(Buffer.from([0xc3, 0x28]), { binary: false });   // invalid UTF-8 in a text frame
        await bad.closed;
        expect((await enable()).id).not.toBe('');             // still up and serving
    });

    it('leaves a client that never accepts on the plain proxy: raw bytes both ways, the backend ends with the socket', async () => {
        game = await startGame();
        const r = raw(proxyUrl(resumePort));
        expect((await r.control('session.offer')).versions).toEqual([1]);
        r.sock.send(Buffer.from('BIN\r\n', 'latin1'));
        r.sock.send('TEXT\r\n');                               // a text frame is game input too, as ever
        await game.until(() => game.received() === 'BIN\r\nTEXT\r\n');
        r.sock.close();
        await game.until(() => game.closed());
    });

    it('offers nothing without SESSION_RESUME', async () => {
        game = await startGame();
        const probe = raw(proxyUrl(plainPort));
        await probe.sawFrame();                                // the banner; every control before it has arrived
        expect(probe.seen.map(c => c.type)).toEqual(['game.connected']);
    });

    it('lets the new client play and hang up on a proxy without it, exactly as before', async () => {
        game = await startGame();
        const bus = new EventBus<MudClientEvents>();
        const seen = counts(bus, 'client.detached', 'client.disconnect');
        const client = new MudClient({ url: proxyUrl(plainPort) }, bus);
        client.connect();
        await nextEvent(bus, 'client.established');
        client.send('plain-command');
        await game.until(() => game.received() === 'plain-command\r\n');
        client.disconnect();
        await game.until(() => game.closed());
        expect(seen).toEqual({ 'client.detached': 0, 'client.disconnect': 1 });
    });

    it('stays resumable with a quiet backend, its held command and the relay\'s retained banner intact', async () => {
        game = await startGame();
        network = await startNetwork(resumePort);
        const bus = new EventBus<MudClientEvents>();
        const client = new MudClient({ url: proxyUrl(network.port) }, bus);
        client.connect();
        await nextEvent(bus, 'client.established');
        client.send('HOLD');                               // held past the marker: the game writing it back proves the marker was processed
        await game.until(() => game.received().includes('HOLD'));
        expect(game.received()).toBe('HOLD\r\n');          // and nothing but the banner ever came back: the backend is quiet
        const detached = nextEvent(bus, 'client.detached');
        network.cut();                                     // lost with nothing further to send or receive
        await detached;
        const resumed = nextEvent(bus, 'client.resumed');
        client.resumeTransport();
        await resumed;                                     // the retained session survived the quiet drop
        client.send('BACK');
        await game.until(() => game.received().endsWith('BACK\r\n'));
        expect(game.connects()).toBe(1);                   // the same backend, no relogin
    });

    it('cancels a session the client cancelled in its offered stage, reaching the game as neither JSON nor commands', async () => {
        game = await startGame();
        const a = raw(proxyUrl(resumePort));
        const offer = await a.control('session.offer');
        a.send({ type: 'session.accept', offerId: offer.offerId, version: 1 });
        const marker = await a.control('session.enabled');  // the accept won its race: the relay already took the game over
        expect(game.connects()).toBe(1);
        expect(game.closed()).toBe(false);
        a.send({ type: 'session.cancel', offerId: offer.offerId });
        expect((await a.closed)[0]).toBe(1000);             // said so, and closed once
        await game.until(() => game.closed());              // the offered game goes with the cancellation
        expect(game.received()).toBe('');                   // the cancellation reached the game as neither JSON nor commands
        const refused = await onEndpoint({ type: 'session.resume', sessionId: String(marker.sessionId), secret: String(marker.secret), output: String(marker.output), inputAcked: String(marker.input), inputEnd: String(marker.input) });
        expect((await refused.control('session.unavailable')).type).toBe('session.unavailable');   // cancelled means gone
    });

    it('cancels a session the client cancelled before its accept reached the relay, without a game byte', async () => {
        game = await startGame();
        const a = raw(proxyUrl(resumePort));
        const offer = await a.control('session.offer');     // offered; the accept never went out
        a.send({ type: 'session.cancel', offerId: offer.offerId });
        await game.until(() => game.closed());
        expect(game.received()).toBe('');                   // the cancellation was never game input
        expect((await a.closed)[0]).toBe(1000);
    });

    it('keeps a session it never heard back on since the marker, which a frontend cut then resumes by secret', async () => {
        game = await startGame();
        const a = await enable();                           // the marker is processed here; nothing is ever sent back
        a.raw.sock.terminate();                             // and the frontend is then genuinely cut
        const b = await onEndpoint({ type: 'session.resume', sessionId: a.id, secret: a.secret, output: a.output, inputAcked: a.input, inputEnd: a.input });
        expect(await b.control('session.resumed')).toMatchObject({ backendConnected: true });
        b.send(envelope(0n, 'STILL-HERE\r\n'));
        await game.until(() => game.received().includes('STILL-HERE'));
        expect(game.connects()).toBe(1);                    // the same backend, kept through the loss
        expect(game.closed()).toBe(false);
    });

    it('admits at most SESSION_RESUME_MAX offered connections, serving the rest as the plain proxy', async () => {
        const capped = await startRelay(true, '2');
        servers.push(capped.server);
        const port = capped.port;
        game = await startGame();
        const secondGame = await startGame(); games.push(secondGame);
        const spare: Game = await startGame(); games.push(spare);

        const a = await enable('', '', port);
        const b = await enable('', '', port, secondGame);
        b.raw.sock.terminate();
        await b.raw.closed;                                // detached still owns its reservation
        const legacy = raw(proxyUrl(port, spare));
        await legacy.sawFrame();
        expect(legacy.seen.map(c => c.type)).toEqual(['game.connected']);   // the third is not offered: legacy play, as ever
        legacy.send(Buffer.from('LEGACY\r\n', 'latin1'));
        await spare.until(() => spare.received().includes('LEGACY'));
        expect(spare.connects()).toBe(1);

        // A resumed attachment takes over its session's own slot, not a new one.
        const reattach = await onEndpoint({ type: 'session.resume', sessionId: a.id, secret: a.secret, output: a.output, inputAcked: a.input, inputEnd: a.input }, undefined, resumeUrl(port));
        expect(await reattach.control('session.resumed')).toMatchObject({ backendConnected: true });
        reattach.send(envelope(0n, 'MORE\r\n'));
        await game.until(() => game.received().includes('MORE'));

        const still = raw(proxyUrl(port, spare));
        await still.sawFrame();
        expect(still.seen.map(c => c.type)).toEqual(['game.connected']);    // still at the limit; nobody evicted

        const release = await onEndpoint({ type: 'session.end', sessionId: b.id, secret: b.secret }, undefined, resumeUrl(port));
        expect((await release.closed)[0]).toBe(1000);
        await secondGame.until(() => secondGame.closed());  // the freed session's backend goes with it
        const next = raw(proxyUrl(port, spare));
        expect(await next.control('session.offer')).toBeDefined();          // the freed slot opens the door again
    });

    it('counts an offered connection against the limit until its socket closes, accepted or not', async () => {
        const capped = await startRelay(true, '2');
        servers.push(capped.server);
        const port = capped.port;
        game = await startGame();
        const secondGame = await startGame(); games.push(secondGame);
        const spare: Game = await startGame(); games.push(spare);

        const first = raw(proxyUrl(port, game));               // offered, never accepted: the reservation still counts
        const other = raw(proxyUrl(port, secondGame));
        await first.control('session.offer');
        await other.control('session.offer');
        const legacy = raw(proxyUrl(port, spare));
        await legacy.sawFrame();
        expect(legacy.seen.map(c => c.type)).toEqual(['game.connected']);   // two offers already fill the limit
        legacy.send(Buffer.from('HELD\r\n', 'latin1'));
        await spare.until(() => spare.received().includes('HELD'));

        first.sock.close();                                    // an offered connection ends: its reservation goes with it
        await game.until(() => game.closed());
        const admitted = raw(proxyUrl(port, spare));
        expect(await admitted.control('session.offer')).toBeDefined();      // the freed slot opens the door again
    });

    it('offers a resume only to a configured browser origin; anyone else plays the plain proxy, as ever', async () => {
        const gated = await startRelay(true, undefined, 'https://a.team.test, https://b.team.test');
        servers.push(gated.server);
        const port = gated.port;
        game = await startGame();

        const member = raw(proxyUrl(port), 'https://a.team.test');
        const offer = await member.control('session.offer');
        member.send({ type: 'session.accept', offerId: offer.offerId, version: 1 });
        await member.control('session.enabled');           // the same offer/accept/marker flow the hosted client gets

        const stranger = raw(proxyUrl(port), 'https://elsewhere.test');   // a page the operator never allowed
        const headerless = raw(proxyUrl(port), null);      // a CLI client with no Origin at all
        await stranger.sawFrame();
        await headerless.sawFrame();
        expect([...stranger.seen, ...headerless.seen].map(c => c.type)).toEqual(['game.connected', 'game.connected']);   // no offer; ordinary legacy play
        headerless.send(Buffer.from('LEGACY\r\n', 'latin1'));
        await game.until(() => game.received().includes('LEGACY'));
    });

    it('cannot exhaust the retention slots through unconfigured origins', async () => {
        const gated = await startRelay(true, '2', 'https://a.team.test');
        servers.push(gated.server);
        const port = gated.port;
        game = await startGame();

        const held = raw(proxyUrl(port), 'https://a.team.test');
        const offer = await held.control('session.offer'); // one legitimate reservation
        held.send({ type: 'session.accept', offerId: offer.offerId, version: 1 });
        await held.control('session.enabled');

        for (const origin of ['https://elsewhere.test', null, 'https://elsewhere2.test']) {   // bounded, not a benchmark
            const intruder = raw(proxyUrl(port), origin);
            await intruder.sawFrame();
            expect(intruder.seen.map(c => c.type)).toEqual(['game.connected']);   // no offer, no reservation, plain play
            intruder.sock.close();
            await game.until(() => game.closed());         // and its backend goes with it, as plain play always did
        }

        const second = raw(proxyUrl(port), 'https://a.team.test');
        expect(await second.control('session.offer')).toBeDefined();   // the other slot remains free for a real page
    });

    it('reads SESSION_RESUME_ORIGINS at load: default hosted origin, exact trimmed entries, empty meaning none', async () => {
        vi.resetModules();
        delete process.env.SESSION_RESUME_ORIGINS;
        expect([...(await import('../../proxy/sessions')).RESUME_ORIGINS]).toEqual(['https://web.mudlet.org']);
        vi.resetModules();
        process.env.SESSION_RESUME_ORIGINS = ' https://a.test , https://b.test ,';
        expect([...(await import('../../proxy/sessions')).RESUME_ORIGINS]).toEqual(['https://a.test', 'https://b.test']);
        vi.resetModules();
        process.env.SESSION_RESUME_ORIGINS = '';
        expect((await import('../../proxy/sessions')).RESUME_ORIGINS.size).toBe(0);
        delete process.env.SESSION_RESUME_ORIGINS;
    });

    it('reads SESSION_RESUME_MAX at load, falling back to the default on anything else', async () => {
        vi.resetModules();
        delete process.env.SESSION_RESUME;
        process.env.SESSION_RESUME_MAX = '7';
        expect((await import('../../proxy/sessions')).MAX_RESUMABLE_SESSIONS).toBe(7);
        for (const broken of ['0', '-3', 'many']) {
            vi.resetModules();
            process.env.SESSION_RESUME_MAX = broken;
            expect((await import('../../proxy/sessions')).MAX_RESUMABLE_SESSIONS).toBe(32);
        }
        delete process.env.SESSION_RESUME_MAX;
        vi.resetModules();
        expect((await import('../../proxy/sessions')).MAX_RESUMABLE_SESSIONS).toBe(32);
    });
});
