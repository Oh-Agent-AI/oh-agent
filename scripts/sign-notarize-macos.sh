#!/usr/bin/env bash
# Sign all executable code inside-out, notarize it, and create an architecture-specific DMG.
# Never enable xtrace here: this process receives signing credentials in memory.
set +x
set -euo pipefail
umask 077
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$repo_root/apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent.app"
cli="$app/Contents/Resources/bin/agent-vitals"
dmg_dir="$repo_root/apps/desktop/src-tauri/target/release/bundle/dmg"
die() { echo "sign-notarize-macos: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || die 'macOS required'
case "${EXPECTED_ARCH:-}" in arm64|x86_64) ;; *) die 'EXPECTED_ARCH must be arm64 or x86_64' ;; esac
[ "$(uname -m)" = "$EXPECTED_ARCH" ] || die 'runner architecture does not match EXPECTED_ARCH'
for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  [ -n "${!name-}" ] || die "required credential missing: $name"
done
case "$APPLE_SIGNING_IDENTITY" in 'Developer ID Application: '*) ;; *) die 'Developer ID Application signing identity required' ;; esac
[ -d "$app" ] && [ -f "$cli" ] || die 'built app and bundled CLI required'
version="$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")"
configured_version="$(node -p "require('$repo_root/apps/desktop/src-tauri/tauri.conf.json').version")"
[ "$version" = "$configured_version" ] || die 'built app version differs from source configuration'
[ "${RELEASE_TAG:-app-v$version}" = "app-v$version" ] || die 'release tag differs from application version'
case "$version" in ''|*[!0-9A-Za-z._-]*) die 'invalid application version' ;; esac

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/oh-agent-sign.XXXXXX")"
keychain="$temp_dir/release.keychain-db"
keychain_password="$(uuidgen)"
# Record the exact existing list. Restore it even if import/sign/notarization fails.
security list-keychains -d user > "$temp_dir/search-list.txt"
cleanup() {
  local code=$?
  trap - EXIT
  python3 - "$temp_dir/search-list.txt" <<'PY'
import pathlib, shlex, subprocess, sys
keys = shlex.split(pathlib.Path(sys.argv[1]).read_text())
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *keys], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
  exit "$code"
}
trap cleanup EXIT
python3 - "$temp_dir/certificate.p12" <<'PY'
import base64, os, pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(os.environ['APPLE_CERTIFICATE'], validate=False))
PY
security create-keychain -p "$keychain_password" "$keychain" >/dev/null 2>&1
security set-keychain-settings -lut 21600 "$keychain" >/dev/null 2>&1
security unlock-keychain -p "$keychain_password" "$keychain" >/dev/null 2>&1
security import "$temp_dir/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null 2>&1
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null 2>&1
python3 - "$temp_dir/search-list.txt" "$keychain" <<'PY'
import pathlib, shlex, subprocess, sys
keys = shlex.split(pathlib.Path(sys.argv[1]).read_text())
subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *keys, sys.argv[2]], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
xattr -cr "$app"
echo 'sign-notarize-macos: signing bundled CLI, then app'
codesign --force --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$cli"
codesign --force --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$app"
node "$repo_root/scripts/verify-macos-app-bundle.mjs" "$app" --require-developer-id "--require-architecture=$EXPECTED_ARCH"

notarize() {
  local target="$1" report="$2"
  # Keep authentication material and full service responses out of release logs.
  if ! xcrun notarytool submit "$target" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" --wait --output-format json > "$report" 2> "$temp_dir/notary-stderr.txt"; then
    die 'notarization command failed; inspect the submission in the Apple developer account'
  fi
  python3 - "$report" <<'PY'
import json, pathlib, sys
result = json.loads(pathlib.Path(sys.argv[1]).read_text())
if result.get('status') != 'Accepted':
    raise SystemExit('Notarization was not Accepted')
print('sign-notarize-macos: notarization Accepted')
PY
}
# Staple the app before embedding it, so the installed app carries its own ticket.
ditto -c -k --sequesterRsrc --keepParent "$app" "$temp_dir/app.zip"
notarize "$temp_dir/app.zip" "$temp_dir/app-notary.json"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=4 "$app"
mkdir -p "$dmg_dir"
dmg="$dmg_dir/oh-agent-$version-$EXPECTED_ARCH.dmg"
bash "$repo_root/scripts/create-macos-dmg.sh" "$app" "$dmg"
codesign --force --keychain "$keychain" --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
notarize "$dmg" "$temp_dir/dmg-notary.json"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
echo "sign-notarize-macos: complete ($EXPECTED_ARCH)"
