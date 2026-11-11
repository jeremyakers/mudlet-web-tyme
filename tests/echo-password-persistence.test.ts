import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoHandler } from '../src/mud/protocol/echo';
import { ECHO_WILL, ECHO_WONT } from '../src/mud/protocol/constants';

afterEach(() => {
    vi.useRealTimers();
});

describe('Tyme password privacy', () => {
    it('keeps masking after 60 seconds until the server sends WONT ECHO', () => {
        // Given a connected server holding its password prompt open with WILL ECHO.
        vi.useFakeTimers();
        const handler = new EchoHandler(() => {}, () => {});
        handler.reset();
        handler.processData(ECHO_WILL);
        expect(handler.passwordMode).toBe(true);

        // When the player takes longer than the old safety timeout.
        vi.advanceTimersByTime(61_000);

        // Then password masking and its history suppression remain active.
        expect(handler.passwordMode).toBe(true);

        // And only normal ECHO negotiation ends the password state.
        handler.processData(ECHO_WONT);
        expect(handler.passwordMode).toBe(false);
    });

    it('keeps every retry password private while the anomaly window is crossed', () => {
        // Given MM32's real retry loop: prompt, wrong password (WONT), prompt
        // again (WILL) — twice in a row, faster than the anomaly window.
        vi.useFakeTimers();
        const masks: boolean[] = [];
        const anomalies: boolean[] = [];
        const handler = new EchoHandler(() => {}, mask => masks.push(mask), () => anomalies.push(true));
        handler.reset();
        handler.processData(ECHO_WILL);
        handler.processData(ECHO_WONT);   // wrong password #1 ends the prompt
        handler.processData(ECHO_WILL);   // prompt reopened
        handler.processData(ECHO_WONT);   // wrong password #2
        handler.processData(ECHO_WILL);   // third prompt (5th ECHO flip)

        // Then the retry loop reports the anomaly pattern (for scripts) but
        // the third attempt is masked exactly like the first.
        expect(anomalies).toEqual([true]);
        expect(handler.passwordMode).toBe(true);

        // And the correct submission's final WONT ECHO restores normal echo,
        // so later ordinary commands are neither shown plain-typed twice nor
        // stuck masked.
        handler.processData(ECHO_WONT);
        expect(handler.passwordMode).toBe(false);
    });

    it('clears a pending password state on disconnect reset', () => {
        // Given a password prompt that never sends WONT ECHO.
        vi.useFakeTimers();
        const handler = new EchoHandler(() => {}, () => {});
        handler.reset();
        handler.processData(ECHO_WILL);

        // When the connection is reset after any delay.
        vi.advanceTimersByTime(61_000);
        handler.reset();

        // Then no stale password state reaches the next connection.
        expect(handler.passwordMode).toBe(false);
    });
});
