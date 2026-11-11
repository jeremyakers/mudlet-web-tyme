import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { getBrand, type BrandConfig, type LandingProps } from './branding';
import { AboutModal } from './ui/AboutModal';
import { Button } from './ui/components';
import enabledPorts from './tyme-enabled-ports.json';
import logoUrl from './tyme-banner.png?url';

let initialConnectAttempted = false;

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

export function tymeBrandFromSearch(search: string): BrandConfig | null {
    const selections = new URLSearchParams(search).getAll('port');
    if (selections.length !== 1) return null;
    const selected = enabledPorts.find(candidate => String(candidate.port) === selections[0]);
    if (!selected) return null;

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
            name: `A Moment in Tyme — ${selected.label}`,
            host: 'tymemud.com',
            port: selected.port,
        },
        profileMode: 'single',
        packages: [],
        Landing: TymeLanding,
    };
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
