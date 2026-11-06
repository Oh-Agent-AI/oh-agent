#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const workflow = readFileSync(path.join(repo, ".github/workflows/release-desktop.yml"), "utf8");
const config = JSON.parse(readFileSync(path.join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
if (config.productName !== "Oh Agent") throw new Error("desktop productName must be Oh Agent");
for (const file of ["scripts/release-macos.sh", "scripts/build-macos-app.sh", "scripts/build-macos-react-app.sh", "scripts/verify-macos-app-bundle.mjs", "scripts/verify-v010-app-bundle.mjs"]) {
  const source = readFileSync(path.join(repo, file), "utf8");
  if (!source.includes("macos/Oh Agent.app") || source.includes("macos/oh-agent.app") || source.includes("macos/agent-vitals.app")) {
    throw new Error(`incorrect app bundle name in ${file}`);
  }
}
const platformWorkflow = readFileSync(path.join(repo, ".github/workflows/desktop-platforms.yml"), "utf8");
for (const required of ["Stage branded installers", "Name=Oh Agent", "VersionInfo.ProductName", "test-desktop-release-artifacts.mjs"]) {
  if (!platformWorkflow.includes(required)) throw new Error(`missing platform guard: ${required}`);
}
const signingScript = readFileSync(path.join(repo, "scripts/sign-notarize-macos.sh"), "utf8");
for (const source of [signingScript, readFileSync(path.join(repo, "scripts/release-macos.sh"), "utf8")]) {
  if (!source.includes('bash "$repo_root/scripts/create-macos-dmg.sh" "$app" "$dmg"')) {
    throw new Error("local and CI releases must share the drag-to-Applications DMG builder");
  }
}
for (const required of ['--timestamp "$cli"', '--timestamp "$app"', "get('status') != 'Accepted'", 'stapler validate "$dmg"']) {
  if (!signingScript.includes(required)) throw new Error(`missing signing boundary: ${required}`);
}
if (signingScript.indexOf('--timestamp "$cli"') > signingScript.indexOf('--timestamp "$app"')) throw new Error("CLI must be signed before app");
const checks = [
  ["permission-preserving app packing", "node scripts/macos-app-artifact.mjs pack"],
  ["permission-preserving app restoration", "node scripts/macos-app-artifact.mjs unpack"],
  ["native app transport regression", "node scripts/test-macos-app-artifact.mjs"],
  ["bounded macOS artifact staging", "node scripts/desktop-release-artifacts.mjs stage macos"],
  ["unique platform artifacts", "expected one $extension installer"],
  ["release commit CI preflight", "Require successful Verify run for release commit"],
  ["exact commit verification", '--workflow verify.yml --commit "$sha"'],
  ["native platform package workflow", "uses: ./.github/workflows/desktop-platforms.yml"],
  ["all platforms gate publication", "needs: [build, platform_packages]"],
  ["platform installer download", "pattern: desktop-*-x86_64"],
  ["tag trigger", 'tags: ["app-v*"]'],
  ["manual release tag input", "release_tag:"],
  ["Intel runner matrix", "runner: macos-15-intel"],
  ["Apple Silicon runner matrix", "runner: macos-14"],
  ["architecture-specific staging", "Stage architecture-specific artifacts"],
  ["Oh Agent DMG staging name", 'oh-agent-${version}-${EXPECTED_ARCH}.dmg'],
  ["Oh Agent DMG release name", 'oh-agent-${version}-${arch}.dmg'],
  ["architecture-specific artifact upload", "path: dist/${{ matrix.arch }}"],
  ["tag validation", "release tag must start with app-v"],
  ["pinned Tauri CLI", "tauri-cli --version 2.11.4 --locked"],
  ["React shadow bundle preflight", "Verify React shadow bundle"],
  ["React shadow bundle build", "npm ci && npm run verify:react"],
  ["React Tauri shadow candidate compile", "cargo tauri build --config tauri.react.conf.json --no-bundle --debug"],
  ["unsigned input build before inside-out signing", "cargo tauri build --ci --bundles app --no-sign"],
  ["explicit nested executable signing", "bash ../../../scripts/sign-notarize-macos.sh"],
  ["build architecture check", "--require-architecture=$EXPECTED_ARCH"],
  ["publish artifact path", "find dist -type d -path \"*-${arch}/Oh Agent.app\""],
  ["publish app zip name", "release/oh-agent-${RELEASE_TAG}-${arch}.app.zip"],
  ["strict signature check", "--require-developer-id"],
  ["notarization validation", "xcrun stapler validate"],
  ["artifact checksums", "shasum -a 256 *.zip *.dmg *.exe *.deb *.AppImage > SHA256SUMS"],
  ["existing tag only", "gh release create \"$RELEASE_TAG\" --verify-tag"],
  ["beta tags publish as prereleases", 'if [[ "$version" == *-* ]]; then\n            gh release create "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --generate-notes --prerelease'],
  ["stable tags stay releases", 'gh release create "$RELEASE_TAG" --verify-tag --title "$RELEASE_TAG" --generate-notes\n          fi'],
  ["publish ref matches tag", "ref: ${{ inputs.release_tag || github.ref }}"],
  ["pinned Node runtime", "node-version: 20"],
];

function occurrences(needle) {
  return workflow.split(needle).length - 1;
}

let failed = false;
if (workflow.indexOf("Restore app bundles with original permissions") > workflow.indexOf("Re-verify downloaded app")) {
  throw new Error("App archives must be restored before executable/signature verification");
}
for (const [label, needle] of checks) {
  if (workflow.includes(needle)) console.log(`ok   ${label}`);
  else {
    console.error(`FAIL ${label}: missing ${needle}`);
    failed = true;
  }
}
for (const [label, needle, minimum] of [
  ["both build paths depend on verification", "needs: preflight", 2],
  ["runner/matrix architecture mapping", "EXPECTED_ARCH", 2],
  ["publish architecture loop", "for arch in x86_64 arm64", 1],
  ["build strict architecture assertion", "--require-architecture=$EXPECTED_ARCH", 1],
  ["publish strict architecture assertion", "--require-architecture=$arch", 1],
]) {
  const count = occurrences(needle);
  if (count >= minimum) console.log(`ok   ${label}: ${count}`);
  else {
    console.error(`FAIL ${label}: found ${count}, expected at least ${minimum}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("release desktop workflow checks passed");
