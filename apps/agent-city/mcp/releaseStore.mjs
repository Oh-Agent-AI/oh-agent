#!/usr/bin/env node
// Creator 发布物解析（只读）：把 `releaseId` 还原成「载具 profile + 玩法 pack + 门锚点」，
// 供无头游戏操控 MCP 使用。数据来自 `<data_home>/state/creator/projects.sqlite`（Creator
// 自己的库，不是主权威库），全程只读、不写盘、不联网。
//
// 几何的现实（2026-11-15 现状）：City 适配器明确「geometry stays in the City adapter and is
// never serialized」，所以 v1/v2 布局快照里只有 anchors + links，没有 positionMeters /
// activationRadiusMeters —— **门的位置无法从库里还原**。这里不猜：
//   - 快照带 geometry（约定见 resolveRelease 的 geometryOf）→ 用它，逐条校验；
//   - 没有 → 返回 geometry: null，由调用方显式给 gates（MCP 会以 `gates_required` 收口）。
// 重生成城市布局不是替代方案：路网剪枝依赖真实会话数据，重排出的节点会和快照里的
// geometryRef 对不上（见 docs/CITY_GAME_MCP.md）。
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../../../packages/agent-vitals-city-sdk/src/package.ts";
// 触发半径的默认值与 City 试玩路径同一份（空域门复用路网节点时没有实测半径）。
import { RELEASE_ZONE_DEFAULT_RADIUS_METERS } from "../ui/src/game/activity/releaseLayout.ts";

const MAX_ANCHORS = 64;

const fail = code => Object.assign(new Error(code), { code });

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function openStore(dataHome) {
  const path = `${dataHome}/state/creator/projects.sqlite`;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    throw fail("creator_store_unavailable");
  }
}

function readJson(text, code) {
  try { return JSON.parse(text); } catch { throw fail(code); }
}

/** 严格读取布局快照里的几何（可选字段）。只接受本模块需要的形状，别的一律不认，
 *  避免"看起来能用"的半份数据把门放到错的位置。 */
function geometryOf(snapshot) {
  const entries = snapshot?.geometry;
  if (!Array.isArray(entries)) return null;
  const map = new Map();
  for (const entry of entries) {
    const ref = entry?.geometryRef;
    const position = entry?.positionMeters;
    if (typeof ref !== "string" || !ref || !position || typeof position !== "object") throw fail("layout_geometry_invalid");
    const { x, y, z } = position;
    if (![x, y, z].every(value => typeof value === "number" && Number.isFinite(value))) throw fail("layout_geometry_invalid");
    const radius = entry.activationRadiusMeters;
    if (radius !== undefined && !(typeof radius === "number" && Number.isFinite(radius) && radius > 0)) throw fail("layout_geometry_invalid");
    map.set(ref, { positionMeters: { x, y, z }, ...(radius === undefined ? {} : { activationRadiusMeters: radius }) });
  }
  return map;
}

/**
 * Resolve one published release.
 *
 * @returns {{
 *   releaseId: string, projectId: string, revision: number, gameType: "flight" | "driving",
 *   vehicleId: string | null, vehicle: object | null, game: object, mounts: object[],
 *   layout: { cityId: string | null, cityRevision: number | null, layoutId: string | null, worldRevision: string | null },
 *   boundAnchors: Array<{ mountId: string, slot: string, anchorIds: string[] }>,
 *   gates: Array<{ x: number, y: number, z: number, radius: number }> | null,
 *   gateSource: "layout-geometry" | null,
 *   warnings: string[],
 * }}
 */
export function resolveRelease({ dataHome, releaseId }) {
  if (typeof dataHome !== "string" || !dataHome) throw fail("data_home_required");
  if (typeof releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(releaseId)) throw fail("release_id_invalid");
  const db = openStore(dataHome);
  try {
    const row = db.prepare("SELECT release_id, project_id, revision, layout_id, world_revision, snapshot_json FROM creator_releases WHERE release_id = ?").get(releaseId);
    if (!row) throw fail("release_not_found");
    const snapshot = readJson(row.snapshot_json, "release_snapshot_invalid");
    if (snapshot.projectId !== row.project_id || snapshot.revision !== row.revision) throw fail("release_snapshot_invalid");
    const gameType = snapshot.gameType === "flight" ? "flight" : snapshot.gameType === "driving" ? "driving" : null;
    if (!gameType) throw fail("release_game_type_invalid");
    if (!snapshot.game || typeof snapshot.game !== "object") throw fail("release_game_invalid");
    const mounts = Array.isArray(snapshot.mounts) ? snapshot.mounts : [];
    if (!mounts.length || mounts.length > 16) throw fail("release_mounts_invalid");

    // 玩法摘要：与 Studio 发布时同一算法（canonical JSON + sha256），对不上就是发布物损坏。
    const gameDigest = sha256(canonicalJson(snapshot.game));
    for (const mount of mounts) {
      if (mount?.game?.digest !== gameDigest || mount?.game?.id !== snapshot.game.id) throw fail("release_game_digest_mismatch");
      if (!mount?.entryAnchorId || !mount?.bindings || typeof mount.bindings !== "object") throw fail("release_mount_invalid");
    }

    const vehicle = snapshot.vehicle && typeof snapshot.vehicle === "object" ? snapshot.vehicle : null;
    if (gameType === "flight" && (!vehicle || vehicle.id !== snapshot.vehicleId)) throw fail("release_vehicle_invalid");

    // 门锚点：bindings 是唯一权威（mount 已由宿主做过 capability/slot 校验）。
    const boundAnchors = [];
    for (const mount of mounts) {
      for (const [slot, anchorIds] of Object.entries(mount.bindings)) {
        if (!Array.isArray(anchorIds) || anchorIds.length > MAX_ANCHORS) throw fail("release_mount_invalid");
        boundAnchors.push({ mountId: String(mount.mountId ?? ""), slot, anchorIds: anchorIds.map(String) });
      }
    }

    const layout = { cityId: snapshot.cityId ?? null, cityRevision: snapshot.cityRevision ?? null,
      layoutId: snapshot.layoutId ?? row.layout_id ?? null, worldRevision: snapshot.worldRevision ?? row.world_revision ?? null };
    const warnings = [];
    const layoutSnapshot = readLayoutSnapshot(db, layout);
    if (!layoutSnapshot) warnings.push(layout?.cityId || layout?.worldRevision ? "layout_snapshot_missing" : "layout_scope_missing");
    const resolved = resolveGates({ boundAnchors, layoutSnapshot });
    for (const warning of resolved.warnings) if (!warnings.includes(warning)) warnings.push(warning);
    const gates = resolved.gates;
    const gateSource = resolved.gateSource;

    return { releaseId: row.release_id, projectId: row.project_id, revision: row.revision, gameType,
      vehicleId: snapshot.vehicleId ?? null, vehicle, game: snapshot.game, mounts,
      layout, boundAnchors, gates, gateSource, warnings };
  } finally {
    db.close();
  }
}

/**
 * 从冻结快照的绑定点 + 布局快照解析门。发布模式与体验包模式共用这一份逻辑：
 * 任一条几何缺失就整份不给——半份门等于把玩法挪了位置。
 *
 * @returns {{ gates: Array<{x:number,y:number,z:number,radius:number}> | null, gateSource: "layout-geometry" | null, warnings: string[] }}
 */
export function resolveGates({ boundAnchors, layoutSnapshot }) {
  const warnings = [];
  const geometry = layoutSnapshot ? geometryOf(layoutSnapshot) : null;
  if (!geometry) warnings.push("gate_geometry_not_serialized");
  const anchors = layoutSnapshot ? anchorsOf(layoutSnapshot) : new Map();
  let gates = null;
  let gateSource = null;
  if (geometry) {
    const resolved = [];
    for (const binding of boundAnchors) {
      for (const anchorId of binding.anchorIds) {
        const anchor = anchors.get(anchorId);
        if (!anchor) throw fail("gate_anchor_not_found");
        const entry = geometry.get(anchor.geometryRef);
        if (!entry) throw fail("gate_geometry_unresolved");
        // 空域门复用路网节点时几何没有实测半径：用与 City 试玩同一份默认触发球，
        // 并在 gate 上标注 radiusDefaulted，调用方不会以为这是测量值。
        const radius = entry.activationRadiusMeters ?? RELEASE_ZONE_DEFAULT_RADIUS_METERS;
        resolved.push({ x: entry.positionMeters.x, y: entry.positionMeters.y, z: entry.positionMeters.z, radius,
          ...(entry.activationRadiusMeters === undefined ? { radiusDefaulted: true } : {}) });
        if (entry.activationRadiusMeters === undefined && !warnings.includes("gate_radius_defaulted")) warnings.push("gate_radius_defaulted");
      }
    }
    gates = resolved;
    gateSource = "layout-geometry";
  }
  return { gates, gateSource, warnings };
}

/** 布局快照：先按 City 作用域（v2 表）找，再退回 legacy worldRevision 表。 */
function readLayoutSnapshot(db, layout) {
  if (layout.cityId && Number.isSafeInteger(layout.cityRevision)) {
    const row = db.prepare("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id = ? AND city_revision = ? AND world_revision = ? AND layout_id = ?")
      .get(layout.cityId, layout.cityRevision, layout.worldRevision ?? "", layout.layoutId ?? "");
    if (row) return readJson(row.snapshot_json, "layout_snapshot_invalid");
  }
  if (layout.worldRevision && layout.layoutId) {
    const row = db.prepare("SELECT snapshot_json FROM creator_city_layouts WHERE world_revision = ? AND layout_id = ?").get(layout.worldRevision, layout.layoutId);
    if (row) return readJson(row.snapshot_json, "layout_snapshot_invalid");
  }
  return null;
}

/** 锚点表只存在于布局快照里（anchors 是快照的一部分）。 */
function anchorsOf(layoutSnapshot) {
  const anchors = new Map();
  for (const anchor of layoutSnapshot?.layout?.anchors ?? []) {
    if (!anchor?.id || !anchor?.geometryRef) continue;
    anchors.set(anchor.id, { id: anchor.id, geometryRef: anchor.geometryRef, capabilities: anchor.capabilities ?? [] });
  }
  return anchors;
}
