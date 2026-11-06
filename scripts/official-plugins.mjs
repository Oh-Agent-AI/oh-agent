import { runNpm } from "./run-npm.mjs";
import { readFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const registry = JSON.parse(readFileSync(path.join(repo, "apps/desktop/plugins.json"), "utf8"));
const ids = new Set();
for (const plugin of registry.plugins) {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || ids.has(plugin.id)
    || !/^[a-z][a-z0-9-]*$/.test(plugin.commandNamespace)
    || !/^plugins\/[A-Za-z][A-Za-z0-9-]*\.plugin\/ui\/index\.html$/.test(plugin.entry)
    || !/^apps\/[a-z0-9-]+\/ui$/.test(plugin.source)) throw new Error("Invalid official plugin descriptor");
  ids.add(plugin.id);
}
if (registry.version !== 1) throw new Error("Unsupported official plugin registry");

export function buildOfficialPlugins({ install = false, probe = false, copy = true } = {}) {
  for (const plugin of registry.plugins) {
    const cwd = path.join(repo, plugin.source);
    if (install) runNpm(["ci"], { cwd, stdio: "inherit" });
    runNpm(["run", "build", ...(probe ? ["--", "--mode", "debug"] : [])], { cwd, stdio: "inherit" });
    const entry = path.join(cwd, "dist/index.html");
    if (!existsSync(entry)) throw new Error(`Plugin entry missing: ${plugin.id}`);
    if (plugin.debugProbeMarker) {
      const assets = path.join(cwd, "dist/assets");
      const hasProbe = readdirSync(assets).filter((file) => file.endsWith(".js"))
        .some((file) => readFileSync(path.join(assets, file), "utf8").includes(plugin.debugProbeMarker));
      if (hasProbe !== probe) throw new Error(`Plugin debug probe mismatch: ${plugin.id}`);
    }
    if (copy) cpSync(path.join(cwd, "dist"), path.join(repo, "apps/desktop/src-tauri/ui-react-dist", path.dirname(plugin.entry)), { recursive: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) buildOfficialPlugins({ copy: false });
