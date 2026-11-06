import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const hook = read('apps/desktop/ui-dev/react/src/app/plugins/usePlugin.tsx');
const native = read('apps/desktop/src-tauri/src/plugin_host.rs');
const city = read('apps/agent-city/ui/src/city.css');
const shell = read('apps/desktop/ui-dev/react/src/desktop-shell.css');
const page = read('apps/agent-city/ui/src/standalone.css');
assert.match(page, /html, body, #root \{[^\n]*background: #16283d;/);
assert.match(native, /respondsToSelector: sel!\(setUnderPageBackgroundColor:\)/);
assert.match(native, /setUnderPageBackgroundColor: color/);
const candidate = JSON.parse(read('apps/desktop/src-tauri/tauri.react.conf.json'));
const production = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
for (const field of ['titleBarStyle', 'hiddenTitle', 'width', 'height']) {
  assert.equal(candidate.app.windows[0][field], production.app.windows[0][field], `candidate window ${field} must preserve the host geometry`);
}
assert.match(hook, /useLayoutEffect\(\(\) => \{ if \(active\) void syncLayoutRef\.current\?\.\(\); \}\)/);
assert.match(hook, /boundsOnly: true/);
assert.doesNotMatch(hook, /requestAnimationFrame/);
assert.match(hook, /if \(layoutRunning\) return/);
assert.match(hook, /syncLayoutRef\.current = null/);
assert.match(native, /if bounds_only && \(restart \|\| instance_id\.is_none\(\)\)/);
assert.ok(native.indexOf('if bounds_only { return Ok(id); }') < native.indexOf('view.show()'));
assert.match(native, /if bounds_only \{ return Err\("plugin_instance_unavailable"\.into\(\)\); \}/);
assert.match(city, /\.city-app \{[^\n]*border-radius: 0;/);
assert.match(shell, /\.native-plugin-slot \{[^\n]*background: var\(--plugin-surface-background,/);
console.log('Plugin layout source guards: passed (early/coalesced bounds sync, geometry-only IPC, edge-to-edge surface). Native pixel stability requires bundle UAT.');
