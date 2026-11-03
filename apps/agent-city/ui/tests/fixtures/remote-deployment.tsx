// Synthetic browser-only harness. No real relay, desktop gateway, or user data.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { RemoteDeployment } from "../../src/remote/RemoteDeployment";
import { RemoteBattleScene } from "../../src/game/mecha/presentation/RemoteBattleScene";
import { createMatch, MECH_IDS } from "../../src/game/mecha/rules";
import { applyDeployPlan } from "../../src/game/mecha/deployment";
import { remoteArenaFromSite } from "../../src/game/mecha/contracts/arena";
import "../../src/remote/remote.css";

const terrain = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "land" as const));
const heights = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 0));
const site = { originX: 0, originZ: 0, yaw: 0, cellW: 8, cellD: 8, terrain, heights, buildings: [], blocked: [],
  mechs: MECH_IDS.map((id, i) => ({ id, pos: { x: i * 3, y: 9 } })), boss: { x: 4, y: 0 }, raiders: [], spawnSpread: 0 };
let authoritative = { protocol: "mecha-net:v1" as const, matchId: "synthetic", mode: "pve" as const, ruleset: "mecha-v1.4", status: "active" as const, revision: 0,
  players: [{ playerId: "owner", side: "A" as const, role: "host" as const }], arena: remoteArenaFromSite(site, { arenaId: "synthetic", sourceRevision: "1" }),
  state: createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true }) };
const calls: any[] = [];
let behavior = "normal";
let refresh = () => {};
let toggle = (_online: boolean) => {};
let scene: RemoteBattleScene | null = null;
let lastRemovedCell: { x: number; y: number } | undefined;
const fakeClient = { submitDeployment: async (command: any) => {
  calls.push(structuredClone(command));
  if (behavior === "lost-before") { behavior = "normal"; throw Error("host_offline"); }
  if (behavior === "unavailable") { behavior = "normal"; return { ok: false, error: { code: "unavailable" } }; }
  if (behavior === "forbidden") { behavior = "normal"; return { ok: false, error: { code: "forbidden" } }; }
  const result = applyDeployPlan(authoritative.state, command.plan);
  if (!result.ok) return { ok: false, error: { code: "invalid_deployment", fault: result.fault } };
  authoritative = { ...authoritative, revision: result.state.revision, state: result.state };
  if (behavior === "lost-after") { behavior = "normal"; throw Error("host_offline"); }
  return { ok: true, value: structuredClone(authoritative) };
} };
function App() {
  const [snapshot, setSnapshot] = useState(structuredClone(authoritative));
  const [online, setOnline] = useState(true);
  const sceneRef = useRef<RemoteBattleScene | null>(null);
  const cellRef = useRef((_cell: any) => {});
  refresh = () => { const next = structuredClone(authoritative); sceneRef.current?.applySnapshot(next); setSnapshot(next); };
  toggle = setOnline;
  return <main className="remote-app"><section className="remote-stage"><canvas ref={node => {
    if (!node || sceneRef.current) return;
    scene = sceneRef.current = new RemoteBattleScene(node, cell => cellRef.current(cell));
    scene.applySnapshot(snapshot);
  }} /></section>{snapshot.state.phase === "deployment" ? <RemoteDeployment key={`${snapshot.matchId}:${snapshot.revision}`}
    snapshot={snapshot} state={snapshot.state} playerId={new URLSearchParams(location.search).get("role") === "guest" ? "guest" : "owner"} client={fakeClient as any}
    interactive={online} canInteract={() => online} locale={new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh"}
    cellRef={cellRef} sceneRef={sceneRef} accept={next => { authoritative = next as typeof authoritative; refresh(); }} resync={refresh} />
    : <p data-testid="battle-phase">{snapshot.state.phase} rev {snapshot.revision}</p>}</main>;
}
Object.assign(window, { deploymentFixture: { refresh: () => refresh(), online: (value: boolean) => toggle(value),
  behavior: (value: string) => { behavior = value; }, correct: () => { lastRemovedCell = authoritative.state.deployment!.zone.pop(); refresh(); }, restore: () => { if (lastRemovedCell) authoritative.state.deployment!.zone.push(lastRemovedCell); lastRemovedCell = undefined; refresh(); }, calls, state: () => structuredClone(authoritative.state),
  visible: () => Object.fromEntries(Object.entries((scene as any).mechs).map(([id, group]: any) => [id, group.visible])),
  markers: () => (scene as any).deploymentMarkers.children.length } });
createRoot(document.getElementById("root")!).render(<App />);
