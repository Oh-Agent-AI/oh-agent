#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "apps/desktop/src-tauri/ui-react-dist");
const index = path.join(dist, "index.html");
const productionConfig = JSON.parse(readFileSync(path.join(repo, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const candidateConfig = JSON.parse(readFileSync(path.join(repo, "apps/desktop/src-tauri/tauri.react.conf.json"), "utf8"));
const legacyConfig = JSON.parse(readFileSync(path.join(repo, "apps/desktop/src-tauri/tauri.legacy.conf.json"), "utf8"));

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

if (!existsSync(index)) {
  fail(`React Tauri shadow bundle missing index.html: ${index}`);
  process.exit(1);
}

if (productionConfig.build?.frontendDist !== "ui-react-dist") fail("production Tauri frontendDist must point to the React bundle");
if (candidateConfig.build?.frontendDist !== "ui-react-dist") fail("React candidate frontendDist must be ui-react-dist");
if (legacyConfig.build?.frontendDist !== "ui") fail("legacy fallback frontendDist must remain ui");
const productionWindow = productionConfig.app?.windows?.find((window) => window.label === "workbench");
const candidateWindow = candidateConfig.app?.windows?.find((window) => window.label === "workbench");
const legacyWindow = legacyConfig.app?.windows?.find((window) => window.label === "workbench");
if (productionWindow?.url !== "index.html") fail("production window must open React index.html");
if (candidateWindow?.url !== "index.html") fail("React candidate window must open index.html");
if (legacyWindow?.url !== "workbench.html") fail("legacy fallback window must open workbench.html");

const html = readFileSync(index, "utf8");
if (!html.includes('<div id="root"></div>')) fail("React shadow bundle missing root");
if (/<(?:script|link)[^>]+(?:https?:\/\/|src=["']\/(?!\/)|href=["']\/(?!\/))/i.test(html)) fail("React shadow bundle uses an absolute or remote asset URL");
if (html.includes("tauri-mock.js") || html.includes("workbench.html")) fail("React shadow bundle contains browser mock or legacy entry");

const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
for (const reference of references) {
  if (reference.startsWith("#") || reference.startsWith("data:")) continue;
  if (!reference.startsWith("./")) {
    fail(`React asset reference is not relative: ${reference}`);
    continue;
  }
  const target = path.resolve(dist, reference.slice(2));
  if (!target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) fail(`React asset reference missing: ${reference}`);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const files = filesUnder(dist);
if (!files.some((file) => file.endsWith(".js"))) fail("React shadow bundle has no JavaScript entry");
if (!files.some((file) => file.endsWith(".css"))) fail("React shadow bundle has no CSS entry");

for (const cssFile of files.filter((file) => file.endsWith(".css"))) {
  const css = readFileSync(cssFile, "utf8");
  for (const match of css.matchAll(/url\(\s*["']?([^\)"']+)["']?\s*\)/g)) {
    const reference = match[1].trim();
    if (reference.startsWith("data:")) continue;
    if (/^(?:https?:)?\/\//i.test(reference) || reference.startsWith("/")) fail(`CSS resource reference is not local-relative: ${reference}`);
    else if (reference.startsWith("./") && !existsSync(path.resolve(path.dirname(cssFile), reference.slice(2)))) fail(`CSS resource reference missing: ${reference}`);
  }
}

if (!process.exitCode) console.log("React Tauri shadow bundle contract: OK");
