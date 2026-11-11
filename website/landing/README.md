# Oh Agent · City-first landing

Brand and copy updated to **Oh Agent** on 2026-10-16. Implemented against [the redesign spec](../../docs/LANDING_CITY_FIRST_REDESIGN_SPEC.md). English is the static default; `?lang=zh` selects Chinese. Language preference stays in localStorage. No analytics, accounts, uploaded sessions, external fonts or third-party scripts.

Product overview: [repository README](../../README.md). Public website: <https://ohagent.ai/>.

## Product promise and gameplay scope

“Your agents built it. Now explore it.” The City is an explorable visualization of supported local Agent history, with usage/cost/session analysis as a complementary desktop view. It is not a productivity score or a promise of automatic cost savings.

The production City source includes free-flight practice, ring challenges, free driving, and a jet-roadster VTOL mode. Landing copy distinguishes those implemented desktop modes from the browser-only building exploration and activity replay. Road validation and public desktop release checks are still ongoing. **This landing's `presentation=landing` currently hides the game entry points.** Do not advertise the web demo as playable flying/driving until its entry controls, input help, pause/exit, fixture permissions and browser acceptance are implemented and checked. Free exploration is the current marketing description; a complete open-world game is not a release guarantee.

## Preview

From this directory:

```sh
python3 -m http.server 5180 --bind 127.0.0.1
```

Open `http://127.0.0.1:5180/?lang=zh` or `?lang=en`. Blog pages: `http://127.0.0.1:5180/blog/`, `http://127.0.0.1:5180/blog/multi-agent-shared-notes/`, and `http://127.0.0.1:5180/blog/fleet-auditor-before-hire/`. The page is a static site; the interactive City requires HTTP serving. Opening `index.html` as a local file still offers product images and text. It now explicitly explains that the interactive City needs HTTP, disables its launch button, and avoids a failed iframe fetch or startup timeout.

## Page and data

Hero with the production City frontend → three desktop exploration modes (plane, driving, jet roadster) → data mapping → usage/cost/session illustrations → local privacy → FAQ → per-platform beta downloads, release notes, checksums and public source links.

- The hero embeds the frontend built from `apps/agent-city/ui`. Static fallback/building images use existing English product captures with synthetic sessions; their sample counts are separate from the interactive fixture. The share preview is also a mock-data capture. No personal records are involved. Provenance is in [RELEASE_REVIEW.md](RELEASE_REVIEW.md).
- The visible desktop/tablet hero (over 600 CSS px) starts the real City frontend automatically, unless reduced motion or data saving is requested. Narrow phone views retain explicit entry. `city-host.js` serves deterministic synthetic `city:v2` projections through the production SDK's instance-scoped, same-origin message transport. Default 30 days contains 800 mock sessions; 7 days contains 189. (The sample was 2000 sessions until 2026-10-22; with the current worker planner that is scale tier 5 and took ~25 s to the first model frame, past the startup timeout, so it was cut to tier 2.) The frontend render cap is 4000, so this dataset does not trigger overflow aggregation; this does not change the native data projection's 500-session cap. No local authority, harness logs, generic IPC or SQL access is available.
- First usable toolbar publication confirms renderer readiness. A failed startup, unavailable renderer, missing build or 20-second startup timeout leaves the product preview and an explicit retry. Clicking Close removes the iframe. Hidden/offscreen views receive suspend messages.
- City settings enable keyboard session selection. The sample can show its bounded session fields; host full-session navigation is disabled for fixtures. The production component's `presentation=landing` mode hides game, export and seed controls, and avoids audio warmup. Synthetic seed state stays in memory. No native package install, raw-log access or file-save command is offered by this host.
- Amount cards are clearly labeled illustrations. Amounts stay in USD in both locales; language switching is not currency conversion. API-equivalent estimates, subscriptions and actual charges remain distinct. City currently does not project cost.
- Reduced-motion/narrow-view visitors can opt into City. Desktop uses one live City instance in the hero. Hidden/offscreen suspension and Close are available; no sound starts automatically.

## Build the optional City

```sh
node ../../tools/build-city3d.mjs
```

When dependencies are already installed:

```sh
node ../../tools/build-city3d.mjs --skip-install
```

The builder replaces the generated `city3d/` directory from the current production City source. Commit the rebuilt index and referenced assets together. Preserve generated third-party notices. Desktop requests the City bundle when the hero is visible; narrow/reduced-motion views request it on explicit entry. Passing the initial window to the frontend avoids building the scene twice.

## Verify

```sh
node tools/build-zh.mjs        # regenerate the prerendered Chinese page zh/index.html after editing index.html or i18n.js
node tools/verify-landing.mjs   # also fails if zh/index.html is stale
```

`deploy.sh` regenerates `/zh/`, verifies, builds the docs (`website/docs`, Node 22.22+) and stages them under `/docs`, and copies `/blog`, so one Cloudflare Pages deploy serves the landing, `/zh/`, `/blog` and `/docs`. `robots.txt` lists both `/sitemap.xml` (landing, en + zh + blog) and `/docs/sitemap-index.xml` (docs, published pages only). The blog is static English HTML at the landing root (not under `/docs`). To add a post, add `blog/<slug>/index.html`, link it from `blog/index.html`, and list the URL in `sitemap.xml`.

Checks cover actual translation keys, local assets and deployment staging, anchor targets, truthful sample/cost/release labels, three-way exploration selection, file-preview handling, script syntax, and a simulated host exercising the v2 contract, deterministic windows, origin/method rejection, readiness, timeout, stale responses, retry and teardown. This command is a local implementation check, **not** permission to publish and not a substitute for browser interaction or public-download verification.

The former `--allow-missing-shots` workflow belongs to the previous diagnostics-first design. Current evidence and pending work are tracked in [RELEASE_REVIEW.md](RELEASE_REVIEW.md).

Current brand captures are in `docs/assets/oh-agent-2026-10-16/` from repository root. The current share image is `assets/oh-agent-preview-beta3.jpg` (1200×630, captured 2026-10-22 from the live hero City with mock data). The public domain is `https://ohagent.ai/`; subsequent local copy/render changes are not automatically proof of production deployment. Oh Agent is the public-facing name; repository paths and native application identifiers retain project compatibility.

## Public release

The repository `https://github.com/MixLabPro/oh-agent-ai` was verified public on 2026-10-19 and moved to `https://github.com/Oh-Agent-AI/oh-agent` on 2026-10-22; the FAQ links to it in both locales.

**Current release: `1.0.0-beta.3`** — GitHub pre-release [`app-v1.0.0-beta.3`](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3), published 2026-10-22 13:42 (UTC+8) and checked through the GitHub Releases API the same day. The download section links these assets directly:

| Platform | Asset | Signing |
| --- | --- | --- |
| macOS, Apple Silicon (macOS 11+, per `tauri.conf.json`) | `oh-agent-1.0.0-beta.3-arm64.dmg` | Developer ID signed, notarized, stapled |
| Windows x64 | `oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe` | Not Authenticode-signed (unknown-publisher / SmartScreen warning possible) |
| Linux x64 | `oh-agent-1.0.0-beta.3-linux-x86_64.deb`, `oh-agent-1.0.0-beta.3-linux-x86_64.AppImage` | Unsigned; AppImage needs `chmod +x` and FUSE |
| Checksums | `SHA256SUMS` | — |

Intel Mac packages are not included and are described as "coming later" with no link. Known limits stated on the page: beta; some City road-passability checks are not fully certified; interactive gameplay on Windows and Linux has not been manually accepted.

Link rules: never use `/releases/latest` (it skips pre-releases). Link the tag page and `releases/download/app-v<version>/<asset>` URLs. For the next release, verify the assets via the API, then update the URLs, both locales and the verifier's `releaseTag`/`releaseAssets` allowlist together. Domain availability or a merged landing change does not mean the site is deployed.

Canonical and social metadata point to `https://ohagent.ai/`. The domain was accessed successfully during the 2026-10-16 browser review. Cloudflare Pages project: `oh-agent-landing`; production alias: `oh-agent-landing.pages.dev`. Review deployment changes separately from local preview work; this README update does not deploy anything.

## 2026-10-19 content update

The jet roadster is the default conceptual exploration preview. Its copy matches the implemented hold-to-climb/release-to-descend behavior; ground driving and plane play have separate descriptions. Routes remain labeled as illustrations, not gameplay capture. The release section now provides verified repository/Release-page links and explicitly pending macOS, Windows and Linux installer states. There are no installer asset links. `deploy.sh` now includes `exploration.css`, which was referenced by the page but previously omitted from staging. See [brand-spec.md](brand-spec.md) for the preserved visual system and update boundaries.
