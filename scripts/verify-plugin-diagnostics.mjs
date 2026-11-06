import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { build } = require("esbuild");
const result = await build({ entryPoints: [new URL("../apps/desktop/ui-dev/react/src/app/plugins/pluginDiagnostics.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node" });
const { pluginCreationCode, pluginCreationHelp } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
for (const reason of ["plugin_assets_missing", "plugin_window_unavailable", "plugin_attachment_failed", "slot_unavailable", "plugin_unknown"]) {
  assert.equal(pluginCreationCode(reason), reason);
  assert.equal(pluginCreationCode(new Error(reason)), reason);
}
assert.equal(pluginCreationCode(new Error("Unsupported browser mock command: plugin_open")), "plugin_browser_host_missing");
assert.equal(pluginCreationCode(new Error("invalid_bounds")), "plugin_bounds_invalid");
for (const reason of [new Error("secret /Users/private/log token=hidden plugin_assets_missing"), { message: "plugin_assets_missing" }, null, "constructor", "__proto__"]) {
  assert.equal(pluginCreationCode(reason), "plugin_create_failed");
}
assert.match(pluginCreationHelp("plugin_browser_host_missing", true), /Restart/);
assert.match(pluginCreationHelp("plugin_browser_host_missing", false), /重启开发服务/);
assert.match(pluginCreationHelp("plugin_assets_missing", true), /Build/);
assert.match(pluginCreationHelp("plugin_webview_create_failed", true), /local host logs/);
assert.match(pluginCreationHelp("plugin_instance_conflict", false), /宿主清理并重建/);
console.log("Plugin creation diagnostics: passed (public codes, browser adapter guidance, raw-error redaction).");
