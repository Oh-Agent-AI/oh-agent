#!/usr/bin/env bash
# Build and package a signed Apple Silicon macOS release without Tauri's DMG
# post-processing script. Required: APPLE_SIGNING_IDENTITY.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_dir="$repo_root/apps/desktop/src-tauri"
app="$desktop_dir/target/release/bundle/macos/Oh Agent.app"
cli="$app/Contents/Resources/bin/agent-vitals"
dmg_dir="$desktop_dir/target/release/bundle/dmg"

die() {
  echo "release-macos: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

case "$(uname -s)" in
  Darwin) ;;
  *) die "this release script must run on macOS" ;;
esac

case "$(uname -m)" in
  arm64) ;;
  *) die "an arm64 macOS harness is required (found $(uname -m))" ;;
esac

case "${SKIP_NOTARIZATION:-}" in
  "" | 0 | 1) ;;
  *) die "SKIP_NOTARIZATION must be unset, 0, or 1" ;;
esac

[ -n "${APPLE_SIGNING_IDENTITY:-}" ] \
  || die "APPLE_SIGNING_IDENTITY is required (for example: Developer ID Application: Example, Inc. (TEAMID))"

for command in cargo codesign ditto file hdiutil node npm plutil security shasum xcrun; do
  require_command "$command"
done

if ! security find-identity -v -p codesigning | grep -F -q -- "\"$APPLE_SIGNING_IDENTITY\""; then
  die "APPLE_SIGNING_IDENTITY was not found as a valid code-signing identity in the keychain"
fi

notarization_mode="none"
if [ "${SKIP_NOTARIZATION:-0}" = 1 ]; then
  echo "release-macos: SKIP_NOTARIZATION=1; producing a signed-only local build"
elif [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
  notarization_mode="keychain-profile"
elif [ -n "${APPLE_ID:-}" ] || [ -n "${APPLE_PASSWORD:-}" ] || [ -n "${APPLE_TEAM_ID:-}" ]; then
  [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] \
    || die "APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID must all be set when APPLE_NOTARY_PROFILE is not set"
  notarization_mode="apple-id"
else
  echo "release-macos: no notarization credentials supplied; producing a signed-only build"
fi

echo "release-macos: verifying React shadow bundle"
(cd "$repo_root/apps/desktop/ui-dev" && npm ci && npm run verify:react)

echo "release-macos: compiling React Tauri shadow candidate (no bundle)"
(cd "$desktop_dir" && cargo tauri build --config tauri.react.conf.json --no-bundle --debug)

echo "release-macos: building release CLI"
(cd "$repo_root" && cargo build --release -p agent-vitals)

echo "release-macos: building macOS app"
(cd "$desktop_dir" && cargo tauri build --ci --bundles app)

[ -d "$app" ] || die "Tauri did not produce app bundle: $app"
[ -f "$cli" ] || die "Tauri app is missing bundled CLI: $cli"

echo "release-macos: signing bundled CLI"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$cli"

echo "release-macos: re-signing app bundle"
codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$app"

echo "release-macos: verifying signed app"
codesign --verify --deep --strict --verbose=4 "$app"
codesign --verify --strict --verbose=4 "$cli"
node "$repo_root/scripts/verify-macos-app-bundle.mjs" "$app" \
  --require-developer-id --require-architecture=arm64

version="$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")"
case "$version" in
  "" | *[!0-9A-Za-z._-]*) die "unexpected app version for DMG filename: $version" ;;
esac

mkdir -p "$dmg_dir"
dmg="$dmg_dir/oh-agent-$version-arm64.dmg"
submit_for_notarization() {
  local target="$1"
  case "$notarization_mode" in
  keychain-profile)
    xcrun notarytool submit "$target" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
    ;;
  apple-id)
    xcrun notarytool submit "$target" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait
    ;;
  none) ;;
  *) die "internal error: unknown notarization mode: $notarization_mode" ;;
  esac
}

if [ "$notarization_mode" != "none" ]; then
  # The copy inside the installer carries its own offline notarization ticket.
  notary_dir="$(mktemp -d "${TMPDIR:-/tmp}/oh-agent-notary.XXXXXX")"
  trap 'rm -rf "$notary_dir"' EXIT
  ditto -c -k --sequesterRsrc --keepParent "$app" "$notary_dir/app.zip"
  echo "release-macos: notarizing app before embedding it in the DMG"
  submit_for_notarization "$notary_dir/app.zip"
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
fi

echo "release-macos: creating fresh arm64 DMG"
bash "$repo_root/scripts/create-macos-dmg.sh" "$app" "$dmg"

if [ "$notarization_mode" != "none" ]; then
  echo "release-macos: notarizing DMG and validating tickets"
  submit_for_notarization "$dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type execute --verbose=4 "$app"
fi

echo "release-macos: writing checksums"
(cd "$dmg_dir" && shasum -a 256 "$(basename "$dmg")" > SHA256SUMS)

echo "release-macos: complete"
echo "release-macos: app: $app"
echo "release-macos: dmg: $dmg"
echo "release-macos: checksums: $dmg_dir/SHA256SUMS"
