#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const bundled = buildSync({
  entryPoints: [new URL("../apps/creator-studio/ui/src/studioRestore.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node",
}).outputFiles[0].text;
const url = pathToFileURL(`/tmp/studio-restore-${process.pid}.mjs`);
await import("node:fs").then((fs) => fs.writeFileSync(url, bundled));
const { projectIdAfterStudioReload, readStoredStudioProject, rememberStudioProject, forgetStudioProject } = await import(url.href);

const returned = "project-422e056189bac4d99cb6367f8b6df109";
const stored = "project-stored00000000000000000000000001";
assert.equal(projectIdAfterStudioReload(returned, stored), returned, "one-shot return wins");
assert.equal(projectIdAfterStudioReload(null, stored), stored, "stored id is used only when return is absent");
assert.equal(projectIdAfterStudioReload(undefined, null), null);
assert.equal(projectIdAfterStudioReload("../secret", stored), stored, "a path is not a project id");
assert.equal(projectIdAfterStudioReload(null, "bad id"), null, "a stored value with a space is not a project id");
assert.equal(projectIdAfterStudioReload("playtest-start", stored), "playtest-start", "the helper only chooses an id; the caller must not start a playtest");

const memory = new Map();
const storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};
rememberStudioProject(storage, stored);
assert.equal(readStoredStudioProject(storage), stored);
rememberStudioProject(storage, "not a project");
assert.equal(readStoredStudioProject(storage), stored, "an invalid id does not replace the stored project");
forgetStudioProject(storage);
assert.equal(readStoredStudioProject(storage), null);
console.log("verify-studio-reload-project: ok");
