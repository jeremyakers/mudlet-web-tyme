import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import './ui/components/components.css';
import { MudletWebApp } from './MudletWebApp';
import { credentialVault } from './vault/CredentialVault';
import { VaultModal } from './ui/VaultModal';
import { installVault } from './vault/vaultAccess';
import { installVaultHelpTopic } from './vault/vaultHelpTopic';
import { tymeBrandFromSearch, TymePortError } from './tyme-brand';
import './tyme-brand.css';

const tymeBrand = tymeBrandFromSearch(window.location.search);
if (tymeBrand?.mud?.mode === 'mud') {
    // Only a validated, configured brand creates a manifest link. The static
    // standalone document advertises no invalid portless launch, while the
    // stock library/default manifest file remains untouched for other users.
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = `./manifest-${tymeBrand.mud.port}.webmanifest`;
    document.head.append(manifest);
}

// The stock app is just MudletWebApp with no brand — branded builds import
// MudletWebApp from the library entry and pass their own BrandConfig. Page
// bootstrap (VFS service worker, pinch-zoom guard) happens inside MudletWebApp.
//
// The credential vault is wired up here and nowhere else. It exists to keep many
// profiles' saved logins apart, which a single-game branded build has no use
// for, so the library entry must not pull it in — and these two imports are the
// only ones anywhere that name it, which is what keeps it out of `dist-lib`
// entirely rather than merely unused there. See `vault/vaultAccess`.
installVault(credentialVault, VaultModal);
installVaultHelpTopic();

// A vault the player kept unlocked on this device opens before the first
// render, so a cold auto-connect reads its passwords instead of asking. It is
// one IndexedDB read; the cap only guards against a wedged database.
const REMEMBERED_UNLOCK_WAIT_MS = 1500;
void Promise.race([
    credentialVault.restoreOnThisDevice(),
    new Promise(resolve => setTimeout(resolve, REMEMBERED_UNLOCK_WAIT_MS)),
]).finally(() => {
    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            {tymeBrand ? <MudletWebApp brand={tymeBrand} /> : <TymePortError />}
        </StrictMode>,
    );
});
