#!/usr/bin/env node
// 把一个**已发布**的 Creator 作品打成自包含体验包（city-experience）。
//
// 输入：Creator 自己的库（`<data_home>/state/creator/projects.sqlite`）+ 项目资产目录。
// 输出：一个可拷走的目录，干净机器上不依赖 Creator 库即可校验并启动：
//   manifest.json   体验元数据 + 每个文件的摘要 + contentDigest
//   release.json    冻结发布快照（玩法/挂载/载具/场景/资产引用，逐字保留）
//   layout.json     v3 布局快照（锚点 + 连线 + 锚点几何；干净客户端靠它定位门）
//   assets/<sha>.glb  发布引用到的资产字节（逐字节复制并再校验）
//
// 用法：node scripts/build-experience-package.mjs --release <id> --out <dir> [--version 1.0.0] [--data-home ~/.agent-vitals]
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/agent-vitals-city-sdk/src/package.ts";

const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = code => Object.assign(new Error(code), { code });

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}
const dataHome = arg("data-home", process.env.AV_DATA_HOME || `${process.env.HOME}/.agent-vitals`);
const releaseId = arg("release");
const outDir = arg("out");
const version = arg("version", "1.0.0");
if (!releaseId || !outDir) fail("experience_build_args");
const db = new DatabaseSync(`${dataHome}/state/creator/projects.sqlite`, { readOnly: true });
const row = db.prepare("SELECT release_id, project_id, revision, snapshot_json FROM creator_releases WHERE release_id = ?").get(releaseId);
if (!row) fail("release_not_found");
const snapshot = JSON.parse(row.snapshot_json);
const cityId = snapshot.cityId;
const cityRevision = snapshot.cityRevision;
// 布局快照必须带几何（v3）：v2 的包在干净客户端上无法定位门，不能算可交付。
const layoutRow = db.prepare("SELECT snapshot_json FROM creator_city_layouts_v2 WHERE city_id = ? AND city_revision = ? AND world_revision = ? AND layout_id = ?")
  .get(cityId, cityRevision, snapshot.worldRevision, snapshot.layoutId ?? snapshot.cityLayoutId);
if (!layoutRow) fail("layout_snapshot_missing");
const layoutSnapshot = JSON.parse(layoutRow.snapshot_json);
if (layoutSnapshot.schemaVersion !== 3 || !Array.isArray(layoutSnapshot.geometry) || !Array.isArray(layoutSnapshot.layout?.anchors)) fail("layout_snapshot_not_self_contained");
const cityRow = db.prepare("SELECT document_json FROM creator_city_revisions WHERE city_id = ? AND revision = ?").get(cityId, cityRevision)
  ?? db.prepare("SELECT document_json FROM creator_cities WHERE city_id = ?").get(cityId);
if (!cityRow) fail("city_not_found");
const city = JSON.parse(cityRow.document_json);
db.close();

mkdirSync(join(outDir, "assets"), { recursive: true });
const files = [];
function write(relative, bytes) {
  writeFileSync(join(outDir, relative), bytes);
  files.push({ path: relative, digest: sha256(bytes), byteLength: bytes.length });
}
const releaseBytes = Buffer.from(row.snapshot_json, "utf8");
const layoutBytes = Buffer.from(layoutRow.snapshot_json, "utf8");
write("release.json", releaseBytes);
write("layout.json", layoutBytes);
const assets = [];
for (const entry of snapshot.assets?.entries ?? []) {
  if (typeof entry?.sha256 !== "string" || !Number.isSafeInteger(entry.byteLength)) fail("experience_asset_entry_invalid");
  const source = `${dataHome}/state/creator/projects/${row.project_id}/assets/${entry.sha256}.glb`;
  let bytes;
  try { bytes = readFileSync(source); } catch { fail("experience_asset_missing"); }
  if (bytes.length !== entry.byteLength || sha256(bytes) !== `sha256:${entry.sha256}`) fail("experience_asset_digest_mismatch");
  const relative = `assets/${entry.sha256}.glb`;
  copyFileSync(source, join(outDir, relative));
  files.push({ path: relative, digest: sha256(bytes), byteLength: bytes.length });
  assets.push({ assetId: entry.assetId, relativePath: entry.relativePath, sha256: entry.sha256,
    byteLength: entry.byteLength, format: entry.format ?? "glb-v2", packagePath: relative });
}

const experienceId = `experience-${sha256(canonicalJson({ projectId: row.project_id, revision: row.revision })).slice(7, 23)}`;
const manifest = {
  schemaVersion: 1, kind: "city-experience", experienceId, version,
  world: { cityId, cityRevision, seed: city.seed ?? layoutSnapshot.seed, profile: city.profile ?? "", worldRevision: snapshot.worldRevision,
    layoutId: snapshot.layoutId ?? snapshot.cityLayoutId, layoutRevision: layoutSnapshot.layout?.id ?? null },
  release: { releaseId: row.release_id, projectId: row.project_id, revision: row.revision, gameType: snapshot.gameType, vehicleId: snapshot.vehicleId ?? null },
  assets, files,
};
manifest.contentDigest = sha256(canonicalJson(manifest));
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, experienceId, version, contentDigest: manifest.contentDigest, outDir,
  anchorCount: layoutSnapshot.layout.anchors.length, geometryCount: layoutSnapshot.geometry.length,
  assetCount: assets.length, files: files.map(file => file.path) }, null, 2));
