#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const app = read('apps/desktop/ui-dev/react/src/app/App.tsx');
const css = read('apps/desktop/ui-dev/react/src/desktop-shell.css');
const config = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
const window = config.app.windows.find((item) => item.label === 'workbench');
assert.equal(window.titleBarStyle, 'Overlay');
assert.equal(window.hiddenTitle, true);
assert.equal(window.decorations, true, 'keep native window controls');
assert.match(app, /data-tauri-drag-region/);
assert.match(app, /"__TAURI_INTERNALS__" in window/, 'browser mocks must not reserve native traffic lights');
assert.match(app, /aria-expanded=\{!sidebarCollapsed\}/);
assert.match(app, /hidden=\{sidebarCollapsed\}/);
assert.match(app, /Promise.allSettled\(\[snapshotRequest, detailsRequest\]\)/);
assert.match(app, /disabled=\{overviewRefreshing\}/);
const normalApp = app.slice(app.indexOf('export function App()'));
assert.doesNotMatch(normalApp, /window.location.reload\(/, 'normal refresh must retain UI state');
assert.match(css, /\.native-mac \.desktop-toolbar \{ padding-left: 84px;/);
assert.match(css, /\.desktop-shell \.nav-list \{ grid-template-columns: 1fr;/);
assert.match(css, /\.desktop-shell \.sidebar\[hidden\] \{ display: none;/);
assert.match(read('apps/desktop/ui-dev/react/src/main.tsx'), /import "\.\/desktop-shell.css"/);
// WebKit ignores height/border/padding on <select> unless appearance is reset; without this
// the unified control frame only applied to inputs (selects stayed small native popups).
const controlsCss = read('apps/desktop/ui-dev/react/src/styles/components.css');
assert.match(controlsCss, /\.desktop-shell select,\s*\n\.desktop-shell select\.av-control \{[^}]*-webkit-appearance: none;[^}]*appearance: none;[^}]*background-image: url\(/, 'selects must drop native appearance and draw their own chevron');
console.log('PASS desktop shell contract (native appearance still requires bundled-app UAT)');
