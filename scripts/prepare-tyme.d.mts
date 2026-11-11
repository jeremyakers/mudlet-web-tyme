// Types for prepare-tyme.mjs, so tests/scripts/prepareTyme.test.ts
// type-checks without allowJs.
export const SOURCE_REPOSITORY: string;

export interface TymePort {
    port: number;
    label: string;
}

export function resolveSourceCommit(
    root?: string,
    env?: Record<string, string | undefined>,
): string;

export function renderTymeManifests(
    defaultManifestText: string,
    ports: TymePort[],
): { defaultManifest: string; perPort: Array<{ port: number; manifest: string }> };

export function renderSourcePage(
    template: string,
    urls: { treeUrl: string; archiveUrl: string },
): string;

export function generateTymeBuildInputs(
    root: string,
    options?: { sourceCommit?: string; yarnVersion?: string },
): void;
