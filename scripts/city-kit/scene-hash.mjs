// 场景图哈希（CITY_BUILDING_MODEL_SPEC v2 §6.4）：对一个 THREE.Object3D 取「几何 + 世界矩阵 + 材质」的规范化哈希。
// 用途：证明重构（拆文件、材质缓存、改编译器）前后同一建筑完全等价，不需要 GPU、不依赖截图。
// 比较的是网格的多重集合：先各自成串再排序，所以子节点顺序不影响哈希；材质身份（是否共享同一对象）也不影响——
// 只看材质的可见属性，这样「材质缓存」这类优化不会让哈希变化。
import crypto from "node:crypto";

const r3 = (v) => Math.round(v * 1000) / 1000;
const hex = (c) => (c ? c.getHexString() : "-");

export function sceneDescriptor(THREE, root) {
  root.updateMatrixWorld(true);
  const rows = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const pos = g.getAttribute("position");
    const idx = g.getIndex();
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const verts = pos ? Array.from(pos.array, r3).join(",") : "";
    const index = idx ? Array.from(idx.array).join(",") : "";
    const inst = o.isInstancedMesh ? `${o.count}:${Array.from(o.instanceMatrix.array.subarray(0, o.count * 16), r3).join(",")}` : "";
    const mat = [m.type, hex(m.color), hex(m.emissive), m.side, m.transparent, r3(m.opacity ?? 1), r3(m.emissiveIntensity ?? 1), m.map ? "map" : "-", m.emissiveMap ? "emap" : "-", m.wireframe ? "wire" : "-"].join("|");
    rows.push([`v${verts.length}:${crypto.createHash("sha1").update(verts).digest("hex").slice(0, 12)}`, crypto.createHash("sha1").update(index).digest("hex").slice(0, 8), Array.from(o.matrixWorld.elements, r3).join(","), mat, inst, o.visible ? 1 : 0].join(";"));
  });
  rows.sort();
  return rows;
}

export function sceneHash(THREE, root) {
  const rows = sceneDescriptor(THREE, root);
  return { hash: crypto.createHash("sha1").update(rows.join("\n")).digest("hex").slice(0, 16), meshes: rows.length };
}

/** Node 里没有 OffscreenCanvas：给 renderCanvas 一个什么都不画的替身。贴图内容不进哈希（只记「有贴图」）。 */
export function installCanvasShim() {
  if (globalThis.OffscreenCanvas) return;
  const noop = new Proxy(function () {}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} }) : noop), set: () => true, apply: () => noop });
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return noop; } };
}
