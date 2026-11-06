#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const read = file => JSON.parse(readFileSync(path.join(repo, 'apps/desktop/src-tauri', file), 'utf8'));
// Match Tauri's RFC 7396 merge, including deletion of the Unix resource on Windows.
function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else if (typeof value === 'object' && !Array.isArray(value)) {
      base[key] = merge(base[key] ?? {}, value);
    } else base[key] = value;
  }
  return base;
}
for (const platform of ['windows', 'linux']) {
  const config = merge(read('tauri.conf.json'), read(`tauri.${platform}.conf.json`));
  const windows = platform === 'windows';
  assert.equal(config.productName, 'Oh Agent');
  assert.equal(config.identifier, 'ai.ohagent.desktop');
  assert.equal(config.mainBinaryName, 'agent-vitals-menubar');
  assert.equal(config.app.windows[0].title, 'Oh Agent 工作台');
  assert.deepEqual(config.bundle.targets, windows ? ['nsis'] : ['deb', 'appimage']);
  assert.deepEqual(config.bundle.resources, windows
    ? { '../../../target/release/agent-vitals.exe': 'bin/agent-vitals.exe' }
    : { '../../../target/release/agent-vitals': 'bin/agent-vitals' });
}
console.log('Windows/Linux bundle config contracts: OK');

for (const file of ['tauri.react.conf.json', 'tauri.legacy.conf.json']) {
  assert.ok(read(file).app.windows[0].title.startsWith('Oh Agent 工作台'));
}
const probe = read('tauri.isolation-probe.conf.json');
assert.equal(probe.productName, 'Oh Agent Isolation Probe');
assert.equal(probe.identifier, 'ai.ohagent.desktop.isolation-probe');
const probeScript = readFileSync(path.join(repo, 'scripts/verify-native-plugin-isolation.mjs'), 'utf8');
assert.ok(probeScript.includes('macos/Oh Agent Isolation Probe.app'));
