#!/usr/bin/env node
// Render the real CityApp before effects/data resolve. This catches a spinner
// gated on dataLoaded (the native summary-query blank-screen regression).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repo = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { buildSync } = require("esbuild");
const temporary = mkdtempSync(path.join(os.tmpdir(), "city-initial-loading-"));
try {
  const output = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { CityApp } from './src/CityApp';
    export const html = renderToStaticMarkup(React.createElement(CityApp));
  `, resolveDir: path.join(repo, "apps/agent-city/ui"), loader: "tsx" }, bundle: true,
    platform: "node", format: "esm", write: false, jsx: "automatic",
    banner: { js: 'import { createRequire as nodeRequire } from "node:module"; const require = nodeRequire(import.meta.url); globalThis.window = {}; window.parent = window; globalThis.location = { href: "http://localhost/", search: "" };' },
    loader: { ".css": "empty", ".png": "empty", ".jpg": "empty", ".glb": "empty", ".m4a": "empty" },
  });
  const target = path.join(temporary, "initial.mjs");
  writeFileSync(target, output.outputFiles[0].contents);
  const { html } = await import(pathToFileURL(target).href);
  assert.match(html, /class="city-loading" role="status" aria-live="polite"/);
  assert.match(html, /class="city-loading-mark" aria-hidden="true"/);
  assert.match(html, /class="city-loading-track"/);
  assert.ok(html.includes("读取城市数据") || html.includes("Reading city data"));
  assert.doesNotMatch(html, /class="city-scene-message"/, "only one loading announcement before the projection resolves");
  console.log("City initial loading: real first render includes animated data-read feedback before any projection response");
} finally { rmSync(temporary, { recursive: true, force: true }); }
