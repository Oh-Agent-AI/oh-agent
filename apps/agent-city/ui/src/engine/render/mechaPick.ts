/**
 * 停机坪机甲的点击认领。
 *
 * 夜里机甲几乎是黑的，玩家靠悬停提示瞄准；身体又是细网格，点偏一点就打在
 * 机场平台上。平台属于 `city-landmark-airport`，拾取得到 `decor:landmark:airport`，
 * 于是镜头锁到地标、战斗没开（GameMaster 夜景机坪）。
 *
 * 认领规则（外扩只吃机坪，不吃航站楼）：
 *  · 命中点落在某台机甲包围盒外扩一圈里，且这次命中就是机场地标 → 开战。
 *    肢体之间的空当、脚前的一小块停机坪都算。两台之间的缝被外扩接上。
 *  · 射线先穿过身体包围盒（空当），再打到更远的东西 → 开战。点在身体上却
 *    因为网格太瘦漏到背后的平台，也算。
 *  · 射线穿过外扩圈、但身后没有别的命中（对着天空点偏）→ 开战。
 * 航站楼、更近的会话楼、飞机都不在这三条里：点它们仍是原来的拾取。
 */
import * as THREE from "three";

/** 世界单位。1 单位 = 2 米，所以 8 = 身体周围 16 米的停机坪。
 *  三台局部间距 22；程序模型缩放 2 后半宽大约数单位，8 让相邻外扩相接。
 *  航站楼在小队前方大约 16 单位，外扩到不了。 */
export const PARKED_MECHA_PICK_PAD = 8;

const scratch = new THREE.Vector3();
const padded = new THREE.Box3();

export type MechaPickHit = {
  /** 射线参数距离（Raycaster 的 hit.distance，方向已归一）。 */
  distance: number;
  point: THREE.Vector3;
  /** 最近的几何命中是机场岛地标（平台、航站楼、塔台都算这一个 id）。 */
  airportLandmark: boolean;
};

/** 每台停着的机甲各一只世界包围盒，不要合成一只——合成会把间距里的大块机坪一起吞掉。 */
export function parkedMechaPickBoxes(squad: THREE.Object3D): THREE.Box3[] {
  squad.updateWorldMatrix(true, true);
  const boxes: THREE.Box3[] = [];
  for (const child of squad.children) {
    const box = new THREE.Box3().setFromObject(child);
    if (box.isEmpty() || !box.min.toArray().concat(box.max.toArray()).every(Number.isFinite)) continue;
    boxes.push(box);
  }
  return boxes;
}

function travel(ray: THREE.Ray, point: THREE.Vector3): number {
  return ray.origin.distanceTo(point);
}

/** 射线先碰到盒子时的世界距离；碰不到返回 null。方向不必是单位向量。 */
function entryDistance(ray: THREE.Ray, box: THREE.Box3): number | null {
  const point = ray.intersectBox(box, scratch);
  if (!point) return null;
  return travel(ray, point);
}

export function claimParkedMechaClick(input: {
  boxes: readonly THREE.Box3[];
  ray: THREE.Ray;
  hit: MechaPickHit | null;
}): boolean {
  const { boxes, ray, hit } = input;
  if (boxes.length === 0 || ray.direction.lengthSq() < 1e-12) return false;
  for (const box of boxes) {
    padded.copy(box).expandByScalar(PARKED_MECHA_PICK_PAD);
    // 点在身体旁边的机坪上：命中点在外扩里，且这次打到的就是机场岛。
    if (hit?.airportLandmark && padded.containsPoint(hit.point)) return true;
    // 网格太瘦，射线从肢体空当穿过去，先进入身体包围盒，再打到更远的表面。
    const throughBody = entryDistance(ray, box);
    if (throughBody !== null && (!hit || throughBody <= hit.distance + 1e-2)) return true;
    // 对着天空点偏：外扩圈里没有别的可拾取物。有命中时不靠这一条，
    // 否则擦到外扩再打中航站楼也会被抢走。
    if (!hit && entryDistance(ray, padded) !== null) return true;
  }
  return false;
}
