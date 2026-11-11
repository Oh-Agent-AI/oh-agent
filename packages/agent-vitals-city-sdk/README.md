# @agent-vitals/city-sdk

Version 0.1.0 is a pre-release SDK for data-only City mini-games. It provides
versioned layout and mount contracts, validation diagnostics, deterministic
rule execution, and headless playtest evidence. It does not load executable
content, access the host, or provide a general 3D game engine.

## Build

Requires Node.js 20 or newer. Install this package's development dependencies,
then run these commands from the SDK package directory. The UI's `file:` link
does not install this package's build-time dependencies, so build the SDK before
running the City UI's typecheck or production build in a clean checkout.

```sh
cd packages/agent-vitals-city-sdk
npm ci
npm run typecheck
npm run build
npm test
npm run pack:check
```

The package emits bundled ESM entry points and TypeScript declarations under
`dist/`. The npm package also includes the `oh-agent-sdk` command-line entry
point. Tests, source files, build scripts, and local dependencies are excluded
from the npm tarball. `npm pack --dry-run` is a packaging check; it does not
publish.

## CLI quick start

```sh
oh-agent-sdk init app-game ./my-app-game
oh-agent-sdk init city-minigame ./my-city-game
oh-agent-sdk validate ./my-city-game
oh-agent-sdk playtest ./my-city-game --seed 42
oh-agent-sdk pack ./my-city-game --out ./my-city-game.ohcity.json
oh-agent-sdk verify ./my-city-game.ohcity.json
oh-agent-sdk init city-world ./my-world --generator arid-dunes
oh-agent-sdk validate-world ./my-world
oh-agent-sdk asset inspect ./models/bridge.glb
oh-agent-sdk asset import ./my-city-game ./models/bridge.glb --asset-id bridge
oh-agent-sdk asset verify ./my-city-game
```

`app-game` creates a Vite WebView starter wired to the local `@agent-vitals/app-sdk` checkout. It demonstrates App Game startup, host lifecycle, and locale. The generated UI is not registered or installed by this command; official plugin registration, descriptor grants, and desktop distribution remain host-controlled.

To consume an isolated App SDK tarball, run `npm pack` in `packages/agent-vitals-app-sdk`, then pass its `.tgz` path with `oh-agent-sdk init app-game ./my-app-game --app-sdk-tarball /absolute/path/agent-vitals-app-sdk-0.0.0.tgz`. This supports local consumer validation and controlled distribution; the App SDK remains private and is not published to a registry.

The starter project contains `layout.json`, `game.json`, `mount.json`,
`scene.json`, and `trace.json`. `validate` checks the layout, declarative game
rules, slot bindings, entry anchor, and any scene asset refs against the local
catalog. `playtest` runs the trace through the deterministic
headless runtime and exits nonzero unless the expected success outcome is
reached. `pack` creates an unsigned JSON development artifact containing the
validated layout, game, mount, and (when present) project asset catalog plus
GLB files encoded as base64. Binary manifest digests cover the original GLB
bytes; `verify` checks decoded length, digest, and bounded GLB structure.
`sync-refs` refreshes mount digests after layout or rule edits. The artifact
cannot be installed or published. The CLI never loads executable content and
does not connect to the desktop host.
`city-world` scaffolds and validates the public world profile contract only; it
does not run the City generator or create an installable world package.
`asset inspect` reads one explicitly named local GLB of at most 64 MiB, runs the
bounded in-memory structural inspector, and computes a SHA-256 digest of the
bytes it read. `asset import` adds a checked GLB to a project-local,
content-addressed `assets/` directory and `assets/catalog.json`; `asset verify`
rechecks the catalog, bytes, digest, and GLB structure. `pack` includes imported
files and their project catalog in an unsigned development artifact, but does
not create Creator model instances, verify a publisher signature, publish, or
install them.

## Entry points

- `@agent-vitals/city-sdk`: contracts, content parsing, layout/mount validation,
  anchor, scene object, and validated asset catalog queries, asset reference
  checks, data-only City skin and world-profile validation, bounded in-memory GLB
  v2 inspection, package manifest validation and canonical JSON, rule
  compilation, and headless playtests.
- `@agent-vitals/city-sdk/runtime`: rule compilation, run creation, and
  headless playtests.

The package is not yet published. Its API is pre-release and may change before
the first public release. Package validation does not replace manifest digest
verification, package signatures, installation consent, or runtime sandboxing.
Published-package asset catalog APIs operate on caller-provided metadata
snapshots; they do not scan local storage. The CLI's separate project asset
catalog validates its metadata, while `asset verify` reads the referenced local
files explicitly. The GLB helper checks container boundaries, embedded references, supported scalar/vector
accessor ranges, and basic mesh metadata; it rejects sparse/matrix accessors,
declared extensions, and multi-buffer assets. It is not a complete glTF validator
or a trusted package importer.
