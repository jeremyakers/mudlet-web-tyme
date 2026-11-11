import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMudSession } from '../../src/hooks/useMudSession';
import { Toolbar } from '../../src/ui/Toolbar';

// A resume that lands before the game has connected leaves the session attached
// but not established, and the status does not change value (it stays
// `connecting`). The toolbar's "game session retained" label is keyed to the
// transport's detached state, which must reach React through its own state — a
// same-value status update would (correctly) bail out of the re-render and
// leave a stale retained claim, inviting a Connect that dials a new backend.

type Control = Record<string, unknown>;

/** A browser WebSocket stand-in for the transport the hook's session dials,
 *  shaped like the one in tests/mud/connection/sessionResume.test.ts. */
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static all: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    binaryType = '';
    bufferedAmount = 0;
    protocol = '';
    sent: (Uint8Array | string)[] = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public url: string) { MockWebSocket.all.push(this); }
    send(data: Uint8Array | string): void { this.sent.push(data); }
    close(): void { this.readyState = MockWebSocket.CLOSED; }
    text(msg: Control): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
    /** The transport dies with no close frame — the phone losing its network. */
    drop(): void { this.readyState = MockWebSocket.CLOSED; this.onclose?.({ code: 1006, reason: '', wasClean: false }); }
}

const OFFER = { type: 'session.offer', versions: [1], offerId: 'offer-1' };
const marker = (input = 0n, output = 0n): Control => ({
    type: 'session.enabled', sessionId: 'session-1', secret: 'c2VjcmV0', resumePath: 'resume',
    input: String(input), output: String(output),
});
/** What `connectionUrl` actually builds: no slash before the query. */
const PROXY = 'wss://relay.test/relay?host=game.test&port=23';

const visibility = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

describe('the toolbar\'s retained-session label follows the real transport state', () => {
    let root: Root;
    let host: HTMLElement;
    let connectUrl: ((url: string) => void) | null = null;

    const Probe = (): ReturnType<typeof createElement> => {
        const { status, transportDetached, connect } = useMudSession();
        connectUrl = connect;
        return createElement(Toolbar, {
            connectionName: 'QA',
            status,
            transportDetached,
            ping: null,
            onDisconnect: () => {}, onReconnect: () => {}, onNewConnection: () => {},
            onOpenMap: () => {}, onOpenScripts: () => {}, onOpenFiles: () => {},
            onOpenNotepad: () => {}, onOpenLogs: () => {}, onOpenDocs: () => {},
            onOpenHelp: () => {}, onOpenSettings: () => {}, onOpenAbout: () => {},
            onFocusInputLine: () => {},
            replayRecording: false, onToggleReplayRecording: () => {},
            replaySpeed: null, onReplaySpeedChange: () => {}, onReplayStop: () => {},
        });
    };

    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('WebSocket', MockWebSocket);
        MockWebSocket.all = [];
        visibility('hidden');                  // so a loss does not start an automatic attempt by itself
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(() => {
        act(() => { root.unmount(); });        // destroys the hook's session
        host.remove();
        vi.unstubAllGlobals();
        visibility('visible');
        connectUrl = null;
    });

    /** The status block's dot, as the toolbar labels the current state. */
    const dot = (): HTMLElement | null => host.querySelector('.status-dot');
    const dotLabel = (): string => dot()?.getAttribute('aria-label') ?? '';
    const dotStatus = (): string => dot()?.className ?? '';

    it('retains the label only while the transport is away, clears it when a resume lands, and stays connecting until the game is reached', () => {
        act(() => { root.render(createElement(Probe)); });
        expect(dotLabel()).toBe('disconnected');
        act(() => { connectUrl?.(PROXY); });
        const ws = MockWebSocket.all[0];
        act(() => { ws.onopen?.({}); ws.text(OFFER); ws.text(marker()); });   // the offer precedes any game.connected
        act(() => { ws.drop(); });                                            // the relay still holds the session
        expect(dotLabel()).toMatch(/game session retained/);
        expect(dotStatus()).toContain('status-connecting');
        // Repeated manual Connect while away resumes the one backend — no new dial, however often it is pressed.
        act(() => { connectUrl?.(PROXY); connectUrl?.(PROXY); });
        expect(MockWebSocket.all).toHaveLength(2);
        const dial = MockWebSocket.all[1];
        act(() => { dial.onopen?.({}); dial.text({ type: 'session.resumed', input: '0', catchupEnd: '0', backendConnected: false }); });
        expect(dotLabel()).toBe('connecting');          // the retained label is gone, and nothing claims connected
        expect(dotStatus()).toContain('status-connecting');
        expect(MockWebSocket.all).toHaveLength(2);      // still nothing dials a second backend
        act(() => { dial.text({ type: 'game.connected' }); });
        expect(dotLabel()).toBe('connected');
        expect(dotStatus()).toContain('status-connected');
        expect(MockWebSocket.all).toHaveLength(2);
    });
});
