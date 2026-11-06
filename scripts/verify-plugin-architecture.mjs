#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = readFileSync(path.join(repo, "apps/desktop/ui-dev/react/src/app/App.tsx"), "utf8");
const backend = readFileSync(path.join(repo, "apps/desktop/src-tauri/src/lib.rs"), "utf8");
const assets = path.join(repo, "apps/desktop/src-tauri/ui-react-dist/assets");
const hookPath = "apps/desktop/ui-dev/react/src/app/plugins/usePlugin.tsx";
const hook = readFileSync(path.join(repo, hookPath), "utf8");
const nativeHost = readFileSync(path.join(repo, "apps/desktop/src-tauri/src/plugin_host.rs"), "utf8");
const browserHost = readFileSync(path.join(repo, "apps/desktop/ui-dev/public/browser-plugin-host.js"), "utf8");
const builder = readFileSync(path.join(repo, "scripts/official-plugins.mjs"), "utf8");
const require = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { buildSync } = require("esbuild");
const compiled = buildSync({ entryPoints: [path.join(repo, hookPath)], bundle: true, write: false, format: "cjs", jsx: "automatic", external: ["react", "react/*", "../../lib/tauri"] });
const module = { exports: {} };
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: (id) => id === "../../lib/tauri" ? {} : require(id) });
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const preview = renderToStaticMarkup(createElement(() => {
  const plugin = module.exports.usePlugin(true, { id: "metrics", name: "Metrics" });
  return createElement("div", null, plugin.toolbar, plugin.content);
}));
const checks = [
  { id: "adapters_and_build_are_descriptor_driven", passed: !/AgentCity|city\./.test(nativeHost.split("#[cfg(test)]")[0] + browserHost + builder) && nativeHost.includes('include_str!("../../plugins.json")') && shell.includes("plugins.map"), location: "apps/desktop/plugins.json" },
  { id: "city_uses_shared_sdk_transport", passed: readFileSync(path.join(repo, "apps/agent-city/ui/src/host.ts"), "utf8").includes("@agent-vitals/app-sdk/ui-host")
    && readFileSync(path.join(repo, "packages/agent-vitals-app-sdk/src/ui-host.ts"), "utf8").includes("export async function noteBusy"), location: "packages/agent-vitals-app-sdk/src/ui-host.ts" },
  { id: "plugin_hook_is_generic", passed: /export function usePlugin\(/.test(hook) && !/City|city\./.test(hook) && !existsSync(path.join(repo, "apps/desktop/ui-dev/react/src/app/plugins/useCityPlugin.tsx")), location: hookPath },
  { id: "plugin_presentation_uses_configured_name", passed: /Metrics (工具栏|toolbar)/.test(preview) && /Metrics (插件内容|plugin content)/.test(preview) && /(正在加载 Metrics|Loading Metrics)/.test(preview) && !preview.includes("City"), location: hookPath },
  { id: "shell_does_not_import_city_source", passed: !/import\s*\([^)]*agent-city\/ui\/src/.test(shell), location: "apps/desktop/ui-dev/react/src/app/App.tsx" },
  { id: "core_does_not_path_compile_city_backend", passed: !/#\[path\s*=\s*"[^"]*agent-city\/backend/.test(backend), location: "apps/desktop/src-tauri/src/lib.rs" },
  { id: "shell_bundle_does_not_contain_city_chunk", passed: existsSync(assets) && !readdirSync(assets).some((file) => /^CityApp-.*\.js$/.test(file)), location: "apps/desktop/src-tauri/ui-react-dist/assets" },
];
const report = { schema: "plugin-architecture-audit/v1", status: checks.every((check) => check.passed) ? "passed" : "failed", checks,
  scope: "MVP entry/bundle dependency checks; native isolation is verified separately" };
console.log(JSON.stringify(report, null, 2));
if (report.status === "failed") process.exitCode = 1;
