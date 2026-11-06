#!/usr/bin/env bash
# Build the React candidate as a real macOS .app without changing the
# production Tauri frontendDist. This is the Phase 4 gate: the resulting app
# must be launched as a bundle (open), never as a bare menubar binary.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_dir="$repo_root/apps/desktop/src-tauri"
app="$desktop_dir/target/release/bundle/macos/Oh Agent.app"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "build-macos-react-app: this script must run on macOS" >&2; exit 1 ;;
esac

echo "build-macos-react-app: verifying React bundle and candidate config"
(cd "$repo_root/apps/agent-city/ui" && npm run typecheck)
(cd "$repo_root/apps/desktop/ui-dev" && npm run verify:react)

echo "build-macos-react-app: building bundled CLI"
(cd "$repo_root" && cargo build --release -p agent-vitals)

echo "build-macos-react-app: building React candidate .app"
(cd "$desktop_dir" && cargo tauri build --config tauri.react.conf.json --ci --bundles app)

[ -d "$app" ] || { echo "build-macos-react-app: Tauri did not produce $app" >&2; exit 1; }

echo "build-macos-react-app: verifying app executable, bundled CLI, schema and architecture"
node "$repo_root/scripts/verify-macos-app-bundle.mjs" "$app" \
  "--require-architecture=$(uname -m)"

if [ "${OPEN_APP:-0}" = "1" ]; then
  echo "build-macos-react-app: opening bundled app for manual Tauri/visual acceptance"
  open "$app"
else
  echo "build-macos-react-app: app ready at $app (set OPEN_APP=1 to launch with open)"
fi
