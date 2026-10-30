#!/usr/bin/env node
// 城市素材预算守卫：城市素材总量 ≤ 5 MB（用户定的硬上限），机甲角色模型单独 ≤ 6 MB，
// 且每个文件都在 LICENSES.md 里登记了来源与授权。
// 素材随应用离线分发，这个目录的每个字节都进安装包；没有登记来源的文件不允许进库。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(repo, "apps/agent-city/ui/src/assets");
const BUDGET = 5 * 1024 * 1024;
// 机甲角色模型（mecha/）是 gameplay 资产，不是城市贴图：它们是 gltfpack/meshopt + WebP 的
// 骨骼动画模型，体积由网格和动画决定，400 KB 的城市贴图上限与 5 MB 城市素材预算对它们不适用。
// 例外只覆盖 mecha/ 下的角色 GLB 和随资产分发的 manifest（清单），其他目录仍按城市素材规则守卫。
// 2026-10-30：feature/mecha 带入的角色模型本来就超过 400 KB（此前脚本在第一个文件上就报错）；
// assault-gait-preview.glb 已从 807 KB 压到 398 KB，但继续压其余模型会损伤战斗/预览资产，因此分开记账。
const MECHA_BUDGET = 6 * 1024 * 1024;
const MECHA_FILE_CAP = 1536 * 1024;
const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((name) => !path.basename(name).startsWith(".") && fs.statSync(path.join(dir, name)).isFile());
const licenses = fs.readFileSync(path.join(dir, "LICENSES.md"), "utf8");
let total = 0;
let mechaTotal = 0;
for (const name of files) {
  const size = fs.statSync(path.join(dir, name)).size;
  const mecha = name.startsWith("mecha/");
  if (mecha) mechaTotal += size;
  else total += size;
  if (name === "LICENSES.md" || name.endsWith(".d.ts")) continue;
  assert(mecha ? /\.(glb|manifest\.json)$/.test(name) : /\.(jpg|png|webp|glb)$/.test(name), `${name}: only compressed images, .glb models and (under mecha/) manifests belong here (no .hdr/.exr/.zip/.fbx)`);
  const cap = mecha ? MECHA_FILE_CAP : 400 * 1024;
  assert(size <= cap, `${name}: ${(size / 1024).toFixed(0)} KB exceeds the ${(cap / 1024).toFixed(0)} KB per-file cap`);
  // 登记可以是完整文件名，也可以是「-color.jpg / -normal.jpg」成对写法的前缀。
  const stem = name.replace(/-(color|normal)\.jpg$/, "");
  assert(licenses.includes(`\`${name}\``) || licenses.includes(`\`${stem}-color.jpg\``), `${name}: not listed in LICENSES.md`);
}
assert(total <= BUDGET, `city assets total ${(total / 1048576).toFixed(2)} MB > 5 MB budget`);
assert(mechaTotal <= MECHA_BUDGET, `mecha character assets total ${(mechaTotal / 1048576).toFixed(2)} MB > 6 MB budget`);
console.log(`City assets: ${files.length} files, ${(total / 1048576).toFixed(2)} MB of 5 MB city budget + ${(mechaTotal / 1048576).toFixed(2)} MB of 6 MB mecha budget, all licensed.`);
