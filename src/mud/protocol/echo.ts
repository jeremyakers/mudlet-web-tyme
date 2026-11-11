import { ECHO_DO, ECHO_DONT } from "./constants";

const IAC = 0xFF, SB = 0xFA, SE = 0xF0;
const WILL = 0xFB, WONT = 0xFC, DO = 0xFD, DONT = 0xFE;
const ECHO_OPT = 0x01;


/** Mudlet-parity anomaly detection (cTelnet::checkEchoAnomalyPattern):
 *  if the raw ECHO state toggles ≥ ANOMALY_THRESHOLD times within
 *  ANOMALY_WINDOW_MS we note that the server is likely misusing ECHO for
 *  per-line edit signalling and report the pattern — and nothing else. Tyme
 *  keeps the report diagnostic: the refusal Mudlet arms here also unmasked
 *  passwords when a login's wrong-password retry loop (WONT/WILL per attempt)
 *  crossed the same window, so the third attempt typed in plain sight. The
 *  event lets a script react; masking itself keeps following the ECHO
 *  negotiation. */
const ANOMALY_THRESHOLD = 5;
const ANOMALY_WINDOW_MS = 5000;

/** Tyme contract, replacing Mudlet's login-phase safety timeout: once the
 *  server takes ECHO for a password prompt, masking — and the command
 *  history/display suppression that rides on it — stays active until the
 *  server itself ends the prompt with `IAC WONT ECHO` or the connection is
 *  reset. A real delayed login can outrun any fixed timeout, and a timed
 *  reset unmasked input exactly while the game was still awaiting the
 *  password; ordinary commands echo normally again the moment WONT ECHO
 *  commits (see tests/echo-password-persistence.test.ts). */

export class EchoHandler {
    /** State exposed to UI / send-echo logic, committed on the negotiation
     *  itself as cTelnet does. True whenever the server is echoing for us, which
     *  means we must suppress our own local command echo to avoid showing every
     *  line twice — and, since a server that echoes for us is a server we must
     *  not echo a password for, it is also when the input is masked. */
    private _serverEchoing = false;
    private toggleCount = 0;
    private lastToggleAt = 0;
    private _anomalyDetected = false;
    private readonly sendRaw: (data: string) => void;
    private readonly onEchoChange: (maskInput: boolean) => void;
    private readonly onAnomalyDetected: (() => void) | undefined;

    constructor(
        sendRaw: (data: string) => void,
        onEchoChange: (maskInput: boolean) => void,
        onAnomalyDetected?: () => void,
    ) {
        this.sendRaw = sendRaw;
        this.onEchoChange = onEchoChange;
        this.onAnomalyDetected = onAnomalyDetected;
    }

    get serverEchoing(): boolean {
        return this._serverEchoing;
    }

    /**
     * Whether the command input should be masked. Any ECHO the server takes,
     * which is what cTelnet does — setRemoteEchoingActive(true) on WILL ECHO,
     * with nothing else consulted.
     *
     * Mudlet Web used to mask only for an ECHO that engaged AFTER the server had
     * printed something, on the reading that a connect-time one is session-wide
     * remote echo rather than a password prompt, and that masking it would hide
     * the player's name as they typed it. Nothing was ever recorded as running
     * into that: the commit carrying the distinction does not mention echo at
     * all, and the one MUD named anywhere near this file is cited for two other
     * problems. Meanwhile the reading has a worse failure of its own — a server
     * that negotiates ECHO in its opening burst and then asks for a password
     * gets no masking at all, which is the error that matters. So: Mudlet's
     * rule, and if a MUD does turn up that needs the distinction it comes back
     * with a name attached.
     */
    get passwordMode(): boolean {
        return this._serverEchoing;
    }

    get anomalyDetected(): boolean {
        return this._anomalyDetected;
    }

    /** Scan the post-MCCP byte stream for true `IAC WILL/WONT ECHO`. Substring
     *  matching on the raw buffer is unsafe — GMCP/MSDP subnegotiation payloads
     *  can contain the same byte sequence (e.g. an unescaped IAC followed by
     *  MSDP_VAR=\x01), which would spuriously flip password mode every prompt
     *  on data-heavy servers like Legend of Kallisti. Walk the stream as
     *  telnet: skip SB…SE blocks entirely, honor IAC IAC escapes, and only act
     *  on top-level IAC WILL/WONT ECHO. */
    processData(data: string): void {
        let i = 0;
        while (i < data.length) {
            if (data.charCodeAt(i) !== IAC) { i++; continue; }
            const cmd = data.charCodeAt(i + 1);
            if (cmd === IAC) { i += 2; continue; }
            if (cmd === SB) {
                const end = findSubnegEnd(data, i + 2);
                i = end < 0 ? data.length : end + 2;
                continue;
            }
            if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
                if (data.charCodeAt(i + 2) === ECHO_OPT) {
                    if (cmd === WILL) this.setEchoing(true);
                    else if (cmd === WONT) this.setEchoing(false);
                }
                i += 3;
                continue;
            }
            i += 2;
        }
    }

    private setEchoing(on: boolean): void {
        if (on === this._serverEchoing) return;
        // The toggle counter only reports a server that misuses ECHO for line
        // editing — see trackToggleAndDetectAnomaly, which is cTelnet's
        // checkEchoAnomalyPattern down to the 5-in-5000ms constants. Mudlet's
        // sticky refusal lived here and would have left every later password
        // prompt unmasked; Tyme's report touches nothing else.
        this.trackToggleAndDetectAnomaly();
        // Committed on the negotiation itself, exactly where cTelnet calls
        // setRemoteEchoingActive(). There used to be half a second of debounce
        // in front of this, to keep a bouncing server from being acked on every
        // flip — but that is the job the anomaly counter above already does,
        // upstream and here, and the delay was visible where it must not be: a
        // script that negotiates ECHO and reads the command line in the same
        // breath saw the state before the prompt, and the masking a player is
        // owed arrived late.
        this._serverEchoing = on;
        this.sendRaw(on ? ECHO_DO : ECHO_DONT);
        this.onEchoChange(this.passwordMode);
        if (debugEchoEnabled()) {
            const mode = !this._serverEchoing ? 'OFF (normal)'
                : this.passwordMode ? 'ON (password mode)'
                : 'ON (server-wide echo, input not masked)';
            console.debug(`[mudlet.echo] committed → ${mode}`);
        }
    }

    /** Mirror cTelnet::checkEchoAnomalyPattern as a diagnostic. Increments a
     *  sliding-window toggle counter on every raw flip and, when the threshold
     *  is crossed, raises the engine event so a `sysEchoAnomalyDetected` Lua
     *  event can fire. Unlike desktop's checkEchoAnomalyPattern it refuses
     *  nothing: the sticky refusal unmasked passwords on a retry loop and
     *  doubled lines are a display complaint, not a privacy one. */
    private trackToggleAndDetectAnomaly(): void {
        const now = Date.now();
        if (this.lastToggleAt > 0 && now - this.lastToggleAt < ANOMALY_WINDOW_MS) {
            this.toggleCount++;
        } else {
            this.toggleCount = 1;
        }
        this.lastToggleAt = now;
        // One report per session keeps the console quiet on a churny server;
        // the flag stays diagnostic and never gates the negotiation.
        if (this.toggleCount >= ANOMALY_THRESHOLD && !this._anomalyDetected) {
            this._anomalyDetected = true;
            this.onAnomalyDetected?.();
            if (debugEchoEnabled()) {
                console.warn(`[mudlet.echo] anomaly detected — ECHO is toggling ≥ ${ANOMALY_THRESHOLD}×/${ANOMALY_WINDOW_MS}ms; reported, masking still follows the negotiation`);
            }
        }
    }

    reset(): void {
        this.toggleCount = 0;
        this.lastToggleAt = 0;
        this._anomalyDetected = false;
        if (this._serverEchoing) {
            this._serverEchoing = false;
            this.onEchoChange(false);
        }
    }
}

function debugEchoEnabled(): boolean {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('mudlet.debugEcho') === '1';
    } catch {
        return false;
    }
}

/** Find the offset of `IAC SE` (the end-of-subneg) at-or-after `from`. Skips
 *  embedded `IAC IAC` (escaped data IAC). Returns the index of the `IAC` byte
 *  of the closing pair, or -1 if the subneg is incomplete in this chunk. */
function findSubnegEnd(data: string, from: number): number {
    for (let i = from; i < data.length - 1; i++) {
        if (data.charCodeAt(i) !== IAC) continue;
        const next = data.charCodeAt(i + 1);
        if (next === IAC) { i++; continue; }
        if (next === SE) return i;
    }
    return -1;
}
