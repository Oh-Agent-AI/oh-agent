import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let componentPromise: Promise<any> | undefined;
function loadComponent() {
  return componentPromise ??= (async () => {
    const { build } = require("esbuild");
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../src/game/MechaLastResult.tsx", import.meta.url))],
      bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
      plugins: [{ name: "test-imports", setup(builder: any) {
        builder.onResolve({ filter: /^react(?:\/.*)?$/ }, (args: any) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  })();
}

test("prism guard result log displays status transitions and charges", async () => {
  const { MechaLastResult } = await loadComponent();
  const events = (["applied", "absorbed", "expired"] as const).map((change, i) => ({
    type: "monster_status", actor: "boss", status: "prism_guard", change, remaining: i === 0 ? 1 : 0,
  }));
  const render = (locale: "zh-Hans" | "en") => require("react-dom/server").renderToStaticMarkup(
    require("react").createElement(MechaLastResult, { lastLog: events, locale, t: (text: string) => text }),
  ) as string;
  const en = render("en");
  assert.match(en, /Prism Guard applied.*Charges remaining 1/);
  assert.match(en, /Prism Guard absorbed damage.*Charges remaining 0/);
  assert.match(en, /Prism Guard expired.*Charges remaining 0/);
  assert.match(render("zh-Hans"), /棱镜守护已施加.*剩余次数 1/);
});

test("a real prism match reconciles shield application and absorption in presentation", async () => {
  const { bossPrepare, createMatch, playTurn } = await import("../src/game/mecha/rules.ts");
  const { buildPresentationChanges } = await import("../src/game/mecha/presentationChanges.ts");
  const initial = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", boss: { x: 4, y: 4 }, covers: [], buildings: [], raiders: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 6 } }, { id: "Gunner", pos: { x: 0, y: 8 } }, { id: "Support", pos: { x: 0, y: 9 } }],
    monsterContent: { speciesId: "prism_warden", contentVersion: 1 } });
  bossPrepare(initial);
  const hold = (state: typeof initial): import("../src/game/mecha/rules.ts").ArenaPlan => ({ revision: state.revision, items: state.mechs.map(m => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) });
  const first = playTurn(initial, hold(initial)); assert.ok(first.ok);
  assert.ok(first.log.some(event => event.type === "monster_status" && event.change === "applied"));
  assert.ok(first.presentationStages);
  assert.deepEqual(buildPresentationChanges(first.presentationStages, first.log).ok, true);
  const plan = hold(first.state);
  plan.items[0]!.action = { kind: "melee", target: "boss" };
  const second = playTurn(first.state, plan); assert.ok(second.ok);
  assert.ok(second.log.some(event => event.type === "monster_status" && event.change === "absorbed"));
  assert.ok(second.presentationStages);
  assert.deepEqual(buildPresentationChanges(second.presentationStages, second.log).ok, true);
});

test("displacement and corrosion log entries are identified without pretending to be legacy attacks", async () => {
  const { MechaLastResult } = await loadComponent();
  const events = [
    { type: "monster_displacement", skill: "phase_swap", moves: [{ unit: "Assault", from: { x: 2, y: 3 }, to: { x: 4, y: 5 } }] },
    { type: "corrode_field", change: "created", field: { id: "f", sourceId: "boss", cell: { x: 1, y: 2 }, createdRound: 1, expiresAfterRound: 2 } },
    { type: "corrode_tick", fieldId: "f", unit: "Assault", damage: 1 },
  ];
  const html = require("react-dom/server").renderToStaticMarkup(require("react").createElement(MechaLastResult, { lastLog: events, locale: "en", t: (text: string) => text })) as string;
  assert.match(html, /Phase swap.*2,3 → 4,5/);
  assert.match(html, /Corrosion field created.*1,2/);
  assert.match(html, /Corrosion damage.*1/);
  assert.doesNotMatch(html, /未知结算事件/);
});
