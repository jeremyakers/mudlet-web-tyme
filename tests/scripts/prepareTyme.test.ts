// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import {
    SOURCE_REPOSITORY,
    generateTymeBuildInputs,
    renderSourcePage,
    renderTymeManifests,
    resolveSourceCommit,
} from '../../scripts/prepare-tyme.mjs';

const fixtureRoots: string[] = [];
afterAll(() => {
    for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'tyme-prepare-'));
    fixtureRoots.push(root);
    mkdirSync(path.join(root, 'public'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    mkdirSync(path.join(root, 'src/assets/fonts/bitstream-vera-sans'), { recursive: true });
    mkdirSync(path.join(root, 'src/assets/fonts/bitstream-vera-sans-mono'), { recursive: true });
    mkdirSync(path.join(root, 'src/assets/fonts/ubuntu'), { recursive: true });
    writeFileSync(path.join(root, 'public/manifest.webmanifest'), `${JSON.stringify({
        name: 'Mudlet Web',
        short_name: 'Mudlet Web',
        description: 'Mudlet in your browser.',
        start_url: './',
        scope: './',
        display: 'standalone',
        icons: [{ src: './icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    }, null, 2)}\n`);
    writeFileSync(path.join(root, 'src/tyme-enabled-ports.json'), `${JSON.stringify([
        { port: 8000, label: 'Testport' },
        { port: 9696, label: 'Builderport' },
    ], null, 2)}\n`);
    for (const name of ['bitstream-vera-sans/COPYRIGHT.TXT', 'bitstream-vera-sans-mono/COPYRIGHT.TXT', 'ubuntu/LICENCE.txt', 'ubuntu/copyright.txt']) {
        writeFileSync(path.join(root, 'src/assets/fonts', name), 'stub notice\n');
    }
    writeFileSync(path.join(root, 'LICENSE'), 'GNU General Public License\n');
    writeFileSync(path.join(root, 'scripts/tyme-source.template.html'),
        '<html><a href="{{TREE_URL}}">Complete source on GitHub</a><a href="{{ARCHIVE_URL}}" download>Download source</a>'
        + '<a href="./LICENSE">license</a><a href="./licenses/ubuntu-LICENCE.txt">notices</a><a href="/play/">Return to Play</a></html>');
    return root;
}

const COMMIT = 'f1xture0commit0notarealhash';

describe('generateTymeBuildInputs', () => {
    it('regenerates the default manifest with Tyme icons plus one launch manifest per port', () => {
        const root = fixtureRoot();
        generateTymeBuildInputs(root, { sourceCommit: COMMIT, yarnVersion: '1.22.22' });

        const defaultManifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
        expect(defaultManifest.name).toBe('Mudlet Web');
        expect(defaultManifest.icons).toEqual([
            { src: './icon-tyme-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: './icon-tyme-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: './icon-tyme-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ]);

        const portManifest = JSON.parse(readFileSync(path.join(root, 'public/manifest-8000.webmanifest'), 'utf8'));
        expect(portManifest.id).toBe('./?port=8000');
        expect(portManifest.name).toBe('A Moment in Tyme — Testport');
        expect(portManifest.short_name).toBe('Tyme Testport');
        expect(portManifest.start_url).toBe('./?port=8000');
        expect(portManifest.scope).toBe('./');
        expect(readFileSync(path.join(root, 'public/manifest-9696.webmanifest'), 'utf8'))
            .toContain('"name": "A Moment in Tyme — Builderport"');
    });

    it('ships the source page, license copies and provenance pinned to the built commit', () => {
        const root = fixtureRoot();
        generateTymeBuildInputs(root, { sourceCommit: COMMIT, yarnVersion: '1.22.22' });

        const page = readFileSync(path.join(root, 'public/source.html'), 'utf8');
        expect(page).toContain(`${SOURCE_REPOSITORY}/tree/${COMMIT}`);
        expect(page).toContain(`${SOURCE_REPOSITORY}/archive/${COMMIT}.tar.gz`);
        expect(page).toContain('Complete source on GitHub');
        expect(page).toContain('Download source');
        expect(page).toContain('href="./LICENSE"');
        expect(page).toContain('href="./licenses/ubuntu-LICENCE.txt"');
        expect(page).toContain('Return to Play');
        // The shipped template in this repository keeps the labels it renders.
        const checkedInTemplate = readFileSync(resolve(__dirname, '../../scripts/tyme-source.template.html'), 'utf8');
        expect(checkedInTemplate).toContain('Complete source on GitHub');
        expect(checkedInTemplate).toContain('Download source');
        expect(checkedInTemplate).toContain('Return to Play');
        expect(readFileSync(path.join(root, 'public/LICENSE'), 'utf8')).toContain('GNU General Public License');
        expect(readFileSync(path.join(root, 'public/licenses/bitstream-vera-sans-COPYRIGHT.txt'), 'utf8')).toBe('stub notice\n');

        const provenance = JSON.parse(readFileSync(path.join(root, 'public/build-provenance.json'), 'utf8'));
        expect(provenance.sourceRepository).toBe(SOURCE_REPOSITORY);
        expect(provenance.sourceCommit).toBe(COMMIT);
        expect(provenance.yarn).toBe('1.22.22');
        expect(provenance.enabledPortsSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(provenance).not.toHaveProperty('brandPatchSha256');
        expect(provenance).not.toHaveProperty('sourceArchiveSha256');
    });

    it('keeps generic fork links when no commit is available', () => {
        const root = fixtureRoot();
        generateTymeBuildInputs(root, { sourceCommit: '', yarnVersion: undefined });

        const page = readFileSync(path.join(root, 'public/source.html'), 'utf8');
        expect(page).toContain(`<a href="${SOURCE_REPOSITORY}">Complete source on GitHub</a>`);
        expect(page).toContain(`<a href="${SOURCE_REPOSITORY}" download>Download source</a>`);
        expect(page).not.toContain('/tree/');
        expect(readFileSync(path.join(root, 'public/build-provenance.json'), 'utf8')).toContain('"sourceCommit": null');
    });
});

describe('renderers', () => {
    it('replaces both source-page URL placeholders and nothing else', () => {
        const page = renderSourcePage('t={{TREE_URL}} a={{ARCHIVE_URL}}', {
            treeUrl: `${SOURCE_REPOSITORY}/tree/x`,
            archiveUrl: `${SOURCE_REPOSITORY}/archive/x.tar.gz`,
        });
        expect(page).not.toContain('{{');
    });

    it('keeps the stock manifest metadata and ports out of the default manifest', () => {
        const { defaultManifest, perPort } = renderTymeManifests('{"name":"Mudlet Web"}', []);
        expect(defaultManifest).toContain('"name": "Mudlet Web"');
        expect(defaultManifest).toContain('"./icon-tyme-192.png"');
        expect(perPort).toEqual([]);
    });
});

describe('resolveSourceCommit', () => {
    it('does not use an enclosing checkout as an archive source identity', () => {
        // Given a source directory without its own Git metadata inside a checkout,
        // when resolving its identity, then it must not inherit the enclosing HEAD.
        expect(resolveSourceCommit(resolve(__dirname, '..'), {})).toBe('');
    });

    it('honours SOURCE_COMMIT above git, and reports no commit without either', () => {
        expect(resolveSourceCommit('/', { SOURCE_COMMIT: 'envsha' })).toBe('envsha');
        // A dependency-free fixture directory has no checkout to interrogate.
        const scratch = mkdtempSync(path.join(tmpdir(), 'tyme-env-'));
        fixtureRoots.push(scratch);
        expect(resolveSourceCommit(scratch)).toBe('');
    });
});
