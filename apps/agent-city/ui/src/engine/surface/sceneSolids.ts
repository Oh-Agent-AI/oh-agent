/** Rendered solid obstacles of the CURRENT scene, frozen at capture time (display heights, not targets).
 * THREE is read here and only plain numbers leave: each visible mesh instance's geometry bounding box
 * under its world matrix becomes a parallelepiped (exact for rotation + scale, still exact under shear).
 *
 * 白名单而不是黑名单：未命名的顶层网格（车、船、云、鸟）是动态或装饰，不能拦车；路面、人行道、
 * 路灯装饰（city-infrastructure-decorative）、沙滩/码头小品不是「建筑」。悬索桥与桁架桥的杆件已由
 * 结构描述符给出（structureCompiler），这里不再收一遍。被停到地下（y < −5，空槽位）的实例跳过。 */
import * as THREE from "three";
import type { SolidInput } from "../../game/driving/CollisionIndex";

export const SCENE_SOLID_INCLUDE: readonly string[] = Object.freeze([
  "city-shafts-", "city-roof-profile-", "city-massing", "city-vice-context-", "city-civic-boxes", "city-civic-cylinders",
  "city-public-sites-boxes", "city-public-sites-cylinders", "city-garden-boxes", "city-garden-roofs", "city-garden-trees", "city-garden-rocks",
  "city-landmark-", "city-lifeguard-towers",
]);
export const SCENE_SOLID_EXCLUDE: readonly string[] = Object.freeze(["city-landmark-suspension-bridge", "city-landmark-truss-bridge"]);

const PARKED_BELOW = -5;

/** Which whitelisted family a mesh belongs to (its own or an ancestor's name), or null. */
function familyOf(object: THREE.Object3D): string | null {
  let family: string | null = null;
  for (let o: THREE.Object3D | null = object; o; o = o.parent) {
    if (!o.name) continue;
    if (SCENE_SOLID_EXCLUDE.some((x) => o!.name.startsWith(x))) return null;
    if (SCENE_SOLID_INCLUDE.some((x) => o!.name.startsWith(x))) family = o.name;
  }
  return family;
}
const visible = (object: THREE.Object3D) => { for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false; return true; };

export function collectSceneSolids(root: THREE.Object3D): SolidInput[] {
  root.updateMatrixWorld(true);
  const out: SolidInput[] = [];
  const m = new THREE.Matrix4(); const c = new THREE.Vector3(); const corner = new THREE.Vector3();
  let mesh = 0;
  root.traverse((object) => {
    const o = object as THREE.Mesh & Partial<THREE.InstancedMesh>;
    if (!(o as THREE.Mesh).isMesh || !o.geometry) return;
    const family = familyOf(o); if (!family || !visible(o)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox!; if (box.isEmpty()) return;
    const id = mesh++;
    const count = o.isInstancedMesh ? o.count ?? 0 : 1;
    for (let i = 0; i < count; i++) {
      if (o.isInstancedMesh) { o.getMatrixAt!(i, m); m.premultiply(o.matrixWorld); } else m.copy(o.matrixWorld);
      box.getCenter(c).applyMatrix4(m);
      const e = m.elements; const sx = (box.max.x - box.min.x) / 2, sy = (box.max.y - box.min.y) / 2, sz = (box.max.z - box.min.z) / 2;
      // 平面装饰片（小岛庄园地面、广场圆盘等 city-landmark-* 家族新增成员）包围盒高度为 0：
      // 零体积盒子不是有效障碍（swept SAT 无从产生阻挡），跳过而不是让碰撞索引整体拒绝。
      if (sx < 1e-6 || sy < 1e-6 || sz < 1e-6) continue;
      const axes = [{ x: e[0] * sx, y: e[1] * sx, z: e[2] * sx }, { x: e[4] * sy, y: e[5] * sy, z: e[6] * sy }, { x: e[8] * sz, y: e[9] * sz, z: e[10] * sz }] as const;
      corner.set(c.x + Math.abs(axes[0].x) + Math.abs(axes[1].x) + Math.abs(axes[2].x), c.y + Math.abs(axes[0].y) + Math.abs(axes[1].y) + Math.abs(axes[2].y), 0);
      if (corner.y < PARKED_BELOW) continue;
      out.push(Object.freeze({ id: `scene:${family}:${id}:${i}`, role: family.replace(/:.*$/, "").replace(/-\d+$/, ""), kind: "box", center: Object.freeze({ x: c.x, y: c.y, z: c.z }), halfAxes: Object.freeze(axes) }));
    }
  });
  return out;
}
