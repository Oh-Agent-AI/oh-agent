import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const target = path.join(repo, "apps/desktop/src-tauri/code-game");
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, "bin"), { recursive: true });
const nodeName = process.platform === "win32" ? "node.exe" : "node";
fs.copyFileSync(process.execPath, path.join(target, "bin", nodeName));
for (const directory of ["packages/city-game-sdk", "packages/agent-vitals-city-sdk", "games/hello-city", "scripts/mecha-ts-register.mjs", "scripts/mecha-ts-hook.mjs"]) {
  const source = path.join(repo, directory);
  const destination = path.join(target, directory);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}
const linkedCitySdk = path.join(target, "packages/city-game-sdk/node_modules/@oh-agent/city-sdk");
fs.rmSync(linkedCitySdk, { recursive: true, force: true });
fs.cpSync(path.join(repo, "packages/agent-vitals-city-sdk"), linkedCitySdk, { recursive: true, dereference: true });

console.log(`Code Game builder ready: ${target}`);
