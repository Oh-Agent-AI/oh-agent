import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeUnitIdentity } from "../src/game/mecha/unitIdentity.ts";
import { getUnitPortrait, getUnitPortraitSrc } from "../src/game/mecha/unitPortraits.ts";

const uniqueIds = ["Assault", "Gunner", "Support", "boss", "raider-west"];

test("known units use five distinct immutable small character portraits", () => {
  const portraits = uniqueIds.map((id) => getUnitPortrait(id));
  assert.equal(new Set(portraits.map((p) => p?.src)).size, 5);
  for (const [index, p] of portraits.entries()) {
    assert.ok(p);
    assert.equal(p.width, 256);
    assert.equal(p.height, 256);
    assert.ok(Object.isFrozen(p));
    assert.equal(getUnitPortrait(uniqueIds[index]), p);
    assert.equal(getUnitPortraitSrc(uniqueIds[index]), p.src);
    assert.match(p.src, /\/assets\/mecha\/portraits\/(assault|gunner|support|boss|raider)\.jpg$/);
  }
});

test("raider aliases share artwork without losing localized directional identity", () => {
  const expected = getUnitPortrait("raider-west");
  assert.ok(expected);
  for (const id of ["raider-w", "raider-e", "raider-west", "raider-east"]) {
    assert.equal(getUnitPortrait(id), expected);
    assert.equal(getUnitPortraitSrc(id), expected.src);
  }
  assert.equal(describeUnitIdentity("raider-w", "zh-Hans").label, "小怪西");
  assert.equal(describeUnitIdentity("raider-east", "en").label, "East raider");
  assert.notEqual(describeUnitIdentity("raider-w", "en").symbol, describeUnitIdentity("raider-e", "en").symbol);
});

test("unknown, wrong-case and prototype IDs never borrow known artwork", () => {
  for (const id of ["", "unit-42", "raider", "raider-north", "assault", "Boss", "constructor", "toString", "__proto__"]) {
    assert.equal(getUnitPortrait(id), null, id);
    assert.equal(getUnitPortraitSrc(id), null, id);
    assert.equal(describeUnitIdentity(id, "en").known, false, id);
  }
});

const assetDir = new URL("../src/assets/mecha/portraits/", import.meta.url);
const repoRoot = new URL("../../../../", import.meta.url);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Read JPEG's SOF marker without depending on an image-decoding package.
function jpegDimensions(bytes: Buffer): [number, number] {
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  let offset = 2;
  while (offset < bytes.length) {
    assert.equal(bytes[offset++], 0xff);
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    assert.notEqual(marker, 0xda, "SOF must precede scan data");
    offset += bytes.readUInt16BE(offset);
  }
  throw new Error("JPEG has no dimensions");
}

test("runtime derivatives match provenance, source hashes, square dimensions and size budget", () => {
  const manifest = JSON.parse(readFileSync(new URL("provenance.json", assetDir), "utf8"));
  assert.equal(manifest.portraits.length, 5);
  assert.equal(manifest.processing.generation, false);
  assert.equal(manifest.processing.network, false);
  let total = 0;
  for (const item of manifest.portraits) {
    const source = readFileSync(new URL(item.sourcePath, repoRoot));
    assert.equal(hash(source), item.sourceSha256, `${item.key}: source unchanged`);
    assert.equal(source.readUInt32BE(16), item.sourceDimensions[0]);
    assert.equal(source.readUInt32BE(20), item.sourceDimensions[1]);
    const { x, y, width, height } = item.crop;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
    assert.ok(x + width <= item.sourceDimensions[0]);
    assert.ok(y + height <= item.sourceDimensions[1]);
    assert.equal(width, height);
    const url = new URL(item.output.file, assetDir);
    const bytes = readFileSync(url);
    assert.deepEqual(jpegDimensions(bytes), [256, 256]);
    assert.deepEqual(item.output.dimensions, [256, 256]);
    assert.equal(bytes.length, item.output.bytes);
    assert.equal(statSync(url).size, bytes.length);
    assert.equal(hash(bytes), item.output.sha256);
    assert.ok(bytes.length < 50_000, `${item.key}: must not bundle a full sheet`);
    total += bytes.length;
  }
  assert.equal(total, manifest.totalImageBytes);
  assert.ok(total < 200_000);
});

// The existing node loader handles TS/assets, not JSX. Compile this component in
// memory only, retaining real React SSR and file URLs for its local JPEG imports.
const require = createRequire(import.meta.url);
let componentPromise: Promise<any> | undefined;
function loadComponent() {
  return componentPromise ??= (async () => {
    const { build } = require("esbuild");
    const result = await build({
      entryPoints: [fileURLToPath(new URL("../src/game/MechaUnitAvatar.tsx", import.meta.url))],
      bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
      plugins: [{ name: "local-portrait-test-imports", setup(builder: any) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({
          path: pathToFileURL(require.resolve(args.path)).href, external: true,
        }));
        builder.onLoad({ filter: /\.jpg$/ }, (args: any) => ({
          contents: `export default ${JSON.stringify(pathToFileURL(args.path).href)};`, loader: "js",
        }));
      } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  })();
}

async function renderPortrait(props: Record<string, unknown>, legacy = false) {
  const component = await loadComponent();
  const { createElement } = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  return renderToStaticMarkup(createElement(legacy ? component.MechaUnitAvatar : component.MechaUnitPortrait, props));
}

test("legacy avatar API renders original art, decorative and unfocusable by default", async () => {
  const html = await renderPortrait({ mechId: "Assault", size: 32, className: "host-avatar" }, true);
  assert.match(html, /<span[^>]*class="host-avatar"/);
  assert.match(html, /data-unit-id="Assault"/);
  assert.match(html, /data-portrait-key="assault"/);
  assert.match(html, /<img[^>]*portraits\/assault\.jpg/);
  assert.match(html, /width="32" height="32" alt="" aria-hidden="true"/);
  assert.doesNotMatch(html, /<svg|role="img"|aria-label=|tabindex=/);
});

test("labeled portraits keep localized/custom names without double-announcing the image", async () => {
  const en = await renderPortrait({ unitId: "raider-e", locale: "en", decorative: false });
  assert.match(en, /role="img" aria-label="East raider"/);
  assert.match(en, /<img[^>]*portraits\/raider\.jpg/);
  const zh = await renderPortrait({ unitId: "Support", decorative: false });
  assert.match(zh, /aria-label="支援"/);
  const custom = await renderPortrait({ unitId: "boss", decorative: false, ariaLabel: "Selected boss" });
  assert.match(custom, /aria-label="Selected boss"/);
});

test("unknown portraits expose an honest symbol, never a support or enemy image", async () => {
  const unknown = await renderPortrait({ unitId: "raider-north", locale: "en", decorative: false });
  assert.match(unknown, /data-portrait-state="unknown"/);
  assert.match(unknown, /aria-label="raider-north — Unknown identity"/);
  assert.match(unknown, />\?<\/span>/);
  assert.doesNotMatch(unknown, /<img|data-portrait-key=/);
  const empty = await renderPortrait({ unitId: "", decorative: false });
  assert.match(empty, /aria-label="未知单位 — 身份未知"/);
  const decorative = await renderPortrait({ unitId: "unit-42" });
  assert.doesNotMatch(decorative, /role="img"|aria-label=|<img/);
  assert.match(decorative, /aria-hidden="true"/);
});
