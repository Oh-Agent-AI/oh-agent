#!/usr/bin/env bash
# A shared, headless Finder drag-to-Applications installer for local and CI builds.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(uname -s)" = Darwin ] || { echo 'create-macos-dmg: macOS required' >&2; exit 1; }
[ "$#" = 2 ] || { echo 'usage: create-macos-dmg.sh <Oh Agent.app> <output.dmg>' >&2; exit 1; }
app="$1"
dmg="$2"
[ -d "$app" ] && [ "$(basename "$app")" = 'Oh Agent.app' ] || { echo 'create-macos-dmg: Oh Agent.app required' >&2; exit 1; }
case "$dmg" in *.dmg) ;; *) echo 'create-macos-dmg: .dmg output required' >&2; exit 1 ;; esac
# Isolate and hash-pin build dependencies; never modify the user's global Python.
environment="$repo_root/apps/desktop/src-tauri/target/dmg-tools"
if [ ! -x "$environment/bin/python" ]; then python3 -m venv "$environment"; fi
python="$environment/bin/python"
if ! "$python" -c 'from importlib.metadata import version; assert [version(p) for p in ("dmgbuild", "ds-store", "mac-alias")] == ["1.6.5", "1.3.1", "2.2.2"]' 2>/dev/null; then
  "$python" -m pip install --disable-pip-version-check --only-binary=:all: --require-hashes -r "$repo_root/scripts/macos-dmg-requirements.txt"
fi
mkdir -p "$(dirname "$dmg")"
temporary="$(mktemp -d "$(dirname "$dmg")/.oh-agent-dmg.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT
"$python" "$repo_root/scripts/build-macos-dmg.py" "$app" "$temporary/installer.dmg"
"$python" "$repo_root/scripts/verify-macos-dmg.py" "$temporary/installer.dmg"
# Replace only a complete, verified image; a failed build preserves the old installer.
mv -f "$temporary/installer.dmg" "$dmg"
echo "create-macos-dmg: ready: $dmg"
