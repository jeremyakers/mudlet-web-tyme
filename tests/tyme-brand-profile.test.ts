import { describe, expect, it } from 'vitest';
import { brandConnectionData, matchBrandProfile, type BrandConfig } from '../src/branding';
import type { MudConnection } from '../src/storage/schema';

const brand: BrandConfig = {
    appName: 'A Moment in Tyme',
    proxyUrl: 'wss://tymemud.com/play/ws/8000',
    mud: { mode: 'mud', name: 'A Moment in Tyme — Testport', host: 'tymemud.com', port: 8000 },
};

describe('Tyme branded profiles', () => {
    it('stamps the selected proxy onto a managed connection', () => {
        // Given a brand with a fixed game and WebSocket endpoint.
        // When its managed connection seed is created.
        const seed = brandConnectionData(brand);

        // Then the saved profile cannot retain an earlier port's proxy.
        expect(seed).toMatchObject({
            name: 'A Moment in Tyme — Testport',
            host: 'tymemud.com',
            port: 8000,
            proxyUrl: 'wss://tymemud.com/play/ws/8000',
        });
    });

    it('does not reuse another named port profile in single mode', () => {
        // Given an existing profile belonging to a different game port.
        const other: MudConnection = {
            id: 'port-9696',
            name: 'A Moment in Tyme — Builderport',
            mode: 'mud',
            host: 'tymemud.com',
            port: 9696,
            proxyUrl: 'wss://tymemud.com/play/ws/9696',
        };

        // When the 8000 brand looks for its existing profile.
        const match = matchBrandProfile([other], brand);

        // Then the unrelated saved profile is not selected.
        expect(match).toBeUndefined();
    });

    it('finds the same target profile when returning to a port', () => {
        // Given a previously saved 8000 profile, already re-stamped by the
        // brand on an earlier login.
        const existing: MudConnection = {
            id: 'stable-8000-id',
            name: 'A Moment in Tyme — MM32 (old label)',
            mode: 'mud',
            host: 'tymemud.com',
            port: 8000,
            proxyUrl: 'wss://tymemud.com/play/ws/8000',
        };

        // When the 8000 brand is opened again.
        const match = matchBrandProfile([existing], brand);

        // Then its stable browser identity is retained for re-stamping on the
        // target identity (host+port), not on the display name.
        expect(match?.id).toBe('stable-8000-id');
    });

    it('keeps the same profile when the display label changes between builds', () => {
        // Given the saved 8000 profile under the previous picker's label.
        const existing: MudConnection = {
            id: 'stable-8000-id',
            name: 'A Moment in Tyme — MM32 (8000)',
            mode: 'mud',
            host: 'tymemud.com',
            port: 8000,
            proxyUrl: 'wss://tymemud.com/play/ws/8000',
        };
        const renamed: BrandConfig = {
            ...brand,
            mud: { ...brand.mud, mode: 'mud', name: 'A Moment in Tyme — Testport', host: 'tymemud.com', port: 8000 } as BrandConfig['mud'],
        };

        // When the renamed brand looks for its game's profile.
        const match = matchBrandProfile([existing], renamed);

        // Then the label rename does not orphan the saved profile: the target
        // identity (host+port) is what a profile is stable per.
        expect(match?.id).toBe('stable-8000-id');
    });
});

describe('Tyme per-account managed profiles', () => {
    const mud: NonNullable<BrandConfig['mud']> = { mode: 'mud', name: 'Duke — Testport', host: 'tymemud.com', port: 8000 };
    const account: BrandConfig = { ...brand, profileKey: 'acct:42:8000:123', mud };
    const guestProfile: MudConnection = {
        id: 'guest-8000', name: 'A Moment in Tyme — Testport', mode: 'mud', host: 'tymemud.com', port: 8000,
        proxyUrl: 'wss://tymemud.com/play/ws/8000',
    };
    const dukeProfile: MudConnection = {
        ...guestProfile, id: 'duke', name: 'Duke — Testport', brandProfileKey: 'acct:42:8000:123',
    };

    it('stamps the stable key on the managed profile seed', () => {
        expect(brandConnectionData(account)).toMatchObject({ brandProfileKey: 'acct:42:8000:123' });
        expect(brandConnectionData(brand)).not.toHaveProperty('brandProfileKey');
    });

    it('never lets an account launch adopt the guest profile by host and port', () => {
        expect(matchBrandProfile([guestProfile], account)).toBeUndefined();
    });

    it('never lets a guest launch re-stamp an account profile', () => {
        expect(matchBrandProfile([dukeProfile], brand)).toBeUndefined();
        expect(matchBrandProfile([dukeProfile, guestProfile], brand)?.id).toBe('guest-8000');
    });

    it('finds the same profile after a rename because the key, not the label, is the identity', () => {
        const renamed = { ...account, mud: { ...mud, name: 'Duchess — Testport' } };
        expect(matchBrandProfile([guestProfile, dukeProfile], renamed)?.id).toBe('duke');
    });

    it('keeps two characters of one game in separate profiles', () => {
        const elayne: BrandConfig = { ...account, profileKey: 'acct:42:8000:124' };
        expect(matchBrandProfile([dukeProfile], elayne)).toBeUndefined();
    });
});
