import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tsc = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const declarations = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
if (declarations.status !== 0) process.exit(declarations.status ?? 1);

await build({
  absWorkingDir: packageRoot,
  entryPoints: { index: "src/index.ts", runtime: "src/runtime.ts" },
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2022"],
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
});
