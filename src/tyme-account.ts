/**
 * Browser side of the Play account handoff (`/play/account.php`).
 *
 * The website owns identity. This module only asks it which character the
 * signed-in account owns, and later asks for a one-use game login code. Codes
 * are held in memory for the single moment they are typed into the game's
 * secret prompt: they are never put in a URL, a log line, the profile store,
 * the credential vault, command history or an export.
 */

const ACCOUNT_ENDPOINT = '/play/account.php';
/** Upper bound for one account request, response body included. A hung website
 *  must end in a retryable error instead of leaving the page blank. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The one `fetch` shape this module needs; the browser's `fetch` satisfies it. */
export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OwnedCharacter {
    readonly accountId: string;
    readonly idnum: number;
    readonly port: number;
    readonly name: string;
    /** Opaque request token for the code POST; not a login secret. */
    readonly csrf: string;
}

export interface CreationTarget {
    readonly accountId: string;
    readonly port: number;
    readonly name: string;
    /** Opaque request token for the grant POST; not a login secret. */
    readonly csrf: string;
}

/** `login`: not signed in / not an owned, enabled character. `name_taken`: the
 *  requested new-character name already exists. `unavailable`: the check could
 *  not be completed (network, timeout, server error) and may be retried.
 *  `invalid`: the page URL itself names no usable character. */
export type AccountFailure = 'login' | 'name_taken' | 'unavailable' | 'invalid';

/** Messages are fixed text: they never carry server output, tokens or codes. */
export class AccountError extends Error {
    constructor(readonly kind: AccountFailure, message: string) {
        super(message);
        this.name = 'AccountError';
    }
}

const NOT_OWNED = 'This character is not available to your signed-in account.';
const UNAVAILABLE = 'The account service could not be reached.';

function failureForStatus(status: number): AccountError {
    return status === 401 || status === 403 || status === 404
        ? new AccountError('login', NOT_OWNED)
        : new AccountError('unavailable', UNAVAILABLE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One request, bounded in time from the first byte sent to the last body byte
 *  read. Returns the status, and the parsed JSON body only for a 2xx answer. */
async function requestJson(
    fetchImpl: Fetch,
    url: string,
    init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (!response.ok) return { status: response.status, body: undefined };
        return { status: response.status, body: await response.json() };
    } catch {
        throw new AccountError('unavailable', UNAVAILABLE);
    } finally {
        clearTimeout(timer);
    }
}

/** Fetch the account's own character for this exact port and id. Additive
 *  fields are ignored; a response for any other target is refused rather than
 *  trusted, so the page can never open another account's or character's profile. */
export async function fetchOwnedCharacter(
    port: number,
    idnum: number,
    fetchImpl: Fetch = fetch,
): Promise<OwnedCharacter> {
    const { status, body } = await requestJson(fetchImpl, `${ACCOUNT_ENDPOINT}?port=${port}&character=${idnum}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    });
    if (status < 200 || status >= 300) throw failureForStatus(status);

    const character = isRecord(body) ? body.character : undefined;
    if (
        !isRecord(body) || !isRecord(character)
        || typeof body.account_id !== 'string' || !/^\d+$/.test(body.account_id)
        || typeof body.csrf !== 'string' || body.csrf === ''
        || typeof character.name !== 'string' || character.name === ''
        || character.idnum !== idnum || character.port !== port
    ) {
        throw new AccountError('login', NOT_OWNED);
    }
    return { accountId: body.account_id, idnum, port, name: character.name, csrf: body.csrf };
}

function normalizeCreationName(name: string): string | null {
    return /^[A-Za-z']{2,20}$/.test(name)
        ? name[0].toUpperCase() + name.slice(1).toLowerCase()
        : null;
}

function creationFailureForStatus(status: number, name: string): AccountError {
    return status === 409
        ? new AccountError('name_taken', `${name} is already taken. Choose another name on your account page.`)
        : failureForStatus(status);
}

/** Fetch the signed-in account's creation target. The server normalizes the
 *  name and proves that no live character already holds it. */
export async function fetchCreationTarget(
    port: number,
    name: string,
    fetchImpl: Fetch = fetch,
): Promise<CreationTarget> {
    const normalized = normalizeCreationName(name);
    if (normalized === null) throw new AccountError('invalid', 'This character link is not valid.');
    const { status, body } = await requestJson(fetchImpl, `${ACCOUNT_ENDPOINT}?port=${port}&create=${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    });
    if (status < 200 || status >= 300) throw creationFailureForStatus(status, normalized);

    const create = isRecord(body) ? body.create : undefined;
    if (
        !isRecord(body) || !isRecord(create)
        || typeof body.account_id !== 'string' || !/^\d+$/.test(body.account_id)
        || typeof body.csrf !== 'string' || body.csrf === ''
        || create.port !== port || create.name !== normalized
    ) {
        throw new AccountError('login', NOT_OWNED);
    }
    return { accountId: body.account_id, port, name: normalized, csrf: body.csrf };
}

function postCode(owned: OwnedCharacter, csrf: string, fetchImpl: Fetch) {
    return requestJson(fetchImpl, ACCOUNT_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action: 'game_login', port: owned.port, character: owned.idnum, csrf }),
    });
}

/** A function that asks the website for a fresh one-use code each time it is
 *  called. One rotated CSRF token is re-read for the same account/character;
 *  if the signed-in account changed in the meantime the call fails instead. */
export function createCodeSource(owned: OwnedCharacter, fetchImpl: Fetch = fetch): () => Promise<string> {
    let csrf = owned.csrf;
    return async () => {
        let result = await postCode(owned, csrf, fetchImpl);
        if (result.status === 403) {
            const current = await fetchOwnedCharacter(owned.port, owned.idnum, fetchImpl);
            if (current.accountId !== owned.accountId) throw new AccountError('login', NOT_OWNED);
            csrf = current.csrf;
            result = await postCode(owned, csrf, fetchImpl);
        }
        if (result.status < 200 || result.status >= 300) throw failureForStatus(result.status);
        const code = isRecord(result.body) ? result.body.code : undefined;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
            throw new AccountError('unavailable', 'The account service returned an unusable login code.');
        }
        return code;
    };
}

function postGrant(creation: CreationTarget, csrf: string, fetchImpl: Fetch) {
    return requestJson(fetchImpl, ACCOUNT_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action: 'new_character', port: creation.port, name: creation.name, csrf }),
    });
}

/** A fresh creation grant for each call, with the same rotated-CSRF handling
 *  as the existing game-login code source. The grant itself never enters a URL. */
export function createGrantSource(creation: CreationTarget, fetchImpl: Fetch = fetch): () => Promise<string> {
    let csrf = creation.csrf;
    return async () => {
        let result = await postGrant(creation, csrf, fetchImpl);
        if (result.status === 403) {
            const current = await fetchCreationTarget(creation.port, creation.name, fetchImpl);
            if (current.accountId !== creation.accountId) throw new AccountError('login', NOT_OWNED);
            csrf = current.csrf;
            result = await postGrant(creation, csrf, fetchImpl);
        }
        if (result.status < 200 || result.status >= 300) throw creationFailureForStatus(result.status, creation.name);
        const grant = isRecord(result.body) ? result.body.grant : undefined;
        if (typeof grant !== 'string' || !/^\d+\.\d{6}$/.test(grant)) {
            throw new AccountError('unavailable', 'The account service returned an unusable creation grant.');
        }
        return grant;
    };
}

export interface OneTimeCodeLoginDeps {
    readonly fetchCode: () => Promise<string>;
    /** Sent to the game without local echo, history or logging. */
    readonly sendSecret: (code: string) => void;
    readonly onError: (error: AccountError) => void;
}

/**
 * Sends one game login code per connection, and only at the secret-input
 * boundary: after the character name has gone out and the game then switches
 * the input line to masked entry. The code is requested only once the name is
 * sent, is held in memory just until it is sent, and is dropped on disconnect.
 * A redial fetches a new code; an old one is never replayed.
 */
export class OneTimeCodeLogin {
    private generation = 0;
    private nameWasSent = false;
    private masked = false;
    private code: string | null = null;
    private used = false;

    constructor(private readonly deps: OneTimeCodeLoginDeps) {}

    connected(): void {
        this.reset();
    }

    disconnected(): void {
        this.reset();
    }

    /** The character name has been sent. Masking seen before this is not ours. */
    nameSent(): void {
        if (this.nameWasSent || this.used) return;
        this.nameWasSent = true;
        this.masked = false;
        const generation = this.generation;
        this.deps.fetchCode().then(
            code => {
                if (generation !== this.generation) return;
                this.code = code;
                this.trySend();
            },
            (error: unknown) => {
                if (generation !== this.generation) return;
                this.deps.onError(error instanceof AccountError
                    ? error
                    : new AccountError('unavailable', UNAVAILABLE));
            },
        );
    }

    maskChanged(masked: boolean): void {
        this.masked = masked;
        this.trySend();
    }

    private trySend(): void {
        if (this.code === null || !this.nameWasSent || !this.masked || this.used) return;
        const code = this.code;
        this.code = null;
        this.used = true;
        this.deps.sendSecret(code);
    }

    private reset(): void {
        this.generation++;
        this.nameWasSent = false;
        this.masked = false;
        this.code = null;
        this.used = false;
    }
}

export interface OneTimeCreationDeps {
    readonly fetchGrant: () => Promise<string>;
    readonly sendConfirmation: (answer: string) => void;
    /** Sent to the game without local echo, history or logging. */
    readonly sendSecret: (grant: string) => void;
    readonly onError: (error: AccountError) => void;
}

/** One new-character handoff per connection. The name is sent by TextAutoLogin;
 *  this answers only its following creation confirmation and email prompts.
 *  An existing name's password prompt matches neither and is left alone. */
export class OneTimeCreation {
    private generation = 0;
    private nameWasSent = false;
    private confirmed = false;
    private grantRequested = false;
    private used = false;

    constructor(private readonly deps: OneTimeCreationDeps) {}

    connected(): void {
        this.reset();
    }

    disconnected(): void {
        this.reset();
    }

    nameSent(): void {
        if (this.nameWasSent || this.used) return;
        this.nameWasSent = true;
    }

    prompt(line: string): void {
        if (!this.nameWasSent || this.used) return;
        if (!this.confirmed) {
            if (!/^Create [A-Za-z'][A-Za-z']{1,19}\? \[y\/n\] :\s*$/.test(line)) return;
            this.confirmed = true;
            this.deps.sendConfirmation('y');
            return;
        }
        if (this.grantRequested || !/^Email address(?: or creation code)?:\s*$/.test(line)) return;
        this.grantRequested = true;
        const generation = this.generation;
        this.deps.fetchGrant().then(
            grant => {
                if (generation !== this.generation || this.used) return;
                this.used = true;
                this.deps.sendSecret(grant);
            },
            (error: unknown) => {
                if (generation !== this.generation) return;
                this.deps.onError(error instanceof AccountError
                    ? error
                    : new AccountError('unavailable', UNAVAILABLE));
            },
        );
    }

    private reset(): void {
        this.generation++;
        this.nameWasSent = false;
        this.confirmed = false;
        this.grantRequested = false;
        this.used = false;
    }
}

export interface AccountNameHandoffDeps {
    /** The character name this tab logs in as or creates. */
    readonly name: string;
    /** Sends the name to the game (no echo, history or logging). */
    readonly sendName: () => void;
    /** The name has gone out, by the client or typed by the player: the code
     *  or creation steps that follow it may proceed. */
    readonly nameSent: () => void;
    /** Stops the fallback auto-login timer. */
    readonly cancelTimer: () => void;
}

/**
 * Who sends the character name, once per connection. The client sends it as
 * soon as the game asks ("By what name do you wish to be known?"), with the
 * auto-login timer as a fallback. If the player types a line first, the client
 * never sends the name as well: a duplicate would answer the game's next
 * question (the new-character y/n, or the password). When what the player
 * typed is this character's name, the code or creation steps still follow it;
 * anything else leaves the player in charge.
 */
export class AccountNameHandoff {
    private decided = false;

    constructor(private readonly deps: AccountNameHandoffDeps) {}

    connected(): void {
        this.decided = false;
    }

    /** One line of game output. */
    prompt(line: string): void {
        if (this.decided || !/^By what name do you wish to be known\?\s*$/.test(line)) return;
        this.decided = true;
        this.deps.cancelTimer();
        this.deps.sendName();
        this.deps.nameSent();
    }

    /** The fallback timer fired; returns whether the client should send the name. */
    timer(): boolean {
        if (this.decided) return false;
        this.decided = true;
        return true;
    }

    /** The player sent a line. */
    playerInput(line: string): void {
        if (this.decided) return;
        this.decided = true;
        this.deps.cancelTimer();
        if (line.trim().toLowerCase() === this.deps.name.toLowerCase()) this.deps.nameSent();
    }
}
