import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodeGame } from "../scripts/buildGame.ts";

/**
 * esbuild strips types, so a successful bundle does not prove the game
 * type-checks. The build service must run tsc first and surface its diagnostics
 * as a normal, repairable result — the Agent loop consumes stage "typecheck".
 */

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const templateDir = path.join(repoRoot, "games", "hello-city");

test("a type error fails the build before bundling, with a repairable diagnostic", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-typecheck-"));
  fs.cpSync(templateDir, workspace, { recursive: true });
  const entry = path.join(workspace, "src", "index.ts");
  const source = fs.readFileSync(entry, "utf8");
  fs.writeFileSync(entry, `${source}\nconst brokenType: number = "not a number";\n`);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-game-typecheck-out-"));
  const failed = await buildCodeGame({ workspaceDir: workspace, outDir });
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  const diagnostic = failed.diagnostics.find((item) => item.code === "game_typecheck_failed");
  assert.ok(diagnostic, JSON.stringify(failed.diagnostics));
  assert.equal(diagnostic.stage, "typecheck");
  assert.equal(diagnostic.relativePath, "src/index.ts");
  assert.ok((diagnostic.line ?? 0) > 0);
  assert.equal(fs.existsSync(path.join(outDir, "game.js")), false, "no bundle may be produced for a type error");

  fs.writeFileSync(entry, source);
  const fixed = await buildCodeGame({ workspaceDir: workspace, outDir });
  assert.equal(fixed.ok, true, fixed.ok ? "" : JSON.stringify(fixed.diagnostics));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});
