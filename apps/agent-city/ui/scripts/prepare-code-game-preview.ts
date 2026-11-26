import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeGame } from "../../../../packages/city-game-sdk/scripts/buildGame.ts";

/**
 * Dev preview asset step: build `games/hello-city`, then copy the immutable
 * bundle and manifest into the City's `public/code-games/` so the dev server
 * can serve them at `/code-games/hello-city.js` without a separate server.
 *
 * This is a test/dev convenience only. The real Studio path resolves a buildId
 * through the workspace/build service and never exposes a physical path.
 */
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(appRoot, "../../..");
const gameDir = path.join(repoRoot, "games", "hello-city");
const outDir = path.join(appRoot, "public", "code-games", "builds");
const targetDir = path.join(appRoot, "public", "code-games");

const dataHome = process.env.AGENT_VITALS_HOME;
const result = await buildCodeGame({ workspaceDir: gameDir, outDir, ...(dataHome ? { dataHome } : {}) });
if (!result.ok) {
  console.error(JSON.stringify(result.diagnostics, null, 2));
  process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(result.bundlePath, path.join(targetDir, "hello-city.js"));
fs.copyFileSync(path.join(gameDir, "game.manifest.json"), path.join(targetDir, "hello-city.manifest.json"));
// Manifest asset paths are workspace-relative; keep that shape under the
// served directory so `/code-games/` is a valid asset base URL.
fs.cpSync(path.join(gameDir, "assets"), path.join(targetDir, "assets"), { recursive: true });
console.log(
  JSON.stringify(
    {
      ok: true,
      buildId: result.buildId,
      bundle: "/code-games/hello-city.js",
      manifest: "/code-games/hello-city.manifest.json",
      byteLength: result.byteLength,
    },
    null,
    2,
  ),
);
