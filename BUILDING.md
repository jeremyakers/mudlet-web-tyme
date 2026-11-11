# Building the Tyme browser client

This repository contains the complete browser client source: the Mudlet
Web sources, the Tyme branding, icons and enabled-port configuration. No
separate patch, archive or second checkout is needed.

Use Node.js 22 and Corepack Yarn 1.x, then from this directory:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn install --frozen-lockfile
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn build
```

`yarn build` first runs `scripts/prepare-tyme.mjs`, which regenerates the Tyme
manifests, the source-and-licenses page, and the license/font notice copies
under `public/` from files checked in here; TypeScript and Vite then produce
the production client in `dist/`.

When building a downloaded source archive without Git metadata, set
`SOURCE_COMMIT` to the archive's full commit SHA to retain the exact source links.
