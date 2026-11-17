import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AccountError,
    AccountNameHandoff,
    OneTimeCodeLogin,
    OneTimeCreation,
    createCodeSource,
    createGrantSource,
    fetchCreationTarget,
    fetchOwnedCharacter,
    type CreationTarget,
    type Fetch,
    type OwnedCharacter,
} from '../src/tyme-account';

// The website is faked only at the HTTP wire: these tests hand the module a
// `fetch` and inspect the exact requests it makes, so the module's own parsing
// and policy are what is under test.
function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        ...init,
    });
}

const metadata = {
    account_id: '42',
    character: { idnum: 123, port: 8000, name: 'Duke' },
    csrf: 'csrf-one',
};

describe('owned-character metadata', () => {
    it('reads one owned character with a same-origin credentialed GET and no code', async () => {
        const fetchImpl = vi.fn<Fetch>(async () => json(metadata));

        const owned = await fetchOwnedCharacter(8000, 123, fetchImpl);

        expect(owned).toEqual({ accountId: '42', idnum: 123, port: 8000, name: 'Duke', csrf: 'csrf-one' });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/play/account.php?port=8000&character=123');
        expect(init.method ?? 'GET').toBe('GET');
        expect(init.credentials).toBe('same-origin');
        expect(init.cache).toBe('no-store');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('tolerates compatible additive fields from a newer server', async () => {
        const fetchImpl: Fetch = async () => json({ ...metadata, extra: { later: true }, character: { ...metadata.character, rank: 'x' } });
        await expect(fetchOwnedCharacter(8000, 123, fetchImpl)).resolves.toMatchObject({ name: 'Duke' });
    });

    it.each([401, 403, 404])('treats HTTP %i as "not yours or not signed in", not a retryable outage', async status => {
        const fetchImpl: Fetch = async () => json({ error: 'nope' }, { status });
        await expect(fetchOwnedCharacter(8000, 123, fetchImpl))
            .rejects.toMatchObject({ kind: 'login' });
    });

    it.each([500, 503])('treats HTTP %i as a retryable outage', async status => {
        const fetchImpl: Fetch = async () => json({}, { status });
        await expect(fetchOwnedCharacter(8000, 123, fetchImpl))
            .rejects.toMatchObject({ kind: 'unavailable' });
    });

    it('treats a network failure as a retryable outage', async () => {
        const fetchImpl: Fetch = async () => { throw new TypeError('offline'); };
        await expect(fetchOwnedCharacter(8000, 123, fetchImpl))
            .rejects.toBeInstanceOf(AccountError);
    });

    it.each([
        ['another character', { ...metadata, character: { ...metadata.character, idnum: 124 } }],
        ['another port', { ...metadata, character: { ...metadata.character, port: 9696 } }],
        ['a non-decimal account id', { ...metadata, account_id: 'abc' }],
        ['no name', { ...metadata, character: { idnum: 123, port: 8000 } }],
        ['no csrf', { account_id: '42', character: metadata.character }],
        ['not an object', 'Duke'],
    ])('never accepts a response describing %s', async (_label, body) => {
        const fetchImpl: Fetch = async () => json(body);
        await expect(fetchOwnedCharacter(8000, 123, fetchImpl)).rejects.toBeInstanceOf(AccountError);
    });
});

describe('character-creation account handoff', () => {
    const creationBody = {
        account_id: '42',
        create: { port: 8000, name: 'Duke' },
        csrf: 'csrf-one',
    };
    const creation: CreationTarget = { accountId: '42', port: 8000, name: 'Duke', csrf: 'csrf-one' };

    it('fetches only creation metadata by port and name, then returns the normalized target', async () => {
        const fetchImpl = vi.fn<Fetch>(async () => json(creationBody));
        await expect(fetchCreationTarget(8000, 'duke', fetchImpl)).resolves.toEqual(creation);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/play/account.php?port=8000&create=duke');
        expect(init.method ?? 'GET').toBe('GET');
        expect(init.credentials).toBe('same-origin');
        expect(init.cache).toBe('no-store');
    });

    it('refuses metadata for another creation target', async () => {
        const fetchImpl: Fetch = async () => json({ ...creationBody, create: { port: 8000, name: 'Elayne' } });
        await expect(fetchCreationTarget(8000, 'Duke', fetchImpl)).rejects.toBeInstanceOf(AccountError);
    });

    it('reports a creation-name conflict instead of asking the signed-in player to sign in', async () => {
        const fetchImpl: Fetch = async () => json({ error: 'name_taken' }, { status: 409 });
        await expect(fetchCreationTarget(8000, 'duke', fetchImpl)).rejects.toMatchObject({
            kind: 'name_taken',
            message: 'Duke is already taken. Choose another name on your account page.',
        });
    });

    it('POSTs exactly the new_character request and returns only the grant', async () => {
        const fetchImpl = vi.fn<Fetch>(async () => json({ grant: '123.012345' }));
        await expect(createGrantSource(creation, fetchImpl)()).resolves.toBe('123.012345');
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/play/account.php');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ action: 'new_character', port: 8000, name: 'Duke', csrf: 'csrf-one' });
        expect(String(url)).not.toMatch(/csrf|grant|012345/);
    });

    it('reports a name conflict from the grant POST with the chosen name', async () => {
        const fetchImpl: Fetch = async () => json({ error: 'name_taken' }, { status: 409 });
        await expect(createGrantSource(creation, fetchImpl)()).rejects.toMatchObject({
            kind: 'name_taken',
            message: 'Duke is already taken. Choose another name on your account page.',
        });
    });

    it.each(['12345', '123.12345', '123.1234567', 'abc.012345', 123456, null])('rejects a malformed grant (%s) without echoing it', async bad => {
        const fetchImpl: Fetch = async () => json({ grant: bad });
        const error = await createGrantSource(creation, fetchImpl)().catch(e => e);
        expect(error).toBeInstanceOf(AccountError);
        expect(String(error.message)).not.toContain(String(bad));
    });
});

describe('one-use code source', () => {
    const owned: OwnedCharacter = { accountId: '42', idnum: 123, port: 8000, name: 'Duke', csrf: 'csrf-one' };

    it('POSTs exactly the game_login request and returns only the code', async () => {
        const fetchImpl = vi.fn<Fetch>(async () => json({ code: '012345', expires_at: '2030-01-01T00:00:00Z' }));
        const fetchCode = createCodeSource(owned, fetchImpl);

        await expect(fetchCode()).resolves.toBe('012345');

        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe('/play/account.php');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(init.cache).toBe('no-store');
        expect(JSON.parse(String(init.body))).toEqual({ action: 'game_login', port: 8000, character: 123, csrf: 'csrf-one' });
        expect(String(url)).not.toMatch(/csrf|code/);
    });

    it('requests a fresh code for every call and never reuses an earlier one', async () => {
        const codes = ['000001', '000002'];
        const fetchImpl = vi.fn<Fetch>(async () => json({ code: codes.shift(), expires_at: 'x' }));
        const fetchCode = createCodeSource(owned, fetchImpl);
        expect(await fetchCode()).toBe('000001');
        expect(await fetchCode()).toBe('000002');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it.each(['12345', '1234567', '01234567', 'abcdef', 123456, null])('rejects a malformed code (%s) without echoing it', async bad => {
        const fetchImpl: Fetch = async () => json({ code: bad });
        const error = await createCodeSource(owned, fetchImpl)().catch(e => e);
        expect(error).toBeInstanceOf(AccountError);
        expect(String(error.message)).not.toContain(String(bad));
    });

    it('refreshes a rotated CSRF token once for the same account and character, then succeeds', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn<Fetch>(async (url, init) => {
            calls.push(`${init.method ?? 'GET'} ${url}`);
            if (init.method === 'POST') {
                const body = JSON.parse(String(init.body));
                return body.csrf === 'csrf-two' ? json({ code: '111122' }) : json({ error: 'csrf' }, { status: 403 });
            }
            return json({ ...metadata, csrf: 'csrf-two' });
        });
        const fetchCode = createCodeSource(owned, fetchImpl);
        expect(await fetchCode()).toBe('111122');
        expect(calls).toEqual(['POST /play/account.php', 'GET /play/account.php?port=8000&character=123', 'POST /play/account.php']);
    });

    it('refuses to continue when the signed-in account changed underneath the tab', async () => {
        const fetchImpl = vi.fn<Fetch>(async (_url, init) => (
            init.method === 'POST' ? json({}, { status: 403 }) : json({ ...metadata, account_id: '99' })
        ));
        const error = await createCodeSource(owned, fetchImpl)().catch(e => e);
        expect(error).toMatchObject({ kind: 'login' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not leak the CSRF token or server text in an error', async () => {
        const fetchImpl: Fetch = async () => json({ error: 'secret-server-detail csrf-one' }, { status: 500 });
        const error = await createCodeSource(owned, fetchImpl)().catch(e => e);
        expect(error.message).not.toMatch(/csrf-one|secret-server-detail/);
    });
});

describe('OneTimeCodeLogin: the code is sent only at the secret-input boundary', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function harness(fetchCode = vi.fn(async () => '012345')) {
        const sent: string[] = [];
        const errors: AccountError[] = [];
        const login = new OneTimeCodeLogin({
            fetchCode,
            sendSecret: code => sent.push(code),
            onError: error => errors.push(error),
        });
        return { login, sent, errors, fetchCode };
    }

    it('asks for no code until the name has actually been sent', async () => {
        const { login, fetchCode } = harness();
        login.connected();
        login.maskChanged(true);
        await vi.runAllTimersAsync();
        expect(fetchCode).not.toHaveBeenCalled();
    });

    it('sends the code only after the name and a masked-input prompt, in either arrival order', async () => {
        const first = harness();
        first.login.connected();
        first.login.nameSent();
        await Promise.resolve();
        expect(first.sent).toEqual([]);
        first.login.maskChanged(true);
        await Promise.resolve();
        expect(first.sent).toEqual(['012345']);

        let resolve!: (code: string) => void;
        const second = harness(vi.fn(() => new Promise<string>(r => { resolve = r; })));
        second.login.connected();
        second.login.nameSent();
        second.login.maskChanged(true);
        expect(second.sent).toEqual([]);
        resolve('765432');
        await Promise.resolve();
        await Promise.resolve();
        expect(second.sent).toEqual(['765432']);
    });

    it('does not send into a prompt that is no longer masked', async () => {
        const { login, sent } = harness();
        login.connected();
        login.nameSent();
        login.maskChanged(true);
        login.maskChanged(false);
        await Promise.resolve();
        expect(sent).toEqual([]);
    });

    it('sends at most once per connection', async () => {
        const { login, sent, fetchCode } = harness();
        login.connected();
        login.nameSent();
        login.maskChanged(true);
        await Promise.resolve();
        login.maskChanged(false);
        login.maskChanged(true);
        login.nameSent();
        await Promise.resolve();
        expect(sent).toEqual(['012345']);
        expect(fetchCode).toHaveBeenCalledTimes(1);
    });

    it('drops an unsent code on disconnect and fetches a new one on the next connect', async () => {
        const codes = ['000001', '000002'];
        const { login, sent } = harness(vi.fn(async () => codes.shift() ?? ''));
        login.connected();
        login.nameSent();
        await Promise.resolve();
        login.disconnected();
        login.maskChanged(true);
        await Promise.resolve();
        expect(sent).toEqual([]);

        login.connected();
        login.nameSent();
        login.maskChanged(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(sent).toEqual(['000002']);
    });

    it('discards a code that resolves after the connection ended', async () => {
        let resolve!: (code: string) => void;
        const { login, sent } = harness(vi.fn(() => new Promise<string>(r => { resolve = r; })));
        login.connected();
        login.nameSent();
        login.disconnected();
        resolve('999999');
        login.maskChanged(true);
        await Promise.resolve();
        expect(sent).toEqual([]);
    });

    it('reports a failed fetch once and leaves manual entry available', async () => {
        const { login, sent, errors } = harness(vi.fn(async () => { throw new AccountError('login', 'Sign in again.'); }));
        login.connected();
        login.nameSent();
        login.maskChanged(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(sent).toEqual([]);
        expect(errors.map(error => error.kind)).toEqual(['login']);
    });
});

describe('OneTimeCreation: confirmation and grant follow their exact prompts', () => {
    function harness(fetchGrant = vi.fn(async () => '123.012345')) {
        const confirmations: string[] = [];
        const sent: string[] = [];
        const errors: AccountError[] = [];
        const login = new OneTimeCreation({
            fetchGrant,
            sendConfirmation: answer => confirmations.push(answer),
            sendSecret: grant => sent.push(grant),
            onError: error => errors.push(error),
        });
        return { login, confirmations, sent, errors, fetchGrant };
    }

    it('answers y only after the name was sent and the confirmation prompt arrives', () => {
        const { login, confirmations, sent, fetchGrant } = harness();
        login.connected();
        login.prompt('Create Duke? [y/n] : ');
        expect(confirmations).toEqual([]);
        login.nameSent();
        expect(confirmations).toEqual([]);
        login.prompt('Create Duke? [y/n] : ');
        expect(confirmations).toEqual(['y']);
        expect(sent).toEqual([]);
        expect(fetchGrant).not.toHaveBeenCalled();
    });

    it.each([
        'Email address: ',
        'Email address or creation code: ',
    ])('fetches and sends one grant only at the email prompt: %s', async prompt => {
        const { login, confirmations, sent, fetchGrant } = harness();
        login.connected();
        login.prompt(prompt);
        login.nameSent();
        login.prompt(prompt);
        expect(fetchGrant).not.toHaveBeenCalled();
        login.prompt('Create Duke? [y/n] : ');
        expect(confirmations).toEqual(['y']);
        expect(fetchGrant).not.toHaveBeenCalled();
        login.prompt(prompt);
        await Promise.resolve();
        expect(sent).toEqual(['123.012345']);
        expect(fetchGrant).toHaveBeenCalledTimes(1);
    });

    it('never repeats y or a grant on repeated prompts in one connection', async () => {
        const { login, confirmations, sent, fetchGrant } = harness();
        login.connected();
        login.nameSent();
        login.prompt('Create Duke? [y/n] : ');
        login.prompt('Create Duke? [y/n] : ');
        login.prompt('Email address: ');
        login.prompt('Email address or creation code: ');
        login.nameSent();
        await Promise.resolve();
        expect(confirmations).toEqual(['y']);
        expect(sent).toEqual(['123.012345']);
        expect(fetchGrant).toHaveBeenCalledTimes(1);
    });

    it('resets on disconnect and discards a grant that resolves too late', async () => {
        let resolve!: (grant: string) => void;
        const pending = vi.fn(() => new Promise<string>(r => { resolve = r; }));
        const first = harness(pending);
        first.login.connected();
        first.login.nameSent();
        first.login.prompt('Create Duke? [y/n] : ');
        first.login.prompt('Email address: ');
        first.login.disconnected();
        resolve('999.999999');
        await Promise.resolve();
        expect(first.sent).toEqual([]);

        const grants = ['123.000001', '123.000002'];
        const second = harness(vi.fn(async () => grants.shift() ?? ''));
        second.login.connected();
        second.login.nameSent();
        second.login.prompt('Create Duke? [y/n] : ');
        second.login.prompt('Email address: ');
        await Promise.resolve();
        second.login.disconnected();
        second.login.connected();
        second.login.nameSent();
        second.login.prompt('Create Duke? [y/n] : ');
        second.login.prompt('Email address or creation code: ');
        await Promise.resolve();
        await Promise.resolve();
        expect(second.sent).toEqual(['123.000001', '123.000002']);
        expect(second.confirmations).toEqual(['y', 'y']);
    });

    it('reports a failed fetch once and leaves manual code entry available', async () => {
        const { login, sent, errors, fetchGrant } = harness(vi.fn(async () => { throw new AccountError('unavailable', 'fixed failure'); }));
        login.connected();
        login.nameSent();
        login.prompt('Create Duke? [y/n] : ');
        login.prompt('Email address: ');
        login.prompt('Email address: ');
        await Promise.resolve();
        await Promise.resolve();
        expect(sent).toEqual([]);
        expect(errors.map(error => error.message)).toEqual(['fixed failure']);
        expect(fetchGrant).toHaveBeenCalledTimes(1);
    });

    it('passes a grant-request name conflict through the email-prompt error path', async () => {
        const creation: CreationTarget = { accountId: '42', port: 8000, name: 'Duke', csrf: 'csrf-one' };
        const fetchImpl: Fetch = async () => json({ error: 'name_taken' }, { status: 409 });
        const { login, sent, errors } = harness(vi.fn(createGrantSource(creation, fetchImpl)));
        login.connected();
        login.nameSent();
        login.prompt('Create Duke? [y/n] : ');
        login.prompt('Email address: ');
        await vi.waitFor(() => expect(errors).toHaveLength(1));
        expect(sent).toEqual([]);
        expect(errors.map(error => ({ kind: error.kind, message: error.message }))).toEqual([{
            kind: 'name_taken',
            message: 'Duke is already taken. Choose another name on your account page.',
        }]);
    });

    it('does nothing when an existing name leads to a password prompt instead', async () => {
        const { login, confirmations, sent, fetchGrant } = harness();
        login.connected();
        login.nameSent();
        login.prompt('Password: ');
        await Promise.resolve();
        expect(confirmations).toEqual([]);
        expect(sent).toEqual([]);
        expect(fetchGrant).not.toHaveBeenCalled();
    });
});

describe('hung account requests', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // A request that only ends when its AbortSignal fires, as a real fetch does.
    const hung: Fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

    it('ends a hung metadata request in a retryable error instead of waiting forever', async () => {
        const result = fetchOwnedCharacter(8000, 123, hung).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_000);
        const error = await result;
        expect(error).toBeInstanceOf(AccountError);
        expect(error).toMatchObject({ kind: 'unavailable' });
    });

    it('ends a hung code request the same way and leaks nothing', async () => {
        const owned: OwnedCharacter = { accountId: '42', idnum: 123, port: 8000, name: 'Duke', csrf: 'csrf-one' };
        const result = createCodeSource(owned, hung)().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_000);
        const error = await result;
        expect(error).toMatchObject({ kind: 'unavailable' });
        expect(String(error)).not.toContain('csrf-one');
    });

    it('also bounds a response whose body never finishes', async () => {
        const stalledBody: Fetch = (_input, init) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
        })));
        const result = fetchOwnedCharacter(8000, 123, stalledBody).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result).toMatchObject({ kind: 'unavailable' });
    });

    it('lets the page offer Retry: a hung check yields an account failure, no brand', async () => {
        const { tymeBrandForPage } = await import('../src/tyme-brand');
        const page = tymeBrandForPage('?port=8000&character=123', hung);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await page).toEqual({ accountFailure: 'unavailable' });
    });
});

describe('AccountNameHandoff: the name goes out once, by the client or the player', () => {
    function handoff() {
        const events: string[] = [];
        const h = new AccountNameHandoff({
            name: 'Tavrenna',
            sendName: () => events.push('send'),
            nameSent: () => events.push('nameSent'),
            cancelTimer: () => events.push('cancel'),
        });
        h.connected();
        return { h, events };
    }

    it('sends the name as soon as the game asks for it, and the timer then sends nothing', () => {
        const { h, events } = handoff();
        h.prompt('Welcome to A Moment in Tyme');
        expect(events).toEqual([]);
        h.prompt('By what name do you wish to be known? ');
        expect(events).toEqual(['cancel', 'send', 'nameSent']);
        expect(h.timer()).toBe(false);
        h.prompt('By what name do you wish to be known? ');
        expect(events).toEqual(['cancel', 'send', 'nameSent']);
    });

    it('lets the timer send the name when no prompt was recognised', () => {
        const { h, events } = handoff();
        expect(h.timer()).toBe(true);
        h.prompt('By what name do you wish to be known? ');
        h.playerInput('Tavrenna');
        expect(events).toEqual([]);
    });

    it('never sends the name after the player typed first; their own matching name still continues the flow', () => {
        const { h, events } = handoff();
        h.playerInput('  tavrenna ');
        h.prompt('By what name do you wish to be known? ');
        expect(h.timer()).toBe(false);
        expect(events).toEqual(['cancel', 'nameSent']);
    });

    it('stands down entirely when the player types something else', () => {
        const { h, events } = handoff();
        h.playerInput('test');
        h.prompt('By what name do you wish to be known? ');
        expect(h.timer()).toBe(false);
        expect(events).toEqual(['cancel']);
    });

    it('starts over on the next connection', () => {
        const { h, events } = handoff();
        h.playerInput('test');
        h.connected();
        h.prompt('By what name do you wish to be known? ');
        expect(events).toEqual(['cancel', 'cancel', 'send', 'nameSent']);
    });
});
