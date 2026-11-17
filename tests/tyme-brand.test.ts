import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
    applyTymeFullWidth, applyTymeSiteTheme, TymeAccountError, TymeLanding, tymeBrandForPage, tymeBrandFromSearch, tymeCharacterFromSearch,
    tymeCreationFromSearch, writeTymeSiteTheme,
} from '../src/tyme-brand';
import type { CreationTarget, OwnedCharacter } from '../src/tyme-account';
import { setBrand } from '../src/branding';
import { ConnectionIdContext, useAppStore, useEffectiveTheme } from '../src/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Tyme client port selection', () => {
    it('creates a fixed Testport 8000 target from the enabled port', () => {
        // Given the committed enabled-port list and a selected 8000 URL.
        // When the browser bootstrap parses that URL.
        const brand = tymeBrandFromSearch('?port=8000');

        // Then only the fixed game host and matching built-in WS endpoint are used.
        expect(brand?.mud).toEqual({
            mode: 'mud',
            name: 'A Moment in Tyme — Testport',
            host: 'tymemud.com',
            port: 8000,
        });
        expect(brand?.proxyUrl).toBe('wss://tymemud.com/play/ws/8000');
        expect(brand?.documentTitle).toBe('MiT: Testport');
        expect(brand?.packages).toEqual([]);
        expect(brand?.aboutText).toBe('Mudlet Web is GPL-2.0-or-later.');
        expect(brand?.repoUrl).toBeUndefined();
        expect(brand?.buildSourceUrl).toBe('./source.html');
        expect(brand?.Landing).toBe(TymeLanding);
    });

    it('uses the same fixed branding for Builderport 9696', () => {
        // Given a selected 9696 URL.
        // When the browser bootstrap parses it.
        const brand = tymeBrandFromSearch('?port=9696');

        // Then its profile identity and endpoint differ from 8000.
        expect(brand?.mud).toMatchObject({ port: 9696, name: 'A Moment in Tyme — Builderport' });
        expect(brand?.proxyUrl).toBe('wss://tymemud.com/play/ws/9696');
        expect(brand?.documentTitle).toBe('MiT: Builderport');
    });

    it.each(['', '?port=6969', '?port=8001', '?port=8000&port=9696', '?port=8000;host=evil.invalid'])(
        'rejects a missing, disabled, or ambiguous selection: %s',
        search => {
            // Given an invalid client URL.
            // When the browser bootstrap parses it.
            const brand = tymeBrandFromSearch(search);

            // Then no app target or arbitrary connection is created.
            expect(brand).toBeNull();
        },
    );

    it('ignores attempts to supply a different host or proxy', () => {
        // Given an enabled port plus hostile connection query parameters.
        // When the browser bootstrap parses it.
        const brand = tymeBrandFromSearch('?port=8000&host=evil.invalid&proxyUrl=ws://evil.invalid/');

        // Then only the configured endpoint survives.
        expect(brand?.mud).toMatchObject({ host: 'tymemud.com', port: 8000 });
        expect(brand?.proxyUrl).toBe('wss://tymemud.com/play/ws/8000');
    });
});

describe('Tyme account-owned character launch', () => {
    const owned: OwnedCharacter = { accountId: '42', idnum: 123, port: 8000, name: 'Duke', csrf: 'opaque' };
    const fetchCode = async () => '01234567';

    it('reads only a single decimal character selector', () => {
        expect(tymeCharacterFromSearch('?port=8000')).toBeNull();
        expect(tymeCharacterFromSearch('?port=8000&character=123')).toBe(123);
        for (const bad of ['?character=0x7b', '?character=-1', '?character=', '?character=1&character=2', '?character=99999999999']) {
            expect(tymeCharacterFromSearch(bad)).toBe('invalid');
        }
    });

    it('keys the profile by account, game and character id and shows a friendly name', () => {
        const brand = tymeBrandFromSearch('?port=8000&character=123', owned, fetchCode);

        expect(brand?.profileKey).toBe('acct:42:8000:123');
        expect(brand?.mud).toMatchObject({ host: 'tymemud.com', port: 8000, name: 'Duke — Testport' });
        expect(brand?.documentTitle).toBe('MiT: Testport - Duke');
        expect(brand?.proxyUrl).toBe('wss://tymemud.com/play/ws/8000');
        expect(brand?.oneTimeLogin?.account).toBe('Duke');
    });

    it('keeps the same key when the character is renamed', () => {
        const before = tymeBrandFromSearch('?port=8000&character=123', owned, fetchCode);
        const after = tymeBrandFromSearch('?port=8000&character=123', { ...owned, name: 'Duchess' }, fetchCode);
        expect(after?.profileKey).toBe(before?.profileKey);
        expect(after?.mud?.name).toBe('Duchess — Testport');
    });

    it('separates two characters of one game and the same character across games', () => {
        const other = tymeBrandFromSearch('?port=8000&character=124', { ...owned, idnum: 124, name: 'Elayne' }, fetchCode);
        const elsewhere = tymeBrandFromSearch('?port=9696&character=123', { ...owned, port: 9696 }, fetchCode);
        const keys = [tymeBrandFromSearch('?port=8000&character=123', owned, fetchCode), other, elsewhere].map(b => b?.profileKey);
        expect(new Set(keys).size).toBe(3);
    });

    it('treats server-supplied names as inert text', () => {
        const hostile = '<img src=x onerror=alert(1)>';
        const brand = tymeBrandFromSearch('?port=8000&character=123', { ...owned, name: hostile }, fetchCode);
        expect(brand?.documentTitle).toBe(`MiT: Testport - ${hostile}`);
        expect(brand?.aboutText).toBe('Mudlet Web is GPL-2.0-or-later.');
    });

    it('parses one valid creation name and rejects malformed or repeated selectors', () => {
        expect(tymeCreationFromSearch('?port=8000')).toBeNull();
        expect(tymeCreationFromSearch('?port=8000&create=Duke')).toBe('Duke');
        for (const bad of ['?create=', '?create=x', '?create=Duke%20', '?create=Duke&create=Elayne', '?create=Duke1']) {
            expect(tymeCreationFromSearch(bad)).toBe('invalid');
        }
    });

    it('refuses a URL that names both an existing and a new character without fetching', async () => {
        let called = false;
        const page = await tymeBrandForPage('?port=8000&character=123&create=Duke', async () => {
            called = true;
            throw new Error('must not fetch');
        });
        expect(page).toEqual({ accountFailure: 'invalid' });
        expect(called).toBe(false);
    });

    it('keys a creation profile separately and gives it an ephemeral creation login', () => {
        const creation: CreationTarget = { accountId: '42', port: 8000, name: 'Duke', csrf: 'opaque' };
        const fetchGrant = async () => '123.012345';
        const brand = tymeBrandFromSearch('?port=8000&create=Duke', undefined, undefined, creation, fetchGrant);
        expect(brand?.profileKey).toBe('acct:42:8000:new:Duke');
        expect(brand?.documentTitle).toBe('MiT: Testport - Create Duke');
        expect(brand?.mud).toMatchObject({ name: 'Create Duke — Testport' });
        expect(brand?.oneTimeCreation).toEqual({ account: 'Duke', fetchGrant });
        expect(brand?.oneTimeLogin).toBeUndefined();
    });

    it('keeps a creation-name conflict distinct from a sign-in failure', async () => {
        const page = await tymeBrandForPage('?port=8000&create=duke', async () => new Response(
            JSON.stringify({ error: 'name_taken' }),
            { status: 409, headers: { 'content-type': 'application/json' } },
        ));
        expect(page).toEqual({ accountFailure: 'name_taken', creationName: 'Duke' });
    });

    it('renders a taken-name page with a way back to the account, not a sign-in prompt', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(createElement(TymeAccountError, { kind: 'name_taken', creationName: 'Duke' }));
            });
            expect(container.querySelector('h1')?.textContent).toBe('That name is taken');
            expect(container.textContent).toContain('Duke is already a character in that game. Choose another name on your account page.');
            expect(container.querySelector('a[href="/profile.php"]')?.textContent).toBe('Back to your account');
            expect(container.textContent).not.toContain('Sign in');
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('leaves the guest brand untouched: no key and no credential hook', () => {
        const brand = tymeBrandFromSearch('?port=8000');
        expect(brand?.profileKey).toBeUndefined();
        expect(brand?.oneTimeLogin).toBeUndefined();
    });

    it('refuses metadata for a different target than the URL named', () => {
        expect(tymeBrandFromSearch('?port=8000&character=123', { ...owned, idnum: 7 }, fetchCode)).toBeNull();
        expect(tymeBrandFromSearch('?port=8000&character=123', { ...owned, port: 9696 }, fetchCode)).toBeNull();
    });
});

describe('Tyme website theme cookie', () => {
    const originalClient = useAppStore.getState().client;
    const originalProfiles = useAppStore.getState().connectionProfile;

    afterEach(() => {
        useAppStore.setState({ client: originalClient, connectionProfile: originalProfiles });
        setBrand();
    });

    it('starts new Tyme profiles at full window width', () => {
        expect(tymeBrandFromSearch('?port=8000')?.profileDefaults?.outputWrapAt).toBe(0);
    });

    it('moves profiles that never chose a wrap width to full width, keeping a chosen one', () => {
        useAppStore.setState({
            connectionProfile: { ...originalProfiles, untouched: {}, chosen: { outputWrapAt: 100 } },
        });

        const stop = applyTymeFullWidth();
        stop();

        const profiles = useAppStore.getState().connectionProfile;
        expect(profiles.untouched.outputWrapAt).toBe(0);
        expect(profiles.chosen.outputWrapAt).toBe(100);
    });

    it('applies full width to settings loaded from a profile file when it opens', () => {
        // Existing profiles keep their settings in the profile's own file, which
        // replaces the in-memory entry only when the profile opens.
        const stop = applyTymeFullWidth();
        try {
            useAppStore.getState().hydrateConnectionData('opened', { profile: { fontSize: 14 } });
            useAppStore.getState().hydrateConnectionData('opened-chosen', { profile: { outputWrapAt: 80 } });
        } finally {
            stop();
        }

        const profiles = useAppStore.getState().connectionProfile;
        expect(profiles.opened).toEqual({ fontSize: 14, outputWrapAt: 0 });
        expect(profiles['opened-chosen'].outputWrapAt).toBe(80);
    });

    it('loads the light launcher palette from the site cookie', () => {
        useAppStore.getState().patchClient({ theme: 'dark' });

        applyTymeSiteTheme('other=value; olc_theme=light');

        expect(useAppStore.getState().client.theme).toBe('light');
    });

    it.each(['', 'olc_theme=dark', 'notolc_theme=light'])('defaults an absent, dark, or unrelated cookie to dark: %s', cookie => {
        useAppStore.getState().patchClient({ theme: 'light' });

        applyTymeSiteTheme(cookie);

        expect(useAppStore.getState().client.theme).toBe('dark');
    });

    it('keeps an explicit profile palette ahead of the cookie launcher default', async () => {
        const connectionId = 'theme-profile';
        useAppStore.setState({
            connectionProfile: { ...originalProfiles, [connectionId]: { theme: 'amber' } },
        });
        applyTymeSiteTheme('olc_theme=light');
        const Probe = () => createElement('span', null, useEffectiveTheme());
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => {
                root.render(createElement(ConnectionIdContext.Provider, { value: connectionId }, createElement(Probe)));
            });

            expect(container.textContent).toBe('amber');
            expect(useAppStore.getState().client.theme).toBe('light');
        } finally {
            await act(async () => { root.unmount(); });
            container.remove();
        }
    });

    it('writes the site cookie with the same attributes for light and non-light palettes', () => {
        const target = { cookie: '' } as Document;

        writeTymeSiteTheme('graylight', target);
        expect(target.cookie).toBe('olc_theme=light;path=/;max-age=31536000;samesite=lax');
        writeTymeSiteTheme('amber', target);
        expect(target.cookie).toBe('olc_theme=dark;path=/;max-age=31536000;samesite=lax');
    });
});
