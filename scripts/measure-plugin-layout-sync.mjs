#!/usr/bin/env node
// P0 layout sync measurement (PLUGIN_NATIVE_LAYOUT_SYNC_SPEC §4.1):
// Programmatic resize of the workbench window; collects jsToRxMs / rxToSetMs
// from plugin_snapshot events tagged layout_sync; reports p50/p95.
// Usage: node scripts/measure-plugin-layout-sync.mjs [--steps N] [--size WxH]
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");

const steps = parseInt(process.argv.includes("--steps") ? process.argv[process.argv.indexOf("--steps") + 1] : "30", 10);
const sizeArg = process.argv.includes("--size") ? process.argv[process.argv.indexOf("--size") + 1] : null;

// Serve from the prebuilt ui-react-dist (same as verify-react-city-runtime).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-sync-measure-"));
fs.cpSync(path.join(repo, "apps/desktop/src-tauri/ui-react-dist"), dist, { recursive: true });

// Patch index.html to load the browser plugin host
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8")
  .replace("<head>", '<head><script src="/tauri-mock.js"></script><script src="/browser-plugin-host.js"></script>');
fs.writeFileSync(path.join(dist, "index.html"), html);

const mimeTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".glb": "model/gltf-binary" };
const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const f = path.resolve(dist, "." + (p === "/" ? "/index.html" : p));
    if (!f.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    const data = await fs.promises.readFile(f);
    res.setHeader("Content-Type", mimeTypes[path.extname(f)] ?? "application/octet-stream");
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: sizeArg ? parseInt(sizeArg.split("x")[0]) : 1000, height: sizeArg ? parseInt(sizeArg.split("x")[1]) : 700 } });

// Navigate and activate City
await page.goto(origin);
await page.locator(".sidebar button").filter({ hasText: "City" }).click().catch(() => {});
await page.waitForTimeout(3000);

// Collect layout_sync events from plugin_snapshot
const samples = [];
for (let i = 0; i < steps; i++) {
  const w = 900 + (i % 5) * 60;
  const h = 600 + (i % 3) * 40;
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(100); // let the sync settle
  const snapshot = await page.evaluate(async () => {
    try { return await window.__TAURI__.core.invoke("plugin_snapshot"); }
    catch { return null; }
  });
  if (snapshot?.events) {
    for (const e of snapshot.events) {
      if (e.code === "layout_sync" && typeof e.jsToRxMs === "number") {
        samples.push({ jsToRx: e.jsToRxMs, rxToSet: e.rxToSetMs, seq: e.seq });
      }
    }
  }
}

await browser.close();
server.close();

// Deduplicate by seq
const seen = new Set();
const unique = samples.filter(s => !seen.has(s.seq) && seen.add(s.seq));

// Percentiles
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

const jsToRx = unique.map(s => s.jsToRx);
const rxToSet = unique.map(s => s.rxToSet);
const total = unique.map(s => s.jsToRx + s.rxToSet);

console.log(`\n=== Plugin Layout Sync Baseline (${unique.length} samples, ${steps} resize steps) ===`);
console.log(`jsToRxMs  (JS → Rust IPC):  p50=${percentile(jsToRx, 0.5)}ms  p95=${percentile(jsToRx, 0.95)}ms  max=${Math.max(...jsToRx, 0)}ms`);
console.log(`rxToSetMs (Rust → WebKit):  p50=${percentile(rxToSet, 0.5)}ms  p95=${percentile(rxToSet, 0.95)}ms  max=${Math.max(...rxToSet, 0)}ms`);
console.log(`total     (end-to-end):      p50=${percentile(total, 0.5)}ms  p95=${percentile(total, 0.95)}ms  max=${Math.max(...total, 0)}ms`);
console.log(`\nThreshold: p95 < 16.7ms (1 frame) → P1 cleanup only; p95 > 16.7ms → consider P2`);
