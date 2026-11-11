#!/usr/bin/env node
// Generate the standalone client's manifests, source links and license notices.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const SOURCE_REPOSITORY = 'https://github.com/jeremyakers/mudlet-web-tyme';

const PWA_ICONS = [
    { src: './icon-tyme-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-tyme-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-tyme-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

const FONT_NOTICES = [
    ['src/assets/fonts/bitstream-vera-sans/COPYRIGHT.TXT', 'bitstream-vera-sans-COPYRIGHT.txt'],
    ['src/assets/fonts/bitstream-vera-sans-mono/COPYRIGHT.TXT', 'bitstream-vera-sans-mono-COPYRIGHT.txt'],
    ['src/assets/fonts/ubuntu/LICENCE.txt', 'ubuntu-LICENCE.txt'],
    ['src/assets/fonts/ubuntu/copyright.txt', 'ubuntu-copyright.txt'],
];

export function resolveSourceCommit(root = REPO_ROOT, env = process.env) {
    if (env.SOURCE_COMMIT) return env.SOURCE_COMMIT;
    if (!existsSync(path.join(root, '.git'))) return ''; // An archive must not inherit a parent checkout's identity.
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
    } catch {
        // An archive checkout has no .git; the generic fork links remain true.
        return '';
    }
}

function resolveYarnVersion(root) {
    try {
        return execFileSync('corepack', ['yarn', '--version'], {
            cwd: root,
            env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
    } catch {
        return '';
    }
}

export function renderTymeManifests(defaultManifestText, ports) {
    const template = JSON.parse(defaultManifestText);
    template.icons = PWA_ICONS;
    const defaultManifest = `${JSON.stringify(template, null, 2)}\n`;
    const perPort = ports.map(selected => {
        const launch = `./?port=${selected.port}`;
        const manifest = {
            ...template,
            id: launch,
            name: `A Moment in Tyme — ${selected.label}`,
            short_name: `Tyme ${selected.label}`,
            description: `A Moment in Tyme — ${selected.label}, in your browser with Mudlet Web.`,
            start_url: launch,
            scope: './',
        };
        return { port: selected.port, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
    });
    return { defaultManifest, perPort };
}

export function renderSourcePage(template, { treeUrl, archiveUrl }) {
    return template.replaceAll('{{TREE_URL}}', treeUrl).replaceAll('{{ARCHIVE_URL}}', archiveUrl);
}

export function generateTymeBuildInputs(root, { sourceCommit, yarnVersion } = {}) {
    const commit = sourceCommit ?? resolveSourceCommit(root);
    const treeUrl = commit ? `${SOURCE_REPOSITORY}/tree/${commit}` : SOURCE_REPOSITORY;
    const archiveUrl = commit ? `${SOURCE_REPOSITORY}/archive/${commit}.tar.gz` : SOURCE_REPOSITORY;

    const manifestText = readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8');
    const portsText = readFileSync(path.join(root, 'src/tyme-enabled-ports.json'), 'utf8');
    const manifests = renderTymeManifests(manifestText, JSON.parse(portsText));
    writeFileSync(path.join(root, 'public/manifest.webmanifest'), manifests.defaultManifest);
    for (const entry of manifests.perPort) {
        writeFileSync(path.join(root, `public/manifest-${entry.port}.webmanifest`), entry.manifest);
    }

    const template = readFileSync(path.join(root, 'scripts/tyme-source.template.html'), 'utf8');
    writeFileSync(path.join(root, 'public/source.html'),
        renderSourcePage(template, { treeUrl, archiveUrl }));

    copyFileSync(path.join(root, 'LICENSE'), path.join(root, 'public/LICENSE'));
    mkdirSync(path.join(root, 'public/licenses'), { recursive: true });
    for (const [from, to] of FONT_NOTICES) {
        copyFileSync(path.join(root, from), path.join(root, 'public/licenses', to));
    }

    const provenance = {
        sourceRepository: SOURCE_REPOSITORY,
        sourceCommit: commit || null,
        node: process.version,
    };
    const yarn = yarnVersion ?? resolveYarnVersion(root);
    if (yarn) provenance.yarn = yarn;
    provenance.enabledPortsSha256 = createHash('sha256').update(portsText).digest('hex');
    writeFileSync(path.join(root, 'public/build-provenance.json'),
        `${JSON.stringify(provenance, null, 2)}\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
    generateTymeBuildInputs(REPO_ROOT);
}
