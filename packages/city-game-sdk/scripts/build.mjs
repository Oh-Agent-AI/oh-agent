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

// Four entry points, one bundle each. `host` and `testing` are trusted-side
// only: the exports map is a packaging boundary, never a sandbox — a sandboxed
// community bundle must not be able to import them at all (see docs/spec §11.2).
await build({
  absWorkingDir: packageRoot,
  entryPoints: {
    "api/index": "src/api/index.ts",
    "host/index": "src/host/index.ts",
    "protocol/index": "src/protocol/index.ts",
    "testing/index": "src/testing/index.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: ["es2022"],
  sourcemap: false,
  packages: "bundle",
  logLevel: "info",
});
