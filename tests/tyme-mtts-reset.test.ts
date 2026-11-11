import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MudClient } from '../src/mud/connection/MudClient';
import { EventBus } from '../src/core/EventBus';
import {
    TTYPE_DO, TTYPE_WILL, OPT_TTYPE, TTYPE_SEND, TTYPE_IS,
} from '../src/mud/protocol/constants';
import type { MudClientEvents } from '../src/mud/events';

// IAC DONT TTYPE: the withdrawal the MTTS standard pairs with a cycle reset.
const TTYPE_DONT = '\xFF\xFE\x18';

/** Minimal stand-in for the browser WebSocket, capturing outbound frames. */
class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readyState = MockWebSocket.OPEN;
    binaryType = '';
    sent: Uint8Array[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send(bytes: Uint8Array) { this.sent.push(bytes); }
    close() { this.readyState = MockWebSocket.CLOSED; }

    deliver(byteString: string) {
        const buf = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) buf[i] = byteString.charCodeAt(i) & 0xff;
        this.onmessage?.({ data: buf.buffer });
    }
}

function sentText(sock: MockWebSocket): string {
    return sock.sent.map(b => String.fromCharCode(...b)).join('');
}

/** The MTTS standard: a server that withdraws TERMINAL-TYPE with
 *  `IAC DONT TTYPE` ends the cycle, and the client must answer its next
 *  `SEND` from the top of the list again. A real exec copyover re-runs the
 *  server init (DONT/DO TTYPE) mid-cycle; a negotiator that keeps its cycle
 *  position then identifies itself with the MTTS bitvector instead of its
 *  client name. */
describe('Tyme MTTS identity — DONT TTYPE resets the SEND cycle', () => {
    const sendReq = '\xFF\xFA' + OPT_TTYPE + TTYPE_SEND + '\xFF\xF0';
    let realWebSocket: unknown;

    beforeEach(() => {
        realWebSocket = (globalThis as Record<string, unknown>).WebSocket;
        (globalThis as Record<string, unknown>).WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
    });
    afterEach(() => {
        (globalThis as Record<string, unknown>).WebSocket = realWebSocket;
    });

    function connected() {
        const bus = new EventBus<MudClientEvents>();
        const client = new MudClient({ url: 'ws://test.invalid' }, bus);
        client.connect();
        const sock = MockWebSocket.instances[0];
        sock.onopen?.({});
        sock.sent = [];
        return sock;
    }

    it('walks name/terminal/MTTS, then answers a DONT/DO re-init with the name', () => {
        const sock = connected();
        sock.deliver(TTYPE_DO);
        expect(sentText(sock)).toContain(TTYPE_WILL);

        // The pre-copyover exchange parks the cycle past the name step.
        sock.deliver(sendReq);
        expect(sentText(sock)).toContain(TTYPE_IS + 'MUDLET-WEB');
        sock.deliver(sendReq);
        expect(sentText(sock)).toContain(TTYPE_IS + 'ANSI-TRUECOLOR');
        sock.deliver(sendReq);
        expect(sentText(sock)).toMatch(/MTTS \d+/);

        // Copyover init: TTYPE is withdrawn, re-offered, and asked again.
        sock.deliver(TTYPE_DONT);
        sock.deliver(TTYPE_DO);
        expect(sentText(sock)).toContain(TTYPE_WILL);
        sock.sent = []; // judge only the answers the re-init itself drew
        sock.deliver(sendReq);
        const reinit = sentText(sock);
        expect(reinit).toContain(TTYPE_IS + 'MUDLET-WEB');
        expect(reinit).not.toContain('MTTS ');
    });
});
