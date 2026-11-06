#!/bin/bash
# Deploy the Oh Agent landing page AND the docs (/docs) to Cloudflare Pages (project: oh-agent-landing).
# Production: https://ohagent.ai (custom domains pre-bound) / https://oh-agent-landing.pages.dev
#
# Stages only the files the site actually references (excludes internal docs,
# dev tooling and legacy scripts), builds the prerendered /zh/ page and the
# Starlight docs into the same stage, copies /blog, verifies, then uploads with wrangler.
# Needs Node.js >= 22.22 (Astro 7, docs build).
# One-time setup: npx wrangler login
set -euo pipefail
cd "$(dirname "$0")"

echo "== prerender /zh/ =="
node tools/build-zh.mjs

echo "== verify =="
node tools/verify-landing.mjs

echo "== build docs =="
(cd ../docs && npm ci && npm run build)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp index.html styles.css exploration.css app.js i18n.js city-host.js robots.txt sitemap.xml 404.html BingSiteAuth.xml "$STAGE"/
# IndexNow key file (public by design) lives at the site root.
cp 3c04062f7bc54e2b928e35bd99565348.txt "$STAGE"/
mkdir -p "$STAGE"/zh && cp zh/index.html "$STAGE"/zh/
rsync -a --exclude=".DS_Store" --exclude="shots/" assets/ "$STAGE"/assets/
rsync -a --exclude=".DS_Store" city3d/ "$STAGE"/city3d/
rsync -a --exclude=".DS_Store" blog/ "$STAGE"/blog/
rsync -a --exclude=".DS_Store" ../docs/dist/ "$STAGE"/docs/
# llms.txt conventionally lives at the site root.
cp ../docs/dist/llms.txt ../docs/dist/llms-full.txt "$STAGE"/

echo "== staged =="
test -f "$STAGE/docs/index.html" && test -f "$STAGE/docs/zh/index.html" && test -f "$STAGE/docs/sitemap-index.xml"
test -f "$STAGE/zh/index.html" && test -f "$STAGE/llms.txt"
test -f "$STAGE/blog/index.html" && test -f "$STAGE/blog/multi-agent-shared-notes/index.html" && test -f "$STAGE/blog/fleet-auditor-before-hire/index.html" && test -f "$STAGE/blog/mecha-3d-asset-pipeline/index.html" && test -f "$STAGE/blog/chaos-emergence-habitat/index.html" && test -f "$STAGE/blog/trust-before-fleet/index.html"
find "$STAGE" -maxdepth 2 -name index.html | sort

echo "== deploy =="
npx wrangler pages deploy "$STAGE" --project-name=oh-agent-landing --branch=main

echo "== indexnow =="
# Tell Bing/Yandex/etc. to recrawl. Set INDEXNOW=0 to skip.
if [ "${INDEXNOW:-1}" != "0" ]; then node tools/indexnow.mjs "$STAGE" || echo "indexnow: failed (non-fatal)"; fi
