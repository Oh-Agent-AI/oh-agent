/**
 * 城市小地图（2026-10-21，用户：「左下角设计一个正方形小地图……普通模式下可以查看道路路线，点击查看道路审计可以看到哪里拥堵，
 * 开车游戏可以看到道路情况以及当前所在的位置，小地图可以展开和收起，吸附在左边侧边」）。
 *
 * 一块正方形、贴着窗口左缘的面板，四种看法：
 *   - 路线（普通模式默认）：按路型着色的路网——主干道 / 次干道 / 小路 / 桥 / 高架，蓝色箭头是镜头看向的位置；
 *   - 道路审计：高峰车流估算（traffic.ts）——绿畅通、黄较忙、橙偏慢、红拥堵，紫色虚线是车开不过去、被排除在路网外的路；
 *     拥堵点闪烁，悬停看流量与超出通行能力多少；
 *   - 怪兽：当前城市地形上可用的遭遇点；点击只定位，城市标记才进入战棋；
 *   - 驾驶（开车时自动切换）：路况（红 = 开不过去，琥珀 = 很陡，判据与修复面板「体检」同一组函数，roadConditions.ts）
 *     + 车的位置与朝向；默认跟随车辆（看车周围 ~320 m），可切到全城。
 * 点地图（非驾驶）镜头飞过去，点在问题点附近就飞到问题点。收起时缩进左缘，只留一个把手；展开/收起与所选看法记在本机。
 * 只读：每 0.5 s 看一眼生效布局是不是换了（修复工具每次编辑产出新布局），换了就重画；整城视图缓存成位图，跟随视图按 ~12 fps 重画。
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CityEngine } from "../engine/CityEngine";
import type { CityLayout } from "../engine/cityLayout";
import { minimapModel, type MinimapModel } from "./roadConditions";
import { trafficModel, type TrafficLevel, type TrafficModel } from "./traffic";
import type { EncounterState } from "../game/mecha/useMonsterEncounters";

const SIZE = 184;
const FOLLOW_SPAN = 320;
const ROAD_COLOR = { main: "#ece8dc", secondary: "#cfcbc0", local: "#a29f97", bridge: "#8fb7d6" } as const;
const CONDITION_COLOR = { blocked: "#ff4d3d", steep: "#ffb02e" } as const;
const TRAFFIC_COLOR: Record<TrafficLevel, string> = { free: "#4fbf6a", busy: "#d8cf3f", slow: "#ff9a2e", jam: "#ff3b30" };
const IMPASSABLE = "#c65cff";
const HIGHWAY = "#4a4f55";
/** 陆/水半透明（不透明度 0–255）：静止时 3D 场景透过来，小地图不挡视线；悬停时面板底色变实，地图跟着「变实」。 */
const LAND = [30, 40, 34, 120], WATER = [34, 92, 130, 170];
const STORAGE = { open: "city-minimap-open", tab: "city-minimap-tab" } as const;

type Tab = "routes" | "audit" | "monsters";
type Mode = Tab | "drive";
type Pose = Readonly<{ x: number; z: number; heading: number }>;
/** 视窗：世界里一个以 (cx, cz) 为中心、边长 span 的正方形，映射到 SIZE×SIZE 的画布。 */
type View = { cx: number; cz: number; span: number };
const scaleOf = (v: View) => SIZE / v.span;
const toCanvas = (v: View, x: number, z: number) => ({ x: (x - v.cx + v.span / 2) * scaleOf(v), y: (z - v.cz + v.span / 2) * scaleOf(v) });
function wholeView(model: MinimapModel): View {
  const b = model.bounds;
  return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, span: Math.max(b.maxX - b.minX, b.maxZ - b.minZ) };
}

const waterTiles = new WeakMap<MinimapModel, HTMLCanvasElement>();
function waterTile(model: MinimapModel): HTMLCanvasElement {
  const hit = waterTiles.get(model); if (hit) return hit;
  const { cols, rows, water } = model.water;
  const tile = document.createElement("canvas"); tile.width = cols; tile.height = rows;
  const g = tile.getContext("2d");
  if (g) {
    const image = g.createImageData(cols, rows);
    for (let i = 0; i < water.length; i += 1) { const c = water[i] ? WATER : LAND; image.data.set(c, i * 4); }
    g.putImageData(image, 0, 0);
  }
  waterTiles.set(model, tile);
  return tile;
}

/** 画底图（水陆 + 高架 + 路网），路的颜色随看法变。cull：跟随视图只画视窗里的路。 */
function drawMap(g: CanvasRenderingContext2D, model: MinimapModel, traffic: TrafficModel | null, mode: Mode, v: View, cull: boolean): void {
  const s = scaleOf(v);
  const b = model.bounds; const o = toCanvas(v, b.minX, b.minZ);
  g.clearRect(0, 0, SIZE, SIZE); // 跟随视图反复画在同一张底图上，半透明的陆地不先清会一层层叠成不透明
  // 城市范围外（正方形补出来的边）按海画：城外本来就是海，按陆地画会在两侧留两条深色竖带。
  g.fillStyle = `rgba(${WATER[0]},${WATER[1]},${WATER[2]},${WATER[3] / 255})`; g.fillRect(0, 0, SIZE, SIZE);
  g.clearRect(o.x, o.y, (b.maxX - b.minX) * s, (b.maxZ - b.minZ) * s);
  g.imageSmoothingEnabled = true; g.drawImage(waterTile(model), o.x, o.y, (b.maxX - b.minX) * s, (b.maxZ - b.minZ) * s);
  g.lineCap = "round"; g.lineJoin = "round";
  const half = v.span / 2 + 20;
  const visible = (points: readonly { x: number; z: number }[]) => !cull || points.some((p) => Math.abs(p.x - v.cx) < half && Math.abs(p.z - v.cz) < half);
  const stroke = (points: readonly { x: number; z: number }[], width: number, color: string, dash?: number[]) => {
    if (!visible(points)) return;
    g.beginPath(); points.forEach((p, i) => { const c = toCanvas(v, p.x, p.z); if (i) g.lineTo(c.x, c.y); else g.moveTo(c.x, c.y); });
    g.setLineDash(dash ?? []); g.strokeStyle = color; g.lineWidth = width; g.stroke();
  };
  for (const run of model.highways) stroke(run, Math.max(1.5, 10.5 * s), HIGHWAY);
  const w = (width: number, min: number) => Math.max(min, width * s);
  if (mode === "routes" || mode === "monsters") {
    // 路线：宽路压在窄路上面，桥最后（跨水一眼可见）。
    for (const cls of ["local", "secondary", "main", "bridge"] as const)
      for (const road of model.roads) if (road.cls === cls) stroke(road.points, w(road.width, cls === "local" ? 0.8 : 1.2), ROAD_COLOR[cls]);
  } else if (mode === "audit") {
    // 审计：按拥堵档位着色，越堵越在上层；开不过去的路（不在路网里）画紫色虚线。
    for (const road of model.roads) if (!traffic?.edges.has(road.id) && !model.blocked.has(road.id)) stroke(road.points, w(road.width, 0.8), "#8d8a83");
    for (const level of ["free", "busy", "slow", "jam"] as const)
      for (const road of model.roads) if (traffic?.edges.get(road.id)?.level === level) stroke(road.points, w(road.width, level === "free" ? 1 : 2), TRAFFIC_COLOR[level]);
    for (const road of model.roads) if (model.blocked.has(road.id)) stroke(road.points, w(road.width, 2.5), IMPASSABLE, [3, 2]);
  } else {
    for (const road of model.roads) if (road.condition === "ok") stroke(road.points, w(road.width, 0.8), ROAD_COLOR[road.cls]);
    for (const road of model.roads) if (road.condition === "steep") stroke(road.points, w(road.width, 2), CONDITION_COLOR.steep);
    for (const road of model.roads) if (road.condition === "blocked") stroke(road.points, w(road.width, 2.5), CONDITION_COLOR.blocked);
  }
  g.setLineDash([]);
}

/** 闪烁的点：审计看拥堵点，驾驶看路况问题点；路线看法不打点。 */
type Spot = { at: { x: number; z: number }; color: string; text: { zh: string; en: string } };
function spotsOf(model: MinimapModel, traffic: TrafficModel | null, mode: Mode): Spot[] {
  if (mode === "audit") return [
    ...(traffic?.hotspots ?? []).map((h) => ({ at: h.at, color: h.vc >= 1 ? TRAFFIC_COLOR.jam : TRAFFIC_COLOR.slow, text: h.text })),
    ...model.issues.filter((i) => i.severity === "blocked").map((i) => ({ at: i.at, color: IMPASSABLE, text: i.text })),
  ];
  if (mode === "drive") return model.issues.map((i) => ({ at: i.at, color: i.severity === "blocked" ? CONDITION_COLOR.blocked : CONDITION_COLOR.steep, text: i.text }));
  return [];
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string, size = 1): void {
  g.save(); g.translate(x, y); g.rotate(angle); g.scale(size, size);
  g.beginPath(); g.moveTo(7, 0); g.lineTo(-5, -4.5); g.lineTo(-2.5, 0); g.lineTo(-5, 4.5); g.closePath();
  g.fillStyle = color; g.strokeStyle = "#0b1a24"; g.lineWidth = 1.2; g.fill(); g.stroke(); g.restore();
}

const COPY = {
  zh: {
    title: "小地图", tabs: { routes: "路线", audit: "拥堵估算", monsters: "怪兽" }, drive: "路况", follow: "跟随", whole: "全城", close: "收起小地图", open: "展开小地图",
    monsterLoading: "正在寻找遭遇点…", monsterError: "遭遇点搜索失败，请稍后重试。", monsterEmpty: "当前城市没有可用遭遇点。", monsterCount: (count: number) => `${count} 个怪兽遭遇点 · 点选定位`,
    routes: (roads: number, bridges: number) => `${roads} 段路 · ${bridges} 座桥`,
    computing: "正在估算高峰车流…",
    // 摘要一行装得下：拥堵/偏慢/断路三个数，到不了的出行占比只在有时才加；「这是估算」写在悬停提示（title）与图例旁的标签页名里。
    audit: (t: TrafficModel, blocked: number) => `拥堵 ${t.counts.jam} · 偏慢 ${t.counts.slow}${blocked ? ` · 断路 ${blocked}` : ""}${t.unreachable ? ` · ${Math.round((t.unreachable / Math.max(1, t.trips)) * 100)}% 到不了` : ""}`,
    driveSummary: (m: MinimapModel) => (m.counts.blocked ? `开不过去 ${m.counts.blocked}` : "全城可通行") + (m.counts.steep ? ` · 很陡 ${m.counts.steep}` : ""),
    hint: { routes: "点地图，镜头飞过去。", audit: "估算：按街区用地生成高峰出行、按拥堵后的行程时间走最短路；高架不计入。紫色虚线的路车开不过去，修复城市里可以修。", monsters: "点怪兽定位，再点击城市中的遭遇标记进入机甲战棋。", drive: "红 = 开不过去，琥珀 = 很陡。三角是你的车。" },
    legend: { routes: ["主干道", "次干道", "小路", "桥", "高架", "镜头"], audit: ["畅通", "较忙", "偏慢", "拥堵", "开不过去"], monsters: ["怪兽遭遇点", "镜头"], drive: ["开不过去", "很陡", "正常路", "我的位置"] },
  },
  en: {
    title: "Minimap", tabs: { routes: "Routes", audit: "Traffic est.", monsters: "Monsters" }, drive: "Road conditions", follow: "Follow", whole: "City", close: "Collapse minimap", open: "Expand minimap",
    monsterLoading: "Finding encounters…", monsterError: "Encounter search failed.", monsterEmpty: "No encounters available in this city.", monsterCount: (count: number) => `${count} encounters · select to focus`,
    routes: (roads: number, bridges: number) => `${roads} roads · ${bridges} bridge${bridges === 1 ? "" : "s"}`,
    computing: "Estimating peak traffic…",
    audit: (t: TrafficModel, blocked: number) => `Jam ${t.counts.jam} · Slow ${t.counts.slow}${blocked ? ` · Cut ${blocked}` : ""}${t.unreachable ? ` · ${Math.round((t.unreachable / Math.max(1, t.trips)) * 100)}% stranded` : ""}`,
    driveSummary: (m: MinimapModel) => (m.counts.blocked ? `Blocked ${m.counts.blocked}` : "All drivable") + (m.counts.steep ? ` · Steep ${m.counts.steep}` : ""),
    hint: { routes: "Click to fly the camera there.", audit: "Estimate: peak trips from block land use, routed by congested travel time; expressways not counted. Dashed purple roads can't be driven; fix them in Repair city.", monsters: "Select a monster to focus, then click its city marker to start tactics.", drive: "Red = cars can't pass, amber = steep. The triangle is your car." },
    legend: { routes: ["Arterial", "Secondary", "Local", "Bridge", "Expressway", "Camera"], audit: ["Free", "Busy", "Slow", "Jammed", "Can't pass"], monsters: ["Encounter", "Camera"], drive: ["Can't pass", "Steep", "Road", "You"] },
  },
} as const;

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? (v as T) : fallback; } catch { return fallback; }
}

export type MinimapDriving = Readonly<{ active: boolean; pose: () => Pose | null }>;

export function CityMinimap({ engine, hidden, language = "zh", driving, encounters }: {
  engine: RefObject<CityEngine | null>; hidden: boolean; language?: string; driving?: MinimapDriving; encounters: EncounterState;
}) {
  const copy = language === "en" ? COPY.en : COPY.zh;
  const [open, setOpen] = useState(() => readStored(STORAGE.open, ["1", "0"], "1") === "1");
  const [tab, setTab] = useState<Tab>(() => readStored(STORAGE.tab, ["routes", "audit", "monsters"], "routes"));
  const [follow, setFollow] = useState(true);
  const [layout, setLayout] = useState<CityLayout | null>(null);
  const [traffic, setTraffic] = useState<TrafficModel | null>(null);
  const [hover, setHover] = useState<Spot | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View | null>(null);
  const spotsRef = useRef<Spot[]>([]);
  const drivingActive = driving?.active ?? false;
  // 位姿读取器放进 ref：宿主每次渲染都传新对象（驾驶 HUD 每秒刷新多次），放进依赖会反复重建底图。
  const poseOf = useRef(driving?.pose); poseOf.current = driving?.pose;
  const mode: Mode = drivingActive ? "drive" : tab;
  useEffect(() => { try { localStorage.setItem(STORAGE.open, open ? "1" : "0"); localStorage.setItem(STORAGE.tab, tab); } catch { /* 无痕模式：不记 */ } }, [open, tab]);
  // 生效布局换了没有（修复工具每次编辑产出新布局对象）。
  useEffect(() => {
    if (hidden) return;
    const poll = () => { const next = engine.current?.currentLayout ?? null; setLayout((prev) => (prev === next ? prev : next)); };
    poll(); const timer = window.setInterval(poll, 500);
    return () => window.clearInterval(timer);
  }, [engine, hidden]);
  const model = useMemo(() => (layout ? minimapModel(layout) : null), [layout]);
  // 车流估算只在打开「道路审计」时算（4000 楼约 0.2 s），放到下一拍，先把「正在估算」画出来。
  useEffect(() => {
    setTraffic(null);
    if (!layout || !model || mode !== "audit" || !open || hidden) return;
    const timer = window.setTimeout(() => setTraffic(trafficModel(layout, model.blocked)), 30);
    return () => window.clearTimeout(timer);
  }, [layout, model, mode, open, hidden]);
  const spots = useMemo(() => mode === "monsters" ? encounters.encounters.map((point) => ({ at: point.at, color: "#ff586c", text: { zh: `${{ flat: "平地", shore: "靠岸", ridge: "翻山", alley: "巷战" }[point.shape]}怪兽遭遇点`, en: `${point.shape} monster encounter` } })) : (model ? spotsOf(model, traffic, mode) : []), [model, traffic, mode, encounters]);
  spotsRef.current = spots;
  const ratio = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);

  useEffect(() => {
    if (hidden || !open || !model) return;
    if (!canvas) return;
    canvas.width = SIZE * ratio; canvas.height = SIZE * ratio;
    const g = canvas.getContext("2d"); if (!g) return;
    // 整城视图画一次存成位图，每帧只叠点与箭头；跟随视图每 ~80 ms 按车的位置重画（只画视窗里的路）。
    const whole = wholeView(model);
    let base: HTMLCanvasElement | null = null;
    const following = mode === "drive" && follow;
    if (!following) {
      base = document.createElement("canvas"); base.width = SIZE * ratio; base.height = SIZE * ratio;
      const bg = base.getContext("2d"); if (bg) { bg.setTransform(ratio, 0, 0, ratio, 0, 0); drawMap(bg, model, traffic, mode, whole, false); }
    }
    const followBase = document.createElement("canvas"); followBase.width = SIZE * ratio; followBase.height = SIZE * ratio;
    let lastFollow = -Infinity;
    let frame = 0;
    const draw = (now: number) => {
      const pose = mode === "drive" ? poseOf.current?.() ?? null : null;
      let view = whole;
      if (following && pose) {
        view = { cx: pose.x, cz: pose.z, span: FOLLOW_SPAN };
        if (now - lastFollow > 80) {
          lastFollow = now;
          const fg = followBase.getContext("2d"); if (fg) { fg.setTransform(ratio, 0, 0, ratio, 0, 0); drawMap(fg, model, traffic, mode, view, true); }
        }
        base = followBase;
      } else if (following && !base) {
        base = document.createElement("canvas"); base.width = SIZE * ratio; base.height = SIZE * ratio;
        const bg = base.getContext("2d"); if (bg) { bg.setTransform(ratio, 0, 0, ratio, 0, 0); drawMap(bg, model, traffic, mode, whole, false); }
      }
      viewRef.current = view;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
      if (base) g.drawImage(base, 0, 0);
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      const pulse = 0.5 + 0.5 * Math.sin(now / 260);
      for (const spot of spotsRef.current) {
        const c = toCanvas(view, spot.at.x, spot.at.z);
        if (c.x < -8 || c.y < -8 || c.x > SIZE + 8 || c.y > SIZE + 8) continue;
        g.globalAlpha = 0.3 + 0.45 * pulse; g.beginPath(); g.arc(c.x, c.y, 3 + pulse * 3, 0, Math.PI * 2); g.fillStyle = spot.color; g.fill();
        g.globalAlpha = 1;
        if (mode === "monsters") {
          g.save(); g.translate(c.x, c.y); g.rotate(Math.PI / 4); g.fillStyle = spot.color; g.fillRect(-4, -4, 8, 8); g.strokeStyle = "#fff"; g.lineWidth = 1; g.strokeRect(-4, -4, 8, 8); g.restore();
        } else { g.beginPath(); g.arc(c.x, c.y, 2, 0, Math.PI * 2); g.fill(); }
      }
      if (pose) {
        const c = toCanvas(view, pose.x, pose.z);
        g.globalAlpha = 0.25; g.beginPath(); g.arc(c.x, c.y, 9 + pulse * 2, 0, Math.PI * 2); g.fillStyle = "#4dd2ff"; g.fill(); g.globalAlpha = 1;
        arrow(g, c.x, c.y, pose.heading, "#4dd2ff", 1.15);
      } else if (mode !== "drive") {
        const photo = engine.current?.photoView();
        if (photo) {
          const [px, , pz] = photo.position; const [tx, , tz] = photo.target;
          const c = toCanvas(view, tx, tz); arrow(g, c.x, c.y, Math.atan2(tz - pz, tx - px), "#4dd2ff");
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [canvas, engine, hidden, open, model, traffic, mode, follow, ratio]);

  if (hidden || !model) return null;
  const pointer = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(); const view = viewRef.current ?? wholeView(model);
    const sx = (event.clientX - rect.left) * (SIZE / rect.width), sy = (event.clientY - rect.top) * (SIZE / rect.height);
    let best: Spot | null = null; let bestD = 9;
    for (const spot of spotsRef.current) { const c = toCanvas(view, spot.at.x, spot.at.z); const d = Math.hypot(c.x - sx, c.y - sy); if (d < bestD) { bestD = d; best = spot; } }
    return { x: view.cx - view.span / 2 + sx / scaleOf(view), z: view.cz - view.span / 2 + sy / scaleOf(view), spot: best };
  };
  const bridges = model.roads.filter((r) => r.cls === "bridge").length;
  const summary = mode === "routes" ? copy.routes(model.roads.length - bridges, bridges) : mode === "audit" ? (traffic ? copy.audit(traffic, model.blocked.size) : copy.computing) : mode === "monsters" ? (encounters.status === "loading" ? copy.monsterLoading : encounters.status === "error" ? copy.monsterError : spots.length ? copy.monsterCount(spots.length) : copy.monsterEmpty) : copy.driveSummary(model);
  const bad = mode === "audit" ? !!traffic && (traffic.counts.jam > 0 || traffic.unreachable > 0 || model.blocked.size > 0) : mode === "drive" && model.counts.blocked > 0;
  const swatches: readonly string[] = mode === "routes" ? [ROAD_COLOR.main, ROAD_COLOR.secondary, ROAD_COLOR.local, ROAD_COLOR.bridge, HIGHWAY]
    : mode === "audit" ? [TRAFFIC_COLOR.free, TRAFFIC_COLOR.busy, TRAFFIC_COLOR.slow, TRAFFIC_COLOR.jam, IMPASSABLE] : mode === "monsters" ? ["#ff586c"] : [CONDITION_COLOR.blocked, CONDITION_COLOR.steep, ROAD_COLOR.secondary];
  const labels = copy.legend[mode];
  // Controls and status occupy their own rows; the square canvas stays unobscured.
  // The color key is optional, and keyboard users can open it without hovering.
  return <aside className={`city-minimap${open ? "" : " is-collapsed"}${drivingActive ? " is-driving" : ""}`} aria-label={copy.title}>
    <div className="city-minimap-frame" aria-hidden={!open}>
      <div className="city-minimap-top city-minimap-tabs" role={mode === "drive" ? "group" : "tablist"}>
        {mode === "drive" ? <>
          <button className={follow ? "is-on" : ""} aria-pressed={follow} onClick={() => setFollow(true)}>{copy.follow}</button>
          <button className={follow ? "" : "is-on"} aria-pressed={!follow} onClick={() => setFollow(false)}>{copy.whole}</button>
        </> : (["routes", "audit", "monsters"] as const).map((id) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "is-on" : ""} onClick={() => { setHover(null); setTab(id); }}>{copy.tabs[id]}</button>)}
      </div>
      <div className="city-minimap-map">
        <canvas ref={setCanvas} width={SIZE} height={SIZE} style={{ width: SIZE, height: SIZE, cursor: mode === "drive" ? "default" : "crosshair" }}
          onMouseMove={(event) => setHover(pointer(event).spot)} onMouseLeave={() => setHover(null)}
          onClick={(event) => { if (mode === "drive") return; const p = pointer(event); engine.current?.focusPoint(p.spot ? p.spot.at.x : p.x, p.spot ? p.spot.at.z : p.z); }} />
        {mode === "monsters" && spots.map((spot, index) => {
          const position = toCanvas(wholeView(model), spot.at.x, spot.at.z);
          const name = language === "en" ? spot.text.en : spot.text.zh;
          return <button key={index} type="button" className="city-minimap-spot" style={{ left: position.x, top: position.y }} aria-label={name}
            onMouseEnter={() => setHover(spot)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(spot)} onBlur={() => setHover(null)}
            onClick={() => engine.current?.focusPoint(spot.at.x, spot.at.z)} />;
        })}
        {mode === "monsters" && hover && (() => {
          const position = toCanvas(wholeView(model), hover.at.x, hover.at.z);
          return <div role="tooltip" className="city-minimap-tooltip" style={{ left: Math.max(4, Math.min(SIZE - 4, position.x)), top: Math.max(4, position.y - 12) }}>{language === "en" ? hover.text.en : hover.text.zh}</div>;
        })()}
      </div>
      <div className="city-minimap-bottom">
        <p className={`city-minimap-summary ${hover && mode !== "monsters" ? "is-detail" : bad ? "is-bad" : "is-ok"}`} title={copy.hint[mode]}>{hover && mode !== "monsters" ? (language === "en" ? hover.text.en : hover.text.zh) : summary}</p>
        {mode === "monsters" && spots.length > 0 && <div className="city-minimap-encounters" role="group" aria-label={language === "en" ? "Focus encounters" : "定位遭遇点"}>
          {spots.map((spot, index) => <button key={index} type="button" onClick={() => engine.current?.focusPoint(spot.at.x, spot.at.z)}
            onFocus={() => setHover(spot)} onBlur={() => setHover(null)}>{language === "en" ? spot.text.en : spot.text.zh}</button>)}
        </div>}
        <details className="city-minimap-key"><summary>{language === "en" ? "Legend" : "图例"}</summary>
        <ul className="city-minimap-legend">
          {swatches.map((color, i) => <li key={labels[i]}><i style={{ background: color }} className={mode === "audit" && i === 4 ? "is-dashed" : undefined} />{labels[i]}</li>)}
          {(mode === "routes" || mode === "drive" || mode === "monsters") && <li><i className="is-arrow" />{labels[labels.length - 1]}</li>}
        </ul></details>
      </div>
    </div>
    <button className="city-minimap-handle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? copy.close : copy.open} title={open ? copy.close : copy.open}>
      <span aria-hidden="true">{open ? "‹" : "›"}</span>{!open && <em>{copy.title}</em>}
    </button>
  </aside>;
}
