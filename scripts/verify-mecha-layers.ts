/** 依赖方向守卫（规格 §3.0）：只做 import 语句的文本检查，无依赖。 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/agent-city/ui/src");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|mts)$/.test(name) ? [path] : [];
  });
}

type Import = { file: string; line: number; spec: string; resolved: string | null };

/** import/export-from/动态 import 的说明符；相对路径解析成 src 内的绝对路径，裸包名 resolved 为 null。 */
function importsOf(file: string): Import[] {
  const text = readFileSync(file, "utf8");
  const found: Import[] = [];
  const re = /(?:\bimport\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?|\bexport\s+(?:type\s+)?[^"';]*?\sfrom\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const spec = m[1]!;
    const line = text.slice(0, m.index).split("\n").length;
    found.push({ file, line, spec, resolved: spec.startsWith(".") ? resolve(dirname(file), spec) : null });
  }
  return found;
}

const where = (i: Import) => `${relative(resolve(SRC, "../../../.."), i.file)}:${i.line} imports "${i.spec}"`;
const inside = (path: string | null, dir: string) => path !== null && (path === dir || path.startsWith(dir + "/"));
const stem = (path: string) => path.replace(/\.(ts|tsx|mts)$/, "");

function check(files: string[], forbidden: (i: Import) => boolean): string[] {
  return files.flatMap(importsOf).filter(forbidden).map(where);
}
function expectNone(offenders: string[]) {
  assert.deepEqual(offenders, [], `dependency direction violated:\n${offenders.join("\n")}`);
}

// 引擎对 game/** 的存量反向依赖（驾驶/飞行/场景端口，与机甲无关）。这是棘轮：
// 只许减少，不许新增；机甲相关（game/mecha/**、MechaBoard 等）一律零容忍。
// 清理这些存量不在本次范围内，清掉一条就从这里删一条。
const LEGACY_ENGINE_GAME_IMPORTS = new Set([
  "engine/CityEngine.ts -> ../game/DrivingSimulation",
  "engine/CityEngine.ts -> ../game/carDimensions",
  "engine/CityEngine.ts -> ../game/CarCamera",
  "engine/CityEngine.ts -> ../game/FlightCameraControls",
  "engine/CityEngine.ts -> ../game/types",
  "engine/CityEngine.ts -> ../game/runtime/HostGameScenePort",
  "engine/CityEngine.ts -> ../game/runtime/GameScenePort",
  "engine/CityEngine.ts -> ../game/runtime/GameSceneSnapshot",
  "engine/CityEngine.ts -> ../game/VehicleChaseCamera",
  "engine/cityParts.ts -> ../game/driving/CollisionIndex",
  "engine/render/playableVehicles.ts -> ../../game/CarVisuals",
  "engine/render/playableVehicles.ts -> ../../game/FlightVisuals",
  "engine/render/playableVehicles.ts -> ../../game/FlightSimulation",
  "engine/surface/cityStaticWorldPort.ts -> ../../game/driving/CollisionIndex",
  "engine/surface/cityStaticWorldPort.ts -> ../../game/driving/staticSolidContracts",
  "engine/surface/citySurfacePort.ts -> ../../game/driving/CollisionIndex",
  "engine/surface/citySurfacePort.ts -> ../../game/driving/staticSolidContracts",
  "engine/surface/compileCitySolidInputs.ts -> ../../game/driving/CollisionIndex",
  "engine/surface/compileCitySolidInputs.ts -> ../../game/driving/staticSolidContracts",
  "engine/surface/renderedSolidObstacles.ts -> ../../game/driving/CollisionIndex",
  "engine/surface/sceneSolids.ts -> ../../game/driving/CollisionIndex",
]);
const legacyKey = (i: Import) => `${relative(SRC, i.file)} -> ${i.spec}`;

test("engine/** never imports game/mecha/** or any new game/** module", () => {
  const imports = walk(join(SRC, "engine")).flatMap(importsOf).filter((i) => inside(i.resolved, join(SRC, "game")));
  expectNone(imports.filter((i) => inside(i.resolved, join(SRC, "game/mecha")) || !LEGACY_ENGINE_GAME_IMPORTS.has(legacyKey(i))).map(where));
});

test("rules core (including pure skill primitives) imports only itself", () => {
  const dir = join(SRC, "game/mecha");
  const core = new Set(["rules", "board", "combat", "enemy", "enemy/contracts", "enemy/planner", "execution/enemyPhase", "enemyPhasePreview", "mode", "decision", "deployment", "monsters/catalog", "monsters/contracts", "skillEffects", "statusEffects", "statusEncounter", "statusTurn", "statusBattle", "sequentialTurn", "skillSwarmLink", "sporeUnitProjection", "ringUnit", "corrodeUnit", "prismUnit", "swarmUnit", "neuralUnit", "displacementUnit", "unitRegistry"].map((n) => join(dir, n)));
  // board/combat/enemy 可能尚未拆出：存在才检查
  const files = [...core].map((p) => `${p}.ts`).filter(existsSync);
  assert.ok(files.some((f) => f.endsWith("rules.ts")), "rules.ts must exist");
  expectNone(check(files, (i) => i.resolved === null || !core.has(stem(i.resolved))));
});

test("controllers, AI and match adapters import no react, three or engine", () => {
  const dir = join(SRC, "game/mecha");
  const files = ["controller", "sequentialController", "sequentialDurable", "ai", "matchFromSite"].map((n) => join(dir, `${n}.ts`)).filter(existsSync);
  assert.equal(files.length >= 1, true);
  expectNone(check(files, (i) =>
    /^(react|react-dom)(\/|$)/.test(i.spec) || /^three(\/|$)/.test(i.spec) || inside(i.resolved, join(SRC, "engine"))));
});

test("the shared HUD boundary and model stay outside runtime rules", () => {
  const hud = join(SRC, "game/MechaHudLayout.tsx");
  const model = join(SRC, "game/mecha/hud/model.ts");
  const adapters = join(SRC, "game/mecha/hud/adapters.ts");
  expectNone(check([hud], (i) => inside(i.resolved, join(SRC, "game/mecha/combat")) ||
    inside(i.resolved, join(SRC, "game/mecha/rules")) || inside(i.resolved, join(SRC, "game/mecha/enemy"))));
  expectNone(check([model, adapters], (i) => /^(react|react-dom)(\/|$)/.test(i.spec) ||
    inside(i.resolved, join(SRC, "game/mecha/combat")) || inside(i.resolved, join(SRC, "game/mecha/rules")) ||
    inside(i.resolved, join(SRC, "game/mecha/enemy"))));
});

test("sequential HUD composes shared classic panels without a parallel wrapper", () => {
  const page = join(SRC, "game/SequentialMechaMatch.tsx");
  const source = readFileSync(page, "utf8");
  assert.equal(existsSync(join(SRC, "game/SequentialMechaHud.tsx")), false, "legacy sequential HUD wrapper must stay deleted");
  assert.equal(existsSync(join(SRC, "game/sequentialMecha.css")), false, "sequential HUD must not own a second stylesheet");
  assert.match(source, /<MechaCommandPanel\b/);
  assert.match(source, /<MechaCommandDeck\b/);
  assert.match(source, /<MechaActionCard\b/);
  assert.match(source, /<MechaMoveList\b/);
  assert.doesNotMatch(source, /SequentialMechaCommandPanel/);
});

test("v1.5 view and HUD adapters do not import the v1.4 controller", () => {
  const files = [join(SRC, "game/MechaBoard.tsx"), join(SRC, "game/SequentialMechaMatch.tsx"), join(SRC, "game/mecha/hud/adapters.ts")];
  expectNone(check(files, (i) => i.resolved === join(SRC, "game/mecha/controller.ts")));
  assert.match(readFileSync(join(SRC, "game/SequentialMechaMatch.tsx"), "utf8"), /presentation\/cues/);
});

test("mode routing stays in the pure resolver instead of the page component", () => {
  const pages = [join(SRC, "game/MechaBoard.tsx"), join(SRC, "game/SequentialMechaMatch.tsx")].map((path) => readFileSync(path, "utf8"));
  const mode = join(SRC, "game/mecha/mode.ts");
  const runtime = readFileSync(join(SRC, "game/MechaModeRuntime.ts"), "utf8");
  assert.doesNotMatch(pages.join("\n"), /import\.meta\.env|new URLSearchParams\(location\.search\)/);
  assert.match(pages[0]!, /switch \(runtime\.mode\.kind\)/);
  assert.match(runtime, /resolveMechaMode\(/);
  expectNone(check([mode], (i) => i.resolved === null));
});

test("render/mecha imports nothing from game/** or engine/**", () => {
  const files = walk(join(SRC, "render/mecha"));
  assert.ok(files.length >= 2, "models.ts and animation.ts live here");
  expectNone(check(files, (i) => inside(i.resolved, join(SRC, "game")) || inside(i.resolved, join(SRC, "engine"))));
});

test("the checker itself catches a violation", () => {
  const sample = join(SRC, "engine/__virtual__.ts");
  const fake: Import = { file: sample, line: 1, spec: "../game/mecha/rules", resolved: resolve(dirname(sample), "../game/mecha/rules") };
  assert.equal(inside(fake.resolved, join(SRC, "game")), true);
});
