import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { getBrand, isLightTheme, type BrandConfig, type LandingProps } from './branding';
import { AboutModal } from './ui/AboutModal';
import { Button } from './ui/components';
import { useAppStore } from './storage/appStore';
import type { AppSchema, Theme } from './storage/schema';
import { resolveTheme } from './utils/systemTheme';
import enabledPorts from './tyme-enabled-ports.json';
import {
    AccountError, createCodeSource, createGrantSource, fetchCreationTarget, fetchOwnedCharacter,
    type AccountFailure, type CreationTarget, type Fetch, type OwnedCharacter,
} from './tyme-account';
import logoUrl from './tyme-banner.png?url';

let initialConnectAttempted = false;

/** The website owns the launcher default; a profile's own theme still wins in App. */
export function applyTymeSiteTheme(cookie = document.cookie): void {
    const selected = /(?:^|;)\s*olc_theme=([^;]*)/.exec(cookie)?.[1];
    useAppStore.getState().patchClient({ theme: selected === 'light' ? 'light' : 'dark' });
}

/** Mirror only launcher changes back to the website's light/dark cookie. */
export function writeTymeSiteTheme(theme: Theme, target: Document = document): void {
    const selected = isLightTheme(resolveTheme(theme)) ? 'light' : 'dark';
    target.cookie = `olc_theme=${selected};path=/;max-age=31536000;samesite=lax`;
}

/** Output fills the browser window: a profile that never chose a wrap width
 *  wraps at the window edge (0) instead of desktop's fixed 100 columns. A
 *  profile's settings load from its own file when it opens, so this keeps
 *  watching; returns the unsubscribe. */
export function applyTymeFullWidth(): () => void {
    const fill = ({ connectionProfile }: Pick<AppSchema, 'connectionProfile'>) => {
        for (const [id, profile] of Object.entries(connectionProfile)) {
            if (profile.outputWrapAt === undefined) {
                useAppStore.getState().patchConnectionProfile(id, { outputWrapAt: 0 });
            }
        }
    };
    fill(useAppStore.getState());
    return useAppStore.subscribe(fill);
}

export function TymeLanding({ openProfile, ensureBrandProfile, openSettings }: LandingProps) {
    const brand = getBrand();
    const [aboutOpen, setAboutOpen] = useState(false);
    const enter = (connect: boolean) => openProfile(ensureBrandProfile(), connect);

    // This guard belongs to the page, not the landing mount: closing a profile
    // returns here without silently dialing again. A fresh page load tries once.
    useEffect(() => {
        if (initialConnectAttempted) return;
        initialConnectAttempted = true;
        openProfile(ensureBrandProfile(), true);
    }, [ensureBrandProfile, openProfile]);

    return (
        <>
        <div className="connection-screen">
            <div className="connection-panel">
                <div className="connection-panel-tools">
                    <button className="connection-settings-btn" onClick={openSettings} type="button" aria-label="Settings">
                        ⚙
                    </button>
                    <button className="connection-about-btn" onClick={() => setAboutOpen(true)} type="button" aria-label={`About ${brand.appName}`}>
                        <Info size={16} />
                    </button>
                </div>
                <div className="connection-brand">
                    {brand.logoUrl && (
                        <img className="connection-brand-logo" src={brand.logoUrl} alt="" aria-hidden="true" />
                    )}
                    {brand.appName}
                </div>
                {brand.tagline && (
                    <p style={{ textAlign: 'center', opacity: 0.7, marginTop: 4 }}>{brand.tagline}</p>
                )}
                <form
                    className="connection-form"
                    onSubmit={event => { event.preventDefault(); enter(true); }}
                    style={{ maxWidth: 320, margin: '24px auto 0', display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                    <Button type="submit" variant="primary">Connect</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => enter(false)}
                        title="Open the profile without connecting — scripts and settings stay available">
                        Open offline
                    </Button>
                </form>
            </div>
        </div>
        {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
        </>
    );
}

/** The enabled game a page URL selects, or null for none or an ambiguous choice. */
function selectedPort(search: string) {
    const selections = new URLSearchParams(search).getAll('port');
    if (selections.length !== 1) return null;
    return enabledPorts.find(candidate => String(candidate.port) === selections[0]) ?? null;
}

/** `?character=<idnum>`: null when absent, `invalid` unless exactly one plain
 *  decimal id. The id is a non-secret selector; the website decides ownership. */
export function tymeCharacterFromSearch(search: string): number | null | 'invalid' {
    const values = new URLSearchParams(search).getAll('character');
    if (values.length === 0) return null;
    if (values.length > 1 || !/^\d{1,10}$/.test(values[0])) return 'invalid';
    const idnum = Number(values[0]);
    return idnum <= 2147483647 ? idnum : 'invalid';
}

/** `?create=<name>`: null when absent, `invalid` unless exactly one plausible
 *  new-character name. The website repeats validation and normalizes it. */
export function tymeCreationFromSearch(search: string): string | null | 'invalid' {
    const values = new URLSearchParams(search).getAll('create');
    if (values.length === 0) return null;
    return values.length === 1 && /^[A-Za-z']{2,20}$/.test(values[0]) ? values[0] : 'invalid';
}

export function tymeBrandFromSearch(
    search: string,
    owned?: OwnedCharacter,
    fetchCode?: () => Promise<string>,
    creation?: CreationTarget,
    fetchGrant?: () => Promise<string>,
): BrandConfig | null {
    const selected = selectedPort(search);
    if (!selected) return null;
    const idnum = tymeCharacterFromSearch(search);
    const create = tymeCreationFromSearch(search);
    if ((idnum !== null && create !== null) || create === 'invalid') return null;
    if (owned && (owned.port !== selected.port || owned.idnum !== idnum)) return null;
    if (creation && (creation.port !== selected.port || typeof create !== 'string'
        || creation.name !== create[0].toUpperCase() + create.slice(1).toLowerCase())) return null;
    const accountBrand: Partial<BrandConfig> = owned && fetchCode ? {
        // One profile per account, game and character id: stable across renames
        // (the name is only a label) and never shared with the guest profile.
        profileKey: `acct:${owned.accountId}:${selected.port}:${owned.idnum}`,
        documentTitle: `MiT: ${selected.label} - ${owned.name}`,
        tagline: `Wheel of Time — ${selected.label} · ${owned.name}`,
        oneTimeLogin: { account: owned.name, fetchCode },
    } : creation && fetchGrant ? {
        profileKey: `acct:${creation.accountId}:${selected.port}:new:${creation.name}`,
        documentTitle: `MiT: ${selected.label} - Create ${creation.name}`,
        tagline: `Wheel of Time — ${selected.label} · Create ${creation.name}`,
        oneTimeCreation: { account: creation.name, fetchGrant },
    } : {};

    return {
        appName: 'A Moment in Tyme',
        documentTitle: `MiT: ${selected.label}`,
        logoUrl,
        tagline: `Wheel of Time — ${selected.label}`,
        aboutText: 'Mudlet Web is GPL-2.0-or-later.',
        repoUrl: undefined,
        buildSourceUrl: './source.html',
        proxyUrl: `wss://tymemud.com/play/ws/${selected.port}`,
        mud: {
            mode: 'mud',
            name: owned ? `${owned.name} — ${selected.label}`
                : creation ? `Create ${creation.name} — ${selected.label}` : `A Moment in Tyme — ${selected.label}`,
            host: 'tymemud.com',
            port: selected.port,
        },
        profileMode: 'single',
        profileDefaults: { outputWrapAt: 0 },
        packages: [],
        Landing: TymeLanding,
        ...accountBrand,
    };
}

export type TymePage =
    | { brand: BrandConfig }
    | { accountFailure: AccountFailure; creationName?: string }
    | null;

/** Resolve the page URL to a brand before anything renders. A `character`
 *  selector must be confirmed by the website first: on any failure the page
 *  explains the failure and opens no profile and no connection. */
export async function tymeBrandForPage(search: string, fetchImpl: Fetch = fetch): Promise<TymePage> {
    const selected = selectedPort(search);
    if (!selected) return null;
    const idnum = tymeCharacterFromSearch(search);
    const create = tymeCreationFromSearch(search);
    if (idnum === 'invalid' || create === 'invalid' || (idnum !== null && create !== null)) {
        return { accountFailure: 'invalid' };
    }
    if (idnum === null && create === null) {
        const brand = tymeBrandFromSearch(search);
        return brand ? { brand } : null;
    }
    try {
        if (create !== null) {
            const creation = await fetchCreationTarget(selected.port, create, fetchImpl);
            const brand = tymeBrandFromSearch(search, undefined, undefined, creation, createGrantSource(creation, fetchImpl));
            return brand ? { brand } : { accountFailure: 'login' };
        }
        if (idnum === null) return { accountFailure: 'invalid' };
        const owned = await fetchOwnedCharacter(selected.port, idnum, fetchImpl);
        const brand = tymeBrandFromSearch(search, owned, createCodeSource(owned, fetchImpl));
        return brand ? { brand } : { accountFailure: 'login' };
    } catch (error) {
        const kind = error instanceof AccountError ? error.kind : 'unavailable';
        return {
            accountFailure: kind,
            ...(kind === 'name_taken' && typeof create === 'string' ? {
                creationName: create[0].toUpperCase() + create.slice(1).toLowerCase(),
            } : {}),
        };
    }
}

export function TymeAccountError({ kind, creationName }: { kind: AccountFailure; creationName?: string }) {
    const copy = {
        login: ['Sign in to play this character', 'This character is not available to your signed-in account. Sign in, then choose it from the Play page.'],
        name_taken: ['That name is taken', `${creationName ?? 'That name'} is already a character in that game. Choose another name on your account page.`],
        unavailable: ['Could not check your account', 'The account service could not be reached. Nothing was connected.'],
        invalid: ['This character link is not valid', 'Choose a character from the Play page.'],
    }[kind];
    return (
        <div className="connection-screen tyme-port-error">
            <div className="connection-panel">
                <div className="connection-brand">A Moment in Tyme</div>
                <h1>{copy[0]}</h1>
                <p>{copy[1]}</p>
                {kind === 'login' && <p><a href="/login.php">Sign in</a></p>}
                {kind === 'name_taken' && <p><a href="/profile.php">Back to your account</a></p>}
                {kind === 'unavailable' && <p><Button type="button" variant="primary" onClick={() => window.location.reload()}>Retry</Button></p>}
                <p><a href="/play/">Play page</a></p>
                <p><a href="./source.html">Source and licenses</a></p>
            </div>
        </div>
    );
}

export function TymePortError() {
    return (
        <div className="connection-screen tyme-port-error">
            <div className="connection-panel">
                <div className="connection-brand">A Moment in Tyme</div>
                <h1>Browser client unavailable</h1>
                <p>Choose a game from the Play page.</p>
                <p><a href="/play/">Choose a game</a></p>
                <p><a href="./source.html">Source and licenses</a></p>
            </div>
        </div>
    );
}
