#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function artifactName(version, platform, arch, kind) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const architecture = arch === 'x64' ? 'x86_64' : arch;
  const supported = { macos: ['dmg', 'app.zip'], windows: ['exe'], linux: ['deb', 'AppImage'] };
  if (!supported[platform]?.includes(kind) || !['x86_64', 'arm64'].includes(architecture)) throw new Error('Invalid release platform/architecture/format');
  return platform === 'macos' ? `oh-agent-${version}-${architecture}.${kind}`
    : `oh-agent-${version}-${platform}-${architecture}${kind === 'exe' ? '-setup.exe' : `.${kind}`}`;
}
function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}
export function stageArtifacts(version, platform, arch, source, destination) {
  const kinds = { macos: ['dmg'], windows: ['exe'], linux: ['deb', 'AppImage'] }[platform];
  if (!kinds) throw new Error('Unsupported platform');
  const files = filesUnder(source);
  // Validate every format before copying any artifact; stale outputs must fail closed.
  const selected = kinds.map(kind => {
    const matches = files.filter(file => file.endsWith(`.${kind}`));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${kind} artifact, found ${matches.length}`);
    return [matches[0], artifactName(version, platform, arch, kind)];
  });
  mkdirSync(destination, { recursive: true });
  for (const [sourceFile, name] of selected) copyFileSync(sourceFile, path.join(destination, name));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, platform, arch, source, destination] = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync(path.join(repo, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `app-v${version}`) throw new Error('Release tag does not match configured version');
  if (mode === 'name') console.log(artifactName(version, platform, arch, source));
  else if (mode === 'stage' && source && destination) stageArtifacts(version, platform, arch, source, destination);
  else throw new Error('Usage: desktop-release-artifacts.mjs name PLATFORM ARCH KIND | stage PLATFORM ARCH SOURCE DEST');
}
