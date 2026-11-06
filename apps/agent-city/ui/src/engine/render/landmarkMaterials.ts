import * as THREE from "three";

/**
 * 地标材质缓存（CITY_BUILDING_MODEL_SPEC §8 批 0a）。
 * 曾经：`material(color, emissive)` 每次调用 new 一个 MeshLambertMaterial，一座地标几十个材质对象。
 * 现在：按 (color, emissive, side) 复用同一个对象。共享的前提是「产出后没人再改它」——
 *   - 夜窗贴图材质（twinTowers / twistTower / 城区地标的 landmarkWindows）由 setNightGlow 每帧改 emissive/emissiveMap，
 *     它们本来就直接 new，不经本工厂；
 *   - 凯旋门拱券原先造完再 `.side = DoubleSide`（会把共享材质整个改成双面），现改成造时传 side:"double"；
 *   - 其它要改材质的调用点一律传 { private: true } 拿一份不入缓存的私有材质。
 * 场景图哈希刻意不看材质身份，所以缓存不改任何哈希。
 */
export type MaterialOptions = { private?: boolean; side?: "front" | "double" };
export type MaterialFactory = (color: string, emissive?: number, options?: MaterialOptions) => THREE.MeshLambertMaterial;

/** 建工厂；每个新建的材质都回调 onCreate（宿主在这里登记 dispose）。缓存只活在一个工厂实例里（= 一次 buildLandmarks）。 */
export function createMaterialFactory(onCreate?: (material: THREE.MeshLambertMaterial) => void): MaterialFactory {
  const cache = new Map<string, THREE.MeshLambertMaterial>();
  return (color, emissive = 0, options = {}) => {
    const side = options.side ?? "front";
    const key = `${color.toLowerCase()}|${emissive}|${side}`;
    if (!options.private) { const hit = cache.get(key); if (hit) return hit; }
    const m = new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive), ...(side === "double" ? { side: THREE.DoubleSide } : {}) });
    onCreate?.(m);
    if (!options.private) cache.set(key, m);
    return m;
  };
}
