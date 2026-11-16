#!/usr/bin/env node
// 体验包（city-experience）解析：把一个**自包含目录**还原成与发布物相同的
// 「载具 profile + 玩法 pack + 门」形状，供无头游戏 MCP 与干净客户端使用。
//
// 为什么不是"再读一次 Creator 库"：P0 要的是可交付、可安装、可重建的作品。
// 干净机器上没有 `state/creator/projects.sqlite`，也没有项目资产目录，所以包里必须
// 带齐 release.json（冻结发布快照）、layout.json（v3 布局快照，含锚点几何）和 assets；
// 校验逐字节（contentDigest 覆盖 manifest 全文，files[] 覆盖每个文件），任何一项对不上
// 都拒绝启动，而不是"尽量跑"。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { canonicalJson } from "../../../packages/agent-vitals-city-sdk/src/package.ts";
import { resolveGates } from "./releaseStore.mjs";

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 512;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

const fail = code => Object.assign(new Error(code), { code });
const sha256 = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function readJson(path, code) {
  let raw;
  try { raw = readFileSync(path); } catch { throw fail(code); }
  try { return JSON.parse(raw.toString("utf8")); } catch { throw fail(code); }
}

/** 安全相对路径：不接受绝对路径、`..`，也不接受越出包目录的写法。 */
function insidePath(dir, relative) {
  if (typeof relative !== "string" || !relative || isAbsolute(relative)) throw fail("experience_manifest_invalid");
  const base = resolve(dir);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}/`)) throw fail("experience_manifest_invalid");
  return target;
}

function verifyFile(dir, entry) {
  if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.digest !== "string"
    || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > MAX_FILE_BYTES) {
    throw fail("experience_manifest_invalid");
  }
  const path = insidePath(dir, entry.path);
  let stats;
  try { stats = statSync(path); } catch { throw fail("experience_file_missing"); }
  if (!stats.isFile() || stats.size !== entry.byteLength) throw fail("experience_file_digest_mismatch");
  const bytes = readFileSync(path);
  if (sha256(bytes) !== entry.digest) throw fail("experience_file_digest_mismatch");
  return bytes;
}

/**
 * Resolve one installed experience package.
 *
 * @returns {{
 *   experienceId: string, version: string, contentDigest: string,
 *   releaseId: string, projectId: string, revision: number, gameType: "flight" | "driving",
 *   vehicleId: string | null, vehicle: object | null, game: object, mounts: object[],
 *   layout: { cityId: string | null, cityRevision: number | null, layoutId: string | null, worldRevision: string | null },
 *   world: { seed: number, profile: string },
 *   boundAnchors: Array<{ mountId: string, slot: string, anchorIds: string[] }>,
 *   gates: Array<{ x: number, y: number, z: number, radius: number }> | null,
 *   gateSource: "layout-geometry" | null, warnings: string[], assets: object[],
 * }}
 */
export function resolveExperience({ dir }) {
  if (typeof dir !== "string" || !dir) throw fail("experience_dir_invalid");
  const manifest = readJson(join(dir, "manifest.json"), "experience_manifest_missing");
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.kind !== "city-experience") throw fail("experience_kind_unsupported");
  if (typeof manifest.experienceId !== "string" || !IDENTIFIER.test(manifest.experienceId)) throw fail("experience_manifest_invalid");
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw fail("experience_manifest_invalid");
  if (typeof manifest.contentDigest !== "string") throw fail("experience_manifest_invalid");
  const files = manifest.files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw fail("experience_manifest_invalid");
  // contentDigest 覆盖 manifest 全文（去掉自身），任何 metadata 改动都会被发现。
  const { contentDigest, ...rest } = manifest;
  if (sha256(canonicalJson(rest)) !== contentDigest) throw fail("experience_digest_mismatch");
  const byPath = new Map();
  for (const entry of files) {
    if (byPath.has(entry?.path)) throw fail("experience_manifest_invalid");
    byPath.set(entry.path, verifyFile(dir, entry));
  }

  const releaseRaw = byPath.get("release.json");
  const layoutRaw = byPath.get("layout.json");
  if (!releaseRaw || !layoutRaw) throw fail("experience_manifest_invalid");
  let snapshot, layoutSnapshot;
  try { snapshot = JSON.parse(releaseRaw.toString("utf8")); layoutSnapshot = JSON.parse(layoutRaw.toString("utf8")); } catch { throw fail("experience_manifest_invalid"); }

  if (!isRecord(manifest.release) || snapshot.projectId !== manifest.release.projectId
    || snapshot.revision !== manifest.release.revision || snapshot.releaseId !== undefined && snapshot.releaseId !== manifest.release.releaseId) {
    throw fail("experience_release_invalid");
  }
  const gameType = snapshot.gameType === "flight" ? "flight" : snapshot.gameType === "driving" ? "driving" : null;
  if (!gameType || gameType !== manifest.release.gameType) throw fail("experience_release_invalid");
  if (!isRecord(snapshot.game)) throw fail("experience_release_invalid");
  const mounts = Array.isArray(snapshot.mounts) ? snapshot.mounts : [];
  if (!mounts.length || mounts.length > 16) throw fail("experience_release_invalid");
  // 玩法摘要与 Studio 发布时同一算法；对不上说明包被改过或打包时就算错了。
  const gameDigest = sha256(canonicalJson(snapshot.game));
  for (const mount of mounts) {
    if (!isRecord(mount) || mount.game?.digest !== gameDigest || mount.game?.id !== snapshot.game.id
      || typeof mount.entryAnchorId !== "string" || !isRecord(mount.bindings)) throw fail("experience_game_digest_mismatch");
  }
  const vehicle = isRecord(snapshot.vehicle) ? snapshot.vehicle : null;
  if (gameType === "flight" && (!vehicle || vehicle.id !== snapshot.vehicleId)) throw fail("experience_vehicle_invalid");

  // 布局快照必须是 v3：没有锚点几何的包在干净客户端上**无法定位门**，不能算可交付。
  if (!isRecord(layoutSnapshot) || layoutSnapshot.schemaVersion !== 3
    || !Array.isArray(layoutSnapshot.layout?.anchors) || !Array.isArray(layoutSnapshot.geometry)) {
    throw fail("experience_layout_incomplete");
  }
  if (layoutSnapshot.cityId !== manifest.world?.cityId || layoutSnapshot.cityRevision !== manifest.world?.cityRevision
    || layoutSnapshot.worldRevision !== manifest.world?.worldRevision) throw fail("experience_release_invalid");

  const boundAnchors = [];
  for (const mount of mounts) {
    for (const [slot, anchorIds] of Object.entries(mount.bindings)) {
      if (!Array.isArray(anchorIds) || !anchorIds.length) throw fail("experience_release_invalid");
      boundAnchors.push({ mountId: String(mount.mountId ?? ""), slot, anchorIds: anchorIds.map(String) });
    }
  }
  const resolved = resolveGates({ boundAnchors, layoutSnapshot });
  const layout = { cityId: snapshot.cityId ?? manifest.world?.cityId ?? null, cityRevision: snapshot.cityRevision ?? manifest.world?.cityRevision ?? null,
    layoutId: snapshot.layoutId ?? layoutSnapshot.layout?.id ?? null, worldRevision: snapshot.worldRevision ?? manifest.world?.worldRevision ?? null };
  return { experienceId: manifest.experienceId, version: manifest.version, contentDigest,
    releaseId: manifest.release.releaseId ?? `experience:${manifest.experienceId}@${manifest.version}`,
    projectId: snapshot.projectId, revision: snapshot.revision, gameType,
    vehicleId: snapshot.vehicleId ?? null, vehicle, game: snapshot.game, mounts, layout,
    world: { seed: manifest.world?.seed ?? 0, profile: manifest.world?.profile ?? "" },
    boundAnchors, gates: resolved.gates, gateSource: resolved.gateSource,
    warnings: resolved.warnings, assets: Array.isArray(manifest.assets) ? manifest.assets : [] };
}
