import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { brandConnectionData, matchBrandProfile } from '../src/branding';
import { useAppStore } from '../src/storage';
import { tymeBrandFromSearch } from '../src/tyme-brand';
import { AccountError, AccountNameHandoff, OneTimeCodeLogin } from '../src/tyme-account';
import type { CreationTarget, OwnedCharacter } from '../src/tyme-account';
import { MudSession } from '../src/mud/MudSession';
import { useAutoReconnect } from '../src/hooks/useAutoReconnect';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owned: OwnedCharacter = { accountId: '42', idnum: 123, port: 8000, name: 'Duke', csrf: 'opaque' };
const creation: CreationTarget = { accountId: '42', port: 8000, name: 'Duke', csrf: 'opaque' };

describe('Tyme brands redial after a dropped connection', () => {
    it('turns reconnect-on-drop on for guest and owned-character brands', () => {
        // Why: an Apache restart dropped always-on alts and nothing brought them back.
        const guest = tymeBrandFromSearch('?port=8000');
        const character = tymeBrandFromSearch('?port=8000&character=123', owned, async () => '1');
        expect(brandConnectionData(guest!)?.reconnectOnDrop).toBe(true);
        expect(brandConnectionData(character!)?.reconnectOnDrop).toBe(true);
    });

    it('does not for a creation link: a redial would try to create the character again', () => {
        const brand = tymeBrandFromSearch('?port=8000&create=Duke', undefined, undefined, creation, async () => '1.012345');
        expect(brandConnectionData(brand!)?.reconnectOnDrop).toBeUndefined();
    });

    it('also reaches a profile saved in browser storage by an earlier visit', () => {
        // App.ensureBrandProfile re-stamps the brand seed onto the matched saved profile.
        const brand = tymeBrandFromSearch('?port=8000&character=123', owned, async () => '1')!;
        const id = useAppStore.getState().addConnection({
            name: 'Duke — Testport', mode: 'mud', host: 'tymemud.com', port: 8000,
            proxyUrl: brand.proxyUrl, brandProfileKey: brand.profileKey,
        });
        const existing = matchBrandProfile(useAppStore.getState().connections, brand);
        expect(existing?.id).toBe(id);
        useAppStore.getState().patchConnection(existing!.id, brandConnectionData(brand)!);
        expect(useAppStore.getState().connections.find(c => c.id === id)?.reconnectOnDrop).toBe(true);
    });
});

describe('a redialled owned-character login', () => {
    // Mirrors the wiring in ProfileSession's auto-login effect: the same objects
    // live across redials and are reset by client.connect / client.disconnect.
    it('fetches a new one-time code each time and never reuses the first', async () => {
        const codes = ['000001', '000002'];
        const fetchCode = vi.fn(async () => codes.shift() ?? '');
        const secrets: string[] = [];
        const names: string[] = [];
        let handoff!: AccountNameHandoff;
        const login = new OneTimeCodeLogin({ fetchCode, sendSecret: c => secrets.push(c), onError: () => {} });
        handoff = new AccountNameHandoff({
            name: 'Duke', sendName: () => names.push('Duke'), nameSent: () => login.nameSent(), cancelTimer: () => {},
        });
        const connect = async () => {
            handoff.connected(); login.connected();
            handoff.prompt('By what name do you wish to be known?');
            login.maskChanged(true);
            await Promise.resolve(); await Promise.resolve();
        };
        await connect();
        login.disconnected();
        await connect();
        expect(names).toEqual(['Duke', 'Duke']);
        expect(fetchCode).toHaveBeenCalledTimes(2);
        expect(secrets).toEqual(['000001', '000002']);
    });

    it('leaves the player at the login prompt when the second code cannot be fetched', async () => {
        let fail = false;
        const fetchCode = vi.fn(async () => { if (fail) throw new AccountError('login', 'Sign in again.'); return '000001'; });
        const secrets: string[] = [];
        const errors: AccountError[] = [];
        const login = new OneTimeCodeLogin({ fetchCode, sendSecret: c => secrets.push(c), onError: e => errors.push(e) });
        login.connected(); login.nameSent(); login.maskChanged(true);
        await Promise.resolve(); await Promise.resolve();
        login.disconnected();
        fail = true;
        login.connected(); login.nameSent(); login.maskChanged(true);
        await Promise.resolve(); await Promise.resolve();
        expect(secrets).toEqual(['000001']);
        expect(errors.map(e => e.kind)).toEqual(['login']);
        await Promise.resolve();
        expect(fetchCode).toHaveBeenCalledTimes(2);   // no retry loop
    });
});

class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.OPEN;
    binaryType = '';
    protocol = '';
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(public url: string) { MockWebSocket.instances.push(this); }
    send() {}
    close() { this.readyState = MockWebSocket.CLOSED; }
}

describe('redial while the web server is down', () => {
    const URL_ = 'wss://tymemud.com/play/ws/8000';
    const g = globalThis as Record<string, unknown>;
    let real: unknown;
    let session: MudSession;
    let root: Root;
    let redials: number;

    beforeEach(() => {
        vi.useFakeTimers();
        real = g.WebSocket;
        g.WebSocket = MockWebSocket as unknown;
        MockWebSocket.instances = [];
        redials = 0;
        session = new MudSession();
        document.body.replaceChildren();
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const Probe = () => {
            useAutoReconnect({ session, enabled: true, redial: () => { redials += 1; session.connect(URL_); } });
            return null;
        };
        act(() => { root.render(createElement(Probe)); });
    });
    afterEach(() => {
        act(() => root.unmount());
        try { session.destroy(); } catch { /* best effort */ }
        g.WebSocket = real;
        vi.useRealTimers();
    });

    const last = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

    it('keeps retrying with no attempt cap until the proxy answers, then redials a settled drop once', async () => {
        // A settled session drops (Apache restarts) ...
        act(() => { session.connect(URL_); });
        await act(async () => {
            last().onopen?.({});
            last().onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) });
        });
        vi.advanceTimersByTime(60_000);
        await act(async () => { last().onclose?.({ code: 1006, reason: '', wasClean: false }); });
        expect(redials).toBe(1);
        // ... and the WebSocket cannot even open for 25 attempts in a row.
        for (let i = 0; i < 25; i++) {
            await act(async () => { last().onclose?.({ code: 1006, reason: '', wasClean: false }); });
            await act(async () => { vi.advanceTimersByTime(60_000); });
        }
        expect(redials).toBe(26);
        expect(MockWebSocket.instances).toHaveLength(27);
    });

    it('never redials a Disconnect the player asked for', async () => {
        act(() => { session.connect(URL_); });
        await act(async () => {
            last().onopen?.({});
            last().onmessage?.({ data: JSON.stringify({ type: 'game.connected' }) });
        });
        vi.advanceTimersByTime(60_000);
        await act(async () => { session.disconnect(); });
        await act(async () => { vi.advanceTimersByTime(120_000); });
        expect(redials).toBe(0);
    });
});
