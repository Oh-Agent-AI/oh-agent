import { useEffect, useMemo, useRef, useState } from "react";
import { CityEngine } from "../../engine/CityEngine";
import type { CityModel } from "../../cityModel";
import { CityMechaWorld, type CityMechaView, type CityMechaWorldHandle } from "../../game/CityMechaWorld";
import type { GameLocale } from "../../game/gameCopy";
import type { CityMechaSite } from "../../game/mecha/citySite";
import type { ReturnCameraView } from "../../game/types";
import { useCityGame } from "../../game/useCityGame";
import { GameHud } from "../../game/GameHud";
import { useCityDrivingPlay } from "../../game/useCityDrivingPlay";
import { DrivingHud } from "../../game/DrivingHud";
import { MechaBoard } from "../../game/MechaBoard";
import { hydrateRemoteCityLayout, type RemoteCityDisplay, type RemoteCitySnapshot, type RemoteCityVisualPalette } from "./cityDisplayProjection";

/** Reuses the desktop Agent City renderer with only its allowlisted display projection. */
export function RemoteCityScene({ display, view, locale, onCell }: { display: RemoteCityDisplay | null; view: CityMechaView | null; locale: GameLocale; onCell: (x: number, y: number) => void }) {
  const site = useMemo(() => display ? siteFromDisplay(display) : null, [display]);
  return display ? <RemoteCitySceneContent snapshot={display} battle={site && view ? { site, view, locale, onCell } : null} /> : <RemoteCityLoading />;
}

/** Standalone city view: it needs neither a match nor a fabricated battle arena. */
type DreamDisplay = {
  city: { sessionCount: number; activeCount: number; tokensTotal: number; truncated: boolean };
  districts: Array<{ id: string; label: string; sessionCount: number; activeCount: number; tokensTotal: number }>;
  buildings: Array<{ id: string; title: string | null; titleSource: string | null; sessionCount: number; active: boolean; tokensTotal: number }>;
};

export function RemoteDreamCityScene({ snapshot, palettes, heroBuildingId, display }: { snapshot: RemoteCitySnapshot | null; palettes?: RemoteCityVisualPalette[]; heroBuildingId?: string | null; display?: DreamDisplay }) {
  return snapshot ? <RemoteCitySceneContent snapshot={snapshot} battle={null} palettes={palettes} heroBuildingId={heroBuildingId} display={display} standalone /> : <RemoteCityLoading standalone />;
}

function RemoteCityLoading({ standalone = false }: { standalone?: boolean }) {
  return <section className={`remote-city-scene${standalone ? " remote-city-scene--standalone" : ""}`} aria-label="Agent City 三维城市"><p className="remote-city-loading">正在同步城市场景…</p></section>;
}

type BattleOverlay = { site: CityMechaSite; view: CityMechaView; locale: GameLocale; onCell: (x: number, y: number) => void };

function RemoteCitySceneContent({ snapshot, battle, palettes, heroBuildingId, display, standalone = false }: { snapshot: RemoteCitySnapshot; battle: BattleOverlay | null; palettes?: RemoteCityVisualPalette[]; heroBuildingId?: string | null; display?: DreamDisplay; standalone?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<CityMechaWorldHandle>(null);
  const engine = useRef<CityEngine | null>(null);
  const cityCamera = useRef<ReturnCameraView | null>(null);
  const [worldEngine, setWorldEngine] = useState<CityEngine | null>(null);
  const [error, setError] = useState("");
  const [mechaOpen, setMechaOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cameraMode, setCameraMode] = useState<"city" | "battle">("city");
  const game = useCityGame(engine, {
    cinemaActive: () => false, filmActive: () => false, busy: () => false,
    labelsVisible: () => true, requestRefresh: () => {}, locale: () => "zh-Hans",
  }, { persistProfile: false });
  const driving = useCityDrivingPlay(engine, {
    cinemaActive: () => false, gameActive: () => game.active, busy: () => false,
  }, { notifyHostBusy: false });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    try {
      engine.current = new CityEngine({ canvas: element, onSelect: setSelectedId });
      setWorldEngine(engine.current);
      engine.current.setQualityMode("eco");
      return () => { engine.current?.dispose(); engine.current = null; setWorldEngine(null); };
    } catch {
      setError("此设备无法启动 Agent City 3D 场景。");
    }
  }, []);
  useEffect(() => {
    const current = engine.current;
    if (!current || !snapshot) return;
    try {
      setSelectedId(null);
      const visuals = new Map(palettes?.map(item => [item.districtId, item]));
      const model = { ...snapshot.model, districts: snapshot.model.districts.map(district => ({ ...district,
        visualPalette: visuals.get(district.id)?.palette, visualLandmarkHeight: visuals.get(district.id)?.landmarkHeight,
        visualFlagShare: visuals.get(district.id)?.flagShare })),
        buildings: snapshot.model.buildings.map(building => ({ ...building, visualHero: heroBuildingId === building.id })),
        generatedAt: Date.now(), windowStartMs: 0, windowEndMs: 1, windowLabel: "远程城市", hideSessionLabels: standalone,
        rows: new Map() } as unknown as CityModel;
      const layout = hydrateRemoteCityLayout(snapshot.layout);
      current.setLabelsVisible(true);
      current.applyRemoteModel(model, layout, snapshot.layout.backdrop);
      const camera = current.captureReturnView();
      cityCamera.current = { ...snapshot.layout.camera, controls: camera.controls };
      current.restoreReturnView(cityCamera.current);
      setError("");
    } catch {
      cityCamera.current = null;
      setError("无法加载城市快照，请重新获取链接或联系城市主人。");
    }
  }, [snapshot, palettes, heroBuildingId]);
  const selected = snapshot?.model.buildings.find(building => building.id === selectedId);
  const buildingDisplay = selected ? display?.buildings.find(row => row.id === selected.id) : null;
  const title = buildingDisplay?.title;
  const district = selected ? snapshot?.model.districts.find(item => item.id === selected.districtId) : null;
  const focusBattle = () => { world.current?.resetCamera(); setCameraMode("battle"); };
  const focusCity = () => {
    if (cityCamera.current) engine.current?.restoreReturnView(cityCamera.current);
    setCameraMode("city");
  };
  return <section className={`remote-city-scene${standalone ? " remote-city-scene--standalone" : ""}`} aria-label="Agent City 三维城市">
    <canvas ref={canvas} hidden={Boolean(error)} aria-label="旋转和缩放城市场景" />
    {error && <p role="alert">{error}</p>}
    {standalone && display && <aside className="remote-city-overview" aria-label="城市概览">
      <strong>城市概览</strong><span>{display.city.sessionCount.toLocaleString()} 个会话 · {display.city.tokensTotal.toLocaleString()} tokens</span>
      <span>{display.city.activeCount.toLocaleString()} 个活跃会话{display.city.truncated ? " · 展示数据已截断" : ""}</span>
    </aside>}
    {standalone && snapshot && !game.active && !driving.active && !mechaOpen && !error && <nav className="remote-city-game-entry" aria-label="访客本地游戏">
      <button type="button" disabled={!worldEngine} onClick={game.enterPractice}>自由飞行</button>
      <button type="button" disabled={!worldEngine} onClick={game.enterRace}>穿环挑战</button>
      <button type="button" disabled={!worldEngine} onClick={driving.enter}>驾驶</button>
      <button type="button" disabled={!worldEngine} onClick={() => setMechaOpen(true)}>机甲战棋</button>
      {game.entryError && <span role="status">{game.entryError}</span>}
    </nav>}
    {standalone && mechaOpen && worldEngine && !error && <MechaBoard locale="zh-Hans" engine={worldEngine} remoteControlsEnabled={false} connectedAssault={false} onClose={() => setMechaOpen(false)} />}
    {game.active && game.snapshot && <GameHud snapshot={game.snapshot} locale="zh-Hans" actions={{
      onResume: game.resume, onRestart: game.restart, onExit: game.exit, onRetryPrepare: game.retryPrepare,
      onNewCourse: game.newCourse, onSoundVolume: game.setSoundVolume, onToggleSfx: game.toggleSfx,
      onToggleMusic: game.toggleMusic, onPause: () => game.pause("user"),
    }} />}
    {standalone && <DrivingHud model={{ active: driving.active, choosingVehicle: driving.choosingVehicle, vtol: driving.vtol,
      entryError: driving.entryError, initialPaused: driving.initialPaused, hud: driving.hud,
      preparationProgress: driving.preparationProgress, events: driving.events, diagnostics: driving.diagnostics(), roadCheck: driving.roadCheck }}
      actions={{ selectVehicle: driving.selectVehicle, clearEntryError: driving.clearEntryError, exit: driving.exit,
        pause: driving.pause, resume: driving.resume, openUiContext: driving.openUiContext }} locale="zh-Hans" sound={driving.sound} />}
    {standalone && game.active && !game.snapshot?.controller.paused && game.snapshot?.controller.phase !== "preparing" && game.snapshot?.controller.phase !== "result" && game.snapshot?.controller.phase !== "data" && <TouchPad
      label="飞行触控" buttons={FLIGHT_TOUCH_BUTTONS} onChange={(pressed) => game.setTouchInput({
        throttleUp: pressed.has("up"), throttleDown: pressed.has("down"), turnLeft: pressed.has("left"),
        turnRight: pressed.has("right"), pitchUp: pressed.has("pitch-up"), pitchDown: pressed.has("pitch-down"),
      })} />}
    {standalone && driving.hud.phase === "running" && <TouchPad label="驾驶触控" buttons={DRIVE_TOUCH_BUTTONS} onChange={(pressed) => driving.setInput({
      forward: pressed.has("up"), backward: pressed.has("down"), left: pressed.has("left"), right: pressed.has("right"), thruster: pressed.has("thruster"),
    })} />}
    {worldEngine && battle && !error && <CityMechaWorld ref={world} engine={worldEngine} site={battle.site} locale={battle.locale} view={battle.view} performance={null} paused={false} connectedAssault={false} frameOnMount={false} onPerformanceComplete={() => {}} onCell={battle.onCell} />}
    {worldEngine && battle && !error && <nav className="remote-city-camera-controls" aria-label="城市镜头">
      <button type="button" aria-pressed={cameraMode === "city"} onClick={focusCity}>全城</button>
      <button type="button" aria-pressed={cameraMode === "battle"} onClick={focusBattle}>战场</button>
    </nav>}
    {selected && <aside className="remote-city-building"><button type="button" onClick={() => { setSelectedId(null); engine.current?.setSelected(null); }}>关闭</button>
      <strong>{title || district?.label || "城市建筑"}</strong><span>{standalone
        ? `${display?.districts.find(item => item.id === district?.id)?.label ?? district?.label ?? "城区"} · ${buildingDisplay?.tokensTotal.toLocaleString() ?? "0"} tokens · ${buildingDisplay?.active ? "活跃" : "已结束"}`
        : `${district?.label} · ${selected.tokensTotal.toLocaleString()} tokens`}</span></aside>}
  </section>;
}

type TouchButton = Readonly<{ key: string; label: string }>;
const FLIGHT_TOUCH_BUTTONS: readonly TouchButton[] = [
  { key: "pitch-up", label: "↑" }, { key: "up", label: "加速" }, { key: "left", label: "←" },
  { key: "down", label: "减速" }, { key: "right", label: "→" }, { key: "pitch-down", label: "↓" },
];
const DRIVE_TOUCH_BUTTONS: readonly TouchButton[] = [
  { key: "up", label: "前进" }, { key: "left", label: "←" }, { key: "down", label: "刹车/倒车" },
  { key: "right", label: "→" }, { key: "thruster", label: "喷升" },
];
function TouchPad({ label, buttons, onChange }: { label: string; buttons: readonly TouchButton[]; onChange: (pressed: ReadonlySet<string>) => void }) {
  const pointersByKey = useRef(new Map<string, Set<number>>());
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const [, render] = useState(0);
  const update = (key: string, pointerId: number, down: boolean) => {
    let pointers = pointersByKey.current.get(key);
    if (down) {
      if (!pointers) { pointers = new Set<number>(); pointersByKey.current.set(key, pointers); }
      pointers.add(pointerId);
    } else {
      pointers?.delete(pointerId);
      if (!pointers?.size) pointersByKey.current.delete(key);
    }
    onChangeRef.current(new Set(pointersByKey.current.keys())); render((value) => value + 1);
  };
  useEffect(() => () => { pointersByKey.current.clear(); onChangeRef.current(new Set()); }, []);
  return <div className="remote-city-touch-pad" aria-label={label}>
    {buttons.map((button) => <button key={button.key} type="button" aria-label={button.label} aria-pressed={Boolean(pointersByKey.current.get(button.key)?.size)}
      onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); update(button.key, event.pointerId, true); }}
      onPointerUp={(event) => { event.preventDefault(); update(button.key, event.pointerId, false); }}
      onPointerCancel={(event) => update(button.key, event.pointerId, false)} onLostPointerCapture={(event) => update(button.key, event.pointerId, false)}>{button.label}</button>)}
  </div>;
}

function siteFromDisplay(display: RemoteCityDisplay): CityMechaSite {
  const arena = display.site;
  return {
    originX: arena.originX, originZ: arena.originZ, yaw: arena.yaw, cellW: arena.cellW, cellD: arena.cellD,
    terrain: arena.terrain as CityMechaSite["terrain"], heights: arena.heights,
    buildings: arena.buildings.map(building => ({ id: building.id, cells: building.cells, x: building.x, z: building.z, yaw: building.yaw, ground: building.ground, height: building.height })),
    blocked: arena.blocked, mechs: arena.mechs as CityMechaSite["mechs"], boss: arena.boss, raiders: arena.raiders, spawnSpread: arena.spawnSpread,
  };
}
