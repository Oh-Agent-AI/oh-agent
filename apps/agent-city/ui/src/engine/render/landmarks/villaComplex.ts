import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { hashSeed } from "../../../cityModel";
import { buildVillaComplex } from "../../cityLandmarkVilla";

/** 地标「villa-complex」的程序化造型（从 cityParts.buildLandmarks 的 if 链原样搬出，行为不变）。 */
export function drawVillaComplex({ group, landmark, neon, host }: LandmarkCtx): void {
  // 地中海庄园（L-3）：整组由 cityLandmarkVilla 程序化拼装（白灰泥主体 + 临水拱廊 +
  // 红陶四坡顶 + 钟塔），seed 从地标 id 派生——同 seed 同庄园。
  const build = buildVillaComplex(hashSeed(landmark.id), neon);
  build.group.traverse((object) => { if ((object as THREE.Mesh).isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  group.add(build.group);
  host.disposables.push(...build.disposables);
  host.landmarkSpinners.push(...build.spinners);
}
