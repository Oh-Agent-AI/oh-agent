import { METER_MODEL_SCALE } from "../../worldScale";
import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { hashSeed } from "../../../cityModel";
import { buildIsletMansion } from "../../cityIsletMansion";

/** 地标「islet-mansion」：豪宅岛上的海湾现代豪宅（cityIsletMansion 程序化拼装）。
 *  seed 从地标 id 派生；scale 缩放整栋（环路外侧的住宅比北侧大宅小一号）；reach（到岸线的世界距离）
 *  换算成局部长度后决定码头铺多远，缺省 30。 */
export function drawIsletMansion({ group, landmark, neon, host }: LandmarkCtx): void {
  // 模型按米建（台地 34 × 26 m）：整体乘 METER_MODEL_SCALE 换算到世界单位；reach 是世界单位，换回模型米数给码头用。
  const scale = (landmark.scale ?? 1) * METER_MODEL_SCALE;
  const build = buildIsletMansion(hashSeed(landmark.id), neon, (landmark.reach ?? 30) / scale);
  build.group.scale.setScalar(scale);
  build.group.traverse((object) => { if ((object as THREE.Mesh).isMesh) { object.castShadow = true; object.receiveShadow = true; } });
  group.add(build.group);
  host.disposables.push(...build.disposables);
}
