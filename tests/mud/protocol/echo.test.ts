import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EchoHandler } from '../../../src/mud/protocol/echo';
import { ECHO_WILL, ECHO_WONT, ECHO_DO, ECHO_DONT } from '../../../src/mud/protocol/constants';

function makeHandler() {
  const sent: string[] = [];
  const masks: boolean[] = [];
  let anomalies = 0;
  const handler = new EchoHandler(
    (data) => sent.push(data),
    (maskInput) => masks.push(maskInput),
    () => { anomalies++; },
  );
  handler.reset(); // clears state
  return { handler, sent, masks, anomalies: () => anomalies };
}

// The rule is cTelnet's: the server taking ECHO is the server saying "do not
// show what is typed", and nothing else is consulted. Mudlet Web used to mask only
// for an ECHO that engaged AFTER the server had printed something, so that a
// full-server-echo MUD would not hide the player's name — but nothing was ever
// recorded as running into that, and the reading left a server which negotiates
// ECHO in its opening burst and then asks for a password with no masking at all,
// which is the error that matters.
describe('EchoHandler — masking follows the server taking ECHO', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('masks for a WILL ECHO in the opening burst, before any output', () => {
    const { handler, sent, masks } = makeHandler();

    handler.processData(ECHO_WILL);

    expect(handler.serverEchoing).toBe(true);
    expect(handler.passwordMode).toBe(true);
    expect(sent).toContain(ECHO_DO);          // acked on the wire
    expect(masks[masks.length - 1]).toBe(true);
  });

  it('masks for one that arrives after the server has printed output', () => {
    const { handler, masks } = makeHandler();

    handler.processData('By what name do you wish to be known? ');
    handler.processData(ECHO_WILL);

    expect(handler.serverEchoing).toBe(true);
    expect(handler.passwordMode).toBe(true);
    expect(masks[masks.length - 1]).toBe(true);

    // WONT ECHO ends it again.
    handler.processData(ECHO_WONT);
    expect(handler.passwordMode).toBe(false);
    expect(masks[masks.length - 1]).toBe(false);
  });

  it('commits on the negotiation itself, with no settling delay', () => {
    const { handler, masks } = makeHandler();

    handler.processData(ECHO_WILL);
    // Read before any timer could have run: cTelnet calls
    // setRemoteEchoingActive() in the WILL branch, so the state is already
    // there for a script that negotiates and asks in the same breath.
    expect(handler.passwordMode).toBe(true);
    expect(masks).toEqual([true]);
  });

  it('keeps masking after any delay until the server sends WONT ECHO', () => {
    const { handler } = makeHandler();

    handler.processData(ECHO_WILL);
    expect(handler.serverEchoing).toBe(true);

    // Mudlet's login-phase safety timer unmasked input while the game was
    // still awaiting a password. Tyme keeps the prompt private until the
    // server itself ends it — no timer can beat a server that is slower
    // than any fixed window.
    vi.advanceTimersByTime(61_000);
    expect(handler.serverEchoing).toBe(true);

    handler.processData(ECHO_WONT);
    expect(handler.serverEchoing).toBe(false);
  });
});

// The anomaly pattern is diagnostic in Tyme: cTelnet's sticky refusal lived
// here and unmasked every later password prompt — a wrong-password retry loop
// (WONT/WILL per attempt) crosses the same 5-in-5000ms window. The engine
// event still fires; the negotiation itself is untouched (#354).
describe('EchoHandler — an ECHO anomaly is reported, not enforced', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports the bouncing pattern once and keeps masking on the prompt', () => {
    const { handler, sent, masks, anomalies } = makeHandler();
    for (let i = 0; i < 5; i++) handler.processData(i % 2 === 0 ? ECHO_WILL : ECHO_WONT);
    expect(handler.anomalyDetected).toBe(true);
    expect(anomalies()).toBe(1);

    // The next prompt is masked as the negotiation says, and answered with
    // the ordinary acknowledgements — never with a session-wide refusal.
    sent.length = 0;
    masks.length = 0;
    handler.processData(ECHO_WONT);
    handler.processData(ECHO_WILL);
    expect(sent).toEqual([ECHO_DONT, ECHO_DO]);
    expect(handler.serverEchoing).toBe(true);
    expect(masks).toEqual([false, true]);

    // WONT ECHO still ends it, as on any clean connection.
    masks.length = 0;
    handler.processData(ECHO_WONT);
    expect(handler.serverEchoing).toBe(false);
    expect(masks).toEqual([false]);
  });
});
