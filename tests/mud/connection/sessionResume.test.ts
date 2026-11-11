import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MudClient } from '../../../src/mud/connection/MudClient';
import { MudSession } from '../../../src/mud/MudSession';
import { EventBus } from '../../../src/core/EventBus';
import type { MudClientEvents } from '../../../src/mud/events';
import { ECHO_WILL, ECHO_WONT, SGA_WILL, TELNET_GA } from '../../../src/mud/protocol/constants';

import {
    BrowserMockWebSocket, OFFER, PROXY, marker, sameSession, visibility, visit,
} from '../../support/resumableSocket';

describe('session resumption (client)', () => {
    let client: MudClient;
    let events: string[];
    let errors: string[];
    let warnings: string[];
    let shown: string;
    let ws: BrowserMockWebSocket;

    beforeEach(() => {
        vi.stubGlobal('WebSocket', BrowserMockWebSocket);
        BrowserMockWebSocket.all = [];
        visibility('hidden');                  // so a loss does not start an automatic attempt by itself
        const bus = new EventBus<MudClientEvents>();
        events = [];
        errors = [];
        warnings = [];
        shown = '';
        for (const name of ['client.connect', 'client.established', 'client.disconnect', 'client.detached', 'client.resumed', 'charmode.detected'] as const) {
            bus.on(name, () => events.push(name));
        }
        bus.on('client.error', m => errors.push(m));
        bus.on('client.warning', m => warnings.push(m));
        bus.on('flushLines', groups => { shown += groups.map(g => g.text).join(''); });
        client = new MudClient({ url: PROXY }, bus);
        client.connect();
        ws = BrowserMockWebSocket.all[0];
        ws.onopen?.({});
        ws.text({ type: 'game.connected' });
        events.length = 0;
    });

    afterEach(() => {
        client.disconnect();
        vi.unstubAllGlobals();
        visibility('visible');
    });

    /** The offer accepted and the marker received: the session is retained. */
    const enable = (input = 0n, output = 0n): void => { ws.text(OFFER); ws.text(marker(input, output)); };

    it('is the plain socket without an offer: raw bytes both ways, and an ordinary close ends it', () => {
        client.send('look');
        ws.raw('hello\n');
        expect(ws.sentText()).toEqual(['look\r\n']);
        expect(ws.controls()).toEqual([]);
        expect(shown).toBe('hello\n');
        ws.drop();
        expect(events).toEqual(['client.disconnect']);
    });

    it('leaves session-looking messages alone until an offer is taken, so a direct game socket is untouched', () => {
        ws.text({ type: 'session.ended' });
        ws.text({ type: 'session.enabled', sessionId: 'x', secret: 'y', resumePath: 'resume', input: '0', output: '0' });
        ws.raw('still here\n');
        client.send('look');
        expect(shown).toBe('still here\n');
        expect(ws.sentText()).toEqual(['look\r\n']);
        expect(ws.controls()).toEqual([]);
    });

    it('accepts an offer, holds sends until the marker, then numbers them from the marker cursors', () => {
        ws.text(OFFER);
        expect(ws.controls()).toEqual([{ type: 'session.accept', offerId: 'offer-1', version: 1 }]);
        client.send('held');
        ws.raw('banner');                                  // raw output counts toward the marker
        expect(ws.sentText()).toEqual([]);
        ws.text(marker(0n, 6n));
        expect(ws.envelopes()).toEqual([{ offset: 0n, text: 'held\r\n' }]);
        client.send('next');
        expect(ws.envelopes()[1]).toEqual({ offset: 6n, text: 'next\r\n' });
    });

    it('ends the session, saying so, when the marker does not describe this stream', () => {
        ws.text(OFFER);
        ws.raw('banner');
        ws.text(marker(0n, 999n));
        expect(errors).toHaveLength(1);
        expect(ws.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
        expect(events).toEqual(['client.disconnect']);
    });

    it('hands each sequenced range to the parser once: duplicates dropped, overlap trimmed, a gap fatal', () => {
        enable();
        ws.frame(0n, 'one\n');
        ws.frame(0n, 'one\n');                             // its acknowledgement was lost: resent
        ws.frame(3n, 'Xmore\n');                           // overlaps by one byte
        ws.frame(0n, 'one\n');                             // long stale: must not move the cursor back
        ws.frame(9n, 'next\n');
        expect(shown).toBe('one\nmore\nnext\n');
        expect(ws.controls().filter(c => c.type === 'session.ack').map(c => c.output)).toEqual(['4', '4', '9', '9', '14']);
        ws.frame(100n, 'gap\n');
        expect(errors).toHaveLength(1);
        expect(events).toEqual(['client.disconnect']);
        expect(shown).toBe('one\nmore\nnext\n');
    });

    /** An enabled session with `peek` sent but never acknowledged, 7 output bytes
     *  received, and the transport then lost. */
    const lose = (): void => {
        enable();
        client.send('look');                               // offset 0
        client.send('peek');                               // offset 6
        ws.text({ type: 'session.ack', input: '6' });
        ws.frame(0n, 'banner\n');
        ws.drop();
    };
    const resume = (): BrowserMockWebSocket => {
        expect(client.resumeTransport()).toBe(true);
        const dial = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        dial.onopen?.({});
        return dial;
    };

    it('detaches rather than disconnects when the transport is lost, keeping a script\'s send for later', () => {
        lose();
        expect(events).toEqual(['client.detached']);       // nothing that logs in or reconnects runs
        expect(client.transportDetached()).toBe(true);
        client.send('offline');
        expect(BrowserMockWebSocket.all).toHaveLength(1);
        expect(ws.envelopes().map(e => e.text)).toEqual(['look\r\n', 'peek\r\n']);   // nothing more went out
    });

    it('resumes at the endpoint derived from the proxy URL it dialled, naming its cursors', () => {
        lose();
        const dial = resume();
        expect(dial.url).toBe('wss://relay.test/relay/resume');
        expect(dial.controls()).toMatchObject([{ type: 'session.resume', ...sameSession, output: '7', inputAcked: '6', inputEnd: '12' }]);
    });

    it('resends only the original unacknowledged range, then waits for the stream to catch up before anything new', () => {
        lose();
        client.send('offline');
        const dial = resume();
        // The relay holds 6 more output bytes than we have and accepted our input up to 6.
        dial.text({ type: 'session.resumed', input: '6', catchupEnd: '13', backendConnected: true });
        expect(dial.envelopes()).toEqual([{ offset: 6n, text: 'peek\r\n' }]);
        dial.frame(7n, 'later\n');
        expect(dial.controls().at(-1)).toEqual({ type: 'session.ack', output: '13' });   // owned and acknowledged at once…
        expect(events).toEqual(['client.detached']);       // …but output is caught up and input not yet reconciled:
        expect(shown).toBe('banner\n');                    // so still nothing new is parsed, and nothing new sent
        expect(dial.envelopes()).toHaveLength(1);
        dial.text({ type: 'session.ack', input: '12' });
        expect(events).toEqual(['client.detached', 'client.resumed']);   // and no connect, no established
        expect(shown).toBe('banner\nlater\n');
        expect(dial.envelopes()[1]).toEqual({ offset: 12n, text: 'offline\r\n' });
        expect(client.transportDetached()).toBe(false);
    });

    it('detaches again on a second loss, and the superseded socket can no longer speak for the session', () => {
        lose();
        const dial = resume();
        dial.text({ type: 'session.resumed', input: '12', catchupEnd: '7', backendConnected: true });
        expect(events.at(-1)).toBe('client.resumed');
        ws.frame(7n, 'stale\n');                           // the old socket, late
        ws.drop();
        expect(events.at(-1)).toBe('client.resumed');
        expect(shown).toBe('banner\n');
        dial.drop();
        expect(events.at(-1)).toBe('client.detached');
        expect(resume().url).toBe('wss://relay.test/relay/resume');
    });

    // The 3 s window a submitted command opens runs on a timer, which a lost transport does not stop.
    it.each([
        ['is still on', 'more\n', 1],
        ['was released in what was queued', ECHO_WONT, 0],
    ])('holds a character-mode verdict that falls due while away until the resume has caught up, as it holds all parsing (ECHO %s)', (_, tail, detections) => {
        vi.useFakeTimers();
        try {
            enable();
            ws.frame(0n, SGA_WILL + ECHO_WILL);            // ECHO and SGA on, 6 bytes
            client.send('look');                           // arms the window
            ws.drop();
            client.resumeTransport();
            const dial = BrowserMockWebSocket.all[1];
            dial.onopen?.({});
            const queued = 'queued\n';
            dial.text({ type: 'session.resumed', input: String(dial.controls()[0].inputEnd), catchupEnd: String(6 + queued.length + tail.length), backendConnected: true });
            dial.frame(6n, queued);                        // received while catching up, so queued, not parsed
            vi.advanceTimersByTime(3_000);                 // the window runs out away
            expect(shown).toBe('');
            expect(events).not.toContain('charmode.detected');
            dial.frame(BigInt(6 + queued.length), tail);   // caught up: resumed
            expect(shown).toContain('queued');
            expect(events.filter(e => e === 'charmode.detected')).toHaveLength(detections);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not carry a deferred character-mode verdict into a new game connection', () => {
        vi.useFakeTimers();
        try {
            enable();
            ws.frame(0n, SGA_WILL + ECHO_WILL);
            client.send('look');
            ws.drop();
            vi.advanceTimersByTime(3_000);
            client.disconnect();
            client.connect();                              // a fresh game, not transport resumption
            const fresh = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
            fresh.onopen?.({});
            fresh.text(OFFER);
            fresh.text(marker(0n, 0n));
            fresh.frame(0n, SGA_WILL + ECHO_WILL);
            client.send('look');                          // the new game's own window has just started
            fresh.drop();
            client.resumeTransport();
            const dial = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
            dial.onopen?.({});
            dial.text({ type: 'session.resumed', input: dial.controls()[0].inputEnd, catchupEnd: '6', backendConnected: true });
            expect(events).not.toContain('charmode.detected');
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a socket replaced by a later connect() report nothing about the one that replaced it', () => {
        enable();
        client.connect();
        ws.drop();                                         // the replaced socket's transport dies, late
        expect(events).toEqual([]);
        expect(client.transportDetached()).toBe(false);
        visit();                                           // its own retry finds the session gone, and stops
        const retry = BrowserMockWebSocket.all[2];
        retry.onopen?.({});
        retry.text({ type: 'session.unavailable' });
        expect(events).toEqual([]);
    });

    it('ends the session, saying why, rather than dropping input it cannot hold while away', () => {
        lose();
        client.send('x'.repeat(1024 * 1024));              // past the bound on what may wait for the game
        expect(errors.join()).toMatch(/Too much input/);
        expect(events).toEqual(['client.detached', 'client.disconnect']);
        const end = BrowserMockWebSocket.all[1];                  // and the relay is still asked to end it
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        end.text({ type: 'session.ended' });
    });

    it('ordinary close semantics return when the relay says the session is over', () => {
        enable();
        ws.text({ type: 'session.ended' });
        ws.closeWith(1000, 'TCP connection closed');
        expect(events).toEqual(['client.disconnect']);
        expect(errors).toEqual([]);                        // a normal end reads as it always did
        expect(client.resumeTransport()).toBe(false);
    });

    it('reports a refused resume as the loss it is, and never dials a fresh game', () => {
        enable();
        ws.drop();
        client.resumeTransport();
        const dial = BrowserMockWebSocket.all[1];
        dial.onopen?.({});
        dial.text({ type: 'session.unavailable', reason: 'unavailable' });
        expect(errors.join()).toMatch(/could not be resumed/);
        expect(events).toEqual(['client.detached', 'client.disconnect']);
        expect(client.resumeTransport()).toBe(false);
        expect(BrowserMockWebSocket.all).toHaveLength(2);
    });

    it('ends the retained session on an explicit disconnect from the live socket, closing it on the relay\'s answer', () => {
        enable();
        client.disconnect();
        expect(ws.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
        expect(ws.readyState).toBe(BrowserMockWebSocket.OPEN);    // a socket already closing would drop the answer
        ws.text({ type: 'session.ended' });
        expect(ws.readyState).toBe(BrowserMockWebSocket.CLOSED);
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(1);         // confirmed: nothing more to try
    });

    it('keeps an end its live socket never answered pending, and retries it as an end — never a resume — on the next visit', () => {
        enable();
        client.send('queued');                             // sent, not yet acknowledged: it must not be sent again
        client.disconnect();                               // the end goes into a socket that may be half-open
        expect(ws.controls().at(-1)).toMatchObject({ type: 'session.end', ...sameSession });
        expect(warnings).toEqual([]);                      // nothing is claimed until it actually fails
        ws.drop();                                         // the browser gives up on it, with no answer
        expect(warnings.join()).toMatch(/to end the game session, so the character may still be logged in/);
        expect(events).toEqual(['client.disconnect']);     // the disconnect's own close, and no second one
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        const retry = BrowserMockWebSocket.all[1];
        retry.onopen?.({});
        expect(retry.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        expect(retry.envelopes()).toEqual([]);             // no input flushed
        retry.text({ type: 'session.ended' });
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(2);         // confirmed: no further attempt
        expect(BrowserMockWebSocket.all.flatMap(s => s.controls()).some(c => c.type === 'session.resume')).toBe(false);
    });

    it('ends it through the resume endpoint when away — unconfirmed until answered, flushing nothing, never resuming', () => {
        enable();
        ws.drop();
        client.send('queued while away');
        client.disconnect();
        expect(events).toEqual(['client.detached', 'client.disconnect']);
        const end = BrowserMockWebSocket.all[1];
        expect(end.url).toBe('wss://relay.test/relay/resume');
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
        expect(end.envelopes()).toEqual([]);
        expect(warnings).toEqual([]);                      // nothing is claimed until the attempt actually fails
        end.drop();                                        // no reply: said so, and retried on the next foreground visit
        expect(warnings.join()).toMatch(/to end the game session, so the character may still be logged in/);
        visit();
        const retry = BrowserMockWebSocket.all[2];
        retry.onopen?.({});
        retry.text({ type: 'session.ended' });
        visit();
        expect(BrowserMockWebSocket.all).toHaveLength(3);         // confirmed: nothing more
        expect(BrowserMockWebSocket.all.flatMap(s => s.controls()).some(c => c.type === 'session.resume')).toBe(false);
    });

    it('makes one automatic attempt per foreground visit, and none in the background', () => {
        enable();
        visibility('visible');
        ws.drop();                                         // visible: one attempt now
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        expect(client.resumeTransport()).toBe(true);       // coalesces with the one in flight
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        BrowserMockWebSocket.all[1].drop();                       // failed without a verdict: no retry loop, but it is said
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        expect(warnings.join()).toMatch(/to resume the game session/);
        visibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(BrowserMockWebSocket.all).toHaveLength(2);
        visibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(BrowserMockWebSocket.all).toHaveLength(3);         // the next foreground visit gets exactly one more
        BrowserMockWebSocket.all[2].onopen?.({});
        BrowserMockWebSocket.all[2].text({ type: 'session.resumed', input: '0', catchupEnd: '0', backendConnected: true });
        expect(events.at(-1)).toBe('client.resumed');
    });

    it('cancels the offer it accepted when the user hangs up while the marker is still pending: no flush, no failure', () => {
        ws.text(OFFER);                                    // the accept is on its way to the relay
        client.send('held');                               // queued while the session is still being named
        client.disconnect();                               // the user hangs up in that window
        expect(ws.controls()).toEqual([
            { type: 'session.accept', offerId: 'offer-1', version: 1 },
            { type: 'session.cancel', offerId: 'offer-1' },  // an explicit stop, on the socket the offer went to
        ]);
        expect(events).toEqual(['client.disconnect']);     // one logical disconnect, no failure on top of it
        expect(errors).toEqual([]);
        expect(warnings).toEqual([]);                      // nothing is claimed about an end that never needed sending
        expect(client.resumeTransport()).toBe(false);
        client.send('after');                              // nothing further is sent anywhere
        expect(ws.envelopes()).toEqual([]);                // the held command is never flushed
        ws.text(marker(0n, 0n));                           // the relay's marker still lands afterwards…
        expect(ws.controls()).toHaveLength(2);             // …and names nothing this socket will act on
        client.disconnect();                               // a duplicate close is nothing new
        expect(events).toEqual(['client.disconnect']);
    });

    it('takes a transport lost before the marker as an ordinary end, without failure or resumption', () => {
        ws.text(OFFER);                                    // accept out, marker not yet in
        ws.drop();
        expect(events).toEqual(['client.disconnect']);
        expect(errors.join()).toMatch(/Connection lost/);  // the ordinary report a plain socket's loss gets
        expect(warnings).toEqual([]);                      // nothing about resumes or ends that never were
        expect(client.resumeTransport()).toBe(false);
        expect(client.transportDetached()).toBe(false);
    });

    it('starts clean on an ordinary connect after a plain close', () => {
        ws.drop();
        client.connect();
        const next = BrowserMockWebSocket.all[1];
        next.onopen?.({});
        next.raw('again\n');
        expect(shown).toBe('again\n');
    });

    describe('latency timing across a lost transport', () => {
        let now = 0;
        beforeEach(() => {
            now = 1000;
            vi.spyOn(performance, 'now').mockImplementation(() => now);
        });
        afterEach(() => {
            vi.restoreAllMocks();
        });

        /** A fresh client whose clock is the test's, on a retained session:
         *  commands are only timed on a server whose prompts are marked, so
         *  the GA latches first, and the session is taken over so a loss is a
         *  detach rather than a plain disconnect. */
        const timed = () => {
            BrowserMockWebSocket.all = [];                        // a fresh registry: this test's own client
            const bus = new EventBus<MudClientEvents>();
            const readings: number[] = [];
            bus.on('network.latency', (ms) => readings.push(ms));
            const c = new MudClient({ url: PROXY }, bus);
            c.connect();
            const sock = BrowserMockWebSocket.all[0];
            sock.onopen?.({});
            sock.text({ type: 'game.connected' });
            sock.text(OFFER);                              // taken over: the relay now holds the game through losses
            sock.text(marker(0n, 0n));
            sock.frame(0n, '> ' + TELNET_GA);              // framed, as a live socket's bytes are; the timer arms only once the server marks its prompts
            return { c, sock, readings };
        };

        /** The reattached socket after a resume of the retained session. */
        const resume = (c: MudClient, input: string, catchupEnd: string): BrowserMockWebSocket => {
            c.resumeTransport();
            const dial = BrowserMockWebSocket.all[1];
            dial.onopen?.({});
            dial.text({ type: 'session.resumed', input, catchupEnd, backendConnected: false });
            return dial;
        };

        it('does not measure across a lost transport: an outstanding clock stops, and its replay is not a fresh reply', () => {
            const { c, sock, readings } = timed();
            c.send('look');                                // armed; its bytes are on their way
            now += 300;
            sock.drop();                                   // lost: the command, the outage and the replay never become a reading
            now += 60_000;
            c.send('held');                                // a command typed while away
            c.resumeTransport();

            c.resumeTransport();
            const dial = resume(c, '6', '3');                 // the relay had accepted the input; nothing was held back

            expect(readings).toEqual([]);                  // the outstanding measurement was retired: the outage is nobody's reply latency
            c.send('again');                               // a fresh command, measured the ordinary way
            now += 100;
            dial.frame(3n, 'Welcome\r\n> ' + TELNET_GA);
            expect(readings).toEqual([100]);               // and a small fresh round trip
        });

        it('starts the clock for a command queued while away only when its bytes ride again', () => {
            const { c, sock, readings } = timed();
            sock.drop();                                   // away before anything is timed
            c.send('sweep');                               // held for the resume: not armed now
            now += 60_000;

            c.resumeTransport();
            const dial = resume(c, '0', '3');                 // the held command goes out as the transport settles
            now += 150;
            dial.frame(3n, 'Room\r\n> ' + TELNET_GA);
            expect(readings).toEqual([150]);               // measured from the settled submit, never across the outage
        });

        it('does not let the catch-up backlog finish a fresh measurement with its old timestamps', () => {
            const { c, sock, readings } = timed();
            c.send('look');                                // armed; no reply ever came before the loss
            now += 300;
            sock.drop();
            now += 60_000;                                 // meanwhile the game's output piles up at the relay
            c.send('queued');                              // a command typed while away: held for the resume, its clock waits

            c.resumeTransport();
            const dial = resume(c, '6', '12');
            dial.frame(3n, 'backlog1\n');                        // the replay arrives before the transport has settled: old-timestamped queue
            dial.text({ type: 'session.ack', input: '6' });      // settles the transport (the catch-up end is here): the fresh clock starts at this tick

            expect(readings).toEqual([]);                  // the backlog is not the reply to the fresh clock
            now += 150;
            dial.frame(12n, 'Room\r\n> ' + TELNET_GA);
            expect(readings).toEqual([150]);
        });

        it('leaves nothing timed when no command was awaiting: the resume just clears', () => {
            const { c, sock, readings } = timed();
            sock.drop();
            now += 60_000;
            c.resumeTransport();
            const dial = resume(c, '0', '3');
            now += 500;
            dial.frame(3n, 'Idle line\r\n> ' + TELNET_GA);
            expect(readings).toEqual([]);                  // no command was timed, so no reading
        });
    });
});

describe('session resumption (MudSession)', () => {
    let session: MudSession;

    beforeEach(() => {
        vi.stubGlobal('WebSocket', BrowserMockWebSocket);
        BrowserMockWebSocket.all = [];
        visibility('hidden');
        session = new MudSession();
    });
    afterEach(() => {
        session.destroy();
        vi.unstubAllGlobals();
        visibility('visible');
    });

    /** By default the offer arrives before the proxy has reached the game. */
    const connectRetained = (url = PROXY, gameConnected = false): BrowserMockWebSocket => {
        session.connect(url);
        const ws = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        ws.onopen?.({});
        if (gameConnected) ws.text({ type: 'game.connected' });
        ws.text(OFFER);
        ws.text(marker());
        return ws;
    };
    const resume = (url = PROXY, backendConnected = true): BrowserMockWebSocket => {
        session.connect(url);                               // the same Connect button, now a resume
        const dial = BrowserMockWebSocket.all[BrowserMockWebSocket.all.length - 1];
        dial.onopen?.({});
        dial.text({ type: 'session.resumed', input: '0', catchupEnd: '0', backendConnected });
        return dial;
    };

    it('resumes on Connect instead of dialling, and never reports connected while away', () => {
        const ws = connectRetained(PROXY, true);
        expect(session.status).toBe('connected');
        ws.drop();
        expect(session.status).toBe('connecting');         // never 'connected' while away, and Disconnect stays available
        expect(session.transportDetached()).toBe(true);    // so a typed line stays a draft

        resume();
        expect(session.dialCount).toBe(1);
        expect(session.status).toBe('connected');
        expect(session.transportDetached()).toBe(false);
        expect(BrowserMockWebSocket.all).toHaveLength(2);
    });

    it('stays connecting and re-asserts it after a resume until the game itself has connected', () => {
        const ws = connectRetained();
        ws.drop();
        const heard: string[] = [];
        session.events.on('status', (status) => heard.push(status));
        const dial = resume(PROXY, false);
        expect(session.status).toBe('connecting');         // nothing has reached the game
        expect(heard).toEqual(['connecting']);             // the resume said so itself, for every listener
        dial.text({ type: 'game.connected' });
        expect(session.status).toBe('connected');
    });

    it('keeps a custom proxy\'s query on the resume and end dials, dropping only the game\'s dial parameters', () => {
        const authed = 'wss://relay.test/auth?token=abc.123&keep=1&keep=2&host=game.test&port=23'
            + '&tls=1&tlsIgnoreExpired=1&tlsIgnoreSelfSigned=1&tlsIgnoreAll=1';
        const endpoint = 'wss://relay.test/auth/resume?token=abc.123&keep=1&keep=2';
        const ws = connectRetained(authed);
        ws.drop();
        const dial = resume(authed);
        expect(dial.url).toBe(endpoint);                   // the auth query rode along; the game's own parameters did not
        dial.drop();
        session.connect('wss://relay.test/auth?token=abc.123&keep=1&keep=2&host=elsewhere.test&port=4000');
        const end = BrowserMockWebSocket.all[2];                  // a different target: the retained session ends, not resumes
        expect(end.url).toBe(endpoint);                    // and the offline end keeps the credential, never the game's parameters
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
    });

    it('learns a TLS handshake it missed while away when it resumes, and says it once however often it resumes', () => {
        const secure = `${PROXY}&tls=1`;
        const established: unknown[] = [];
        session.events.on('tls.established', info => established.push(info));
        const ws = connectRetained(secure);
        ws.drop();                                         // the page loses it before the handshake is done
        expect(session.gameTransportSecure).toBe(false);
        const dial = resume(secure);
        dial.text({ type: 'tls.established', protocol: 'TLSv1.3', acceptedDespite: [] });       // told again, as the relay does on every resume
        expect(session.gameTransportSecure).toBe(true);
        expect(established).toHaveLength(1);
        dial.drop();
        const again = resume(secure);
        again.text({ type: 'tls.established', protocol: 'TLSv1.3', acceptedDespite: [] });
        expect(session.gameTransportSecure).toBe(true);
        expect(established).toHaveLength(1);               // told twice, said once
    });

    it('dials a different target afresh, ending the retained session rather than resuming it', () => {
        const ws = connectRetained(PROXY, true);
        ws.drop();

        const other = 'wss://relay.test/relay?host=other.test&port=23';
        session.connect(other);
        expect(session.dialCount).toBe(2);
        expect(BrowserMockWebSocket.all.map(s => s.url)).toEqual([PROXY, 'wss://relay.test/relay/resume', other]);
        const end = BrowserMockWebSocket.all[1];
        end.onopen?.({});
        expect(end.controls()).toMatchObject([{ type: 'session.end', ...sameSession }]);
    });
});
