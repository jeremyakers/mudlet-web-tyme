import { describe, expect, it } from 'vitest';
import { TymeLanding, tymeBrandFromSearch } from '../src/tyme-brand';

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
