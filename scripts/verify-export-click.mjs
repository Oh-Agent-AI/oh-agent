#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const bundled = buildSync({
  entryPoints: [new URL("../apps/creator-studio/ui/src/exportClick.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node",
}).outputFiles[0].text;
const url = pathToFileURL(`/tmp/export-click-${process.pid}.mjs`);
await import("node:fs").then((fs) => fs.writeFileSync(url, bundled));
const { exportClickBlock, exportBlockMessage } = await import(url.href);

const ready = { browserPreview: false, busy: false, hasProject: true, cityReady: true, unsaved: false, mountCount: 1 };
assert.equal(exportClickBlock(ready), null, "a ready project sends the export request");
assert.equal(exportClickBlock({ ...ready, mountCount: 0 }), null, "an unbound project still reaches the host");
for (const [patch, code] of [
  [{ browserPreview: true }, "creator_export_browser_preview"],
  [{ busy: true }, "creator_export_busy"],
  [{ hasProject: false, cityReady: false }, "creator_export_no_project"],
  [{ cityReady: false }, "creator_export_city_unavailable"],
  [{ unsaved: true }, "creator_export_drafts_unsaved"],
  [{ mountCount: 2 }, "creator_export_single_mount_required"],
]) {
  const block = exportClickBlock({ ...ready, ...patch });
  assert.equal(block, code);
  assert.equal(typeof exportBlockMessage(block), "string");
  assert.ok(exportBlockMessage(block).length > 0);
}
assert.equal(exportClickBlock({ ...ready, cityReady: false, unsaved: true }), "creator_export_city_unavailable");
console.log("verify-export-click: ok");
