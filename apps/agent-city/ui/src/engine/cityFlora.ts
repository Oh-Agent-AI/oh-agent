/**
 * 生态带植被（CITY_PLANNING_SPEC §4.1 / §4.5）：Kenney Nature Kit（CC0，见 ../assets/LICENSES.md）。
 *
 * 每个 .glb 合并成一份几何（材质色转成顶点色，单位高度、底面在 y=0），每个树种一个 InstancedMesh。
 * 种子决定生态带、生态带决定树种；树种之间按树位的确定性 hash 分配。
 * 随应用离线打包、运行时不联网；加载失败时城市保留程序化树（与贴图素材同一套降级规则）。
 */
import { m } from "./worldScale";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Biome } from "./cityPlan";
import palmUrl from "../assets/flora/tree_palm.glb?url";
import palmBendUrl from "../assets/flora/tree_palmBend.glb?url";
import palmTallUrl from "../assets/flora/tree_palmTall.glb?url";
import palmShortUrl from "../assets/flora/tree_palmDetailedShort.glb?url";
import bushLargeUrl from "../assets/flora/plant_bushLarge.glb?url";
import oakUrl from "../assets/flora/tree_oak.glb?url";
import defaultUrl from "../assets/flora/tree_default.glb?url";
import detailedUrl from "../assets/flora/tree_detailed.glb?url";
import fatUrl from "../assets/flora/tree_fat.glb?url";
import bushUrl from "../assets/flora/plant_bush.glb?url";
import pineRoundUrl from "../assets/flora/tree_pineRoundA.glb?url";
import pineTallUrl from "../assets/flora/tree_pineTallA_detailed.glb?url";
import pineDefaultUrl from "../assets/flora/tree_pineDefaultA.glb?url";
import coneDarkUrl from "../assets/flora/tree_cone_dark.glb?url";
import plateauUrl from "../assets/flora/tree_plateau.glb?url";
import thinUrl from "../assets/flora/tree_thin.glb?url";
import bushTriangleUrl from "../assets/flora/plant_bushTriangle.glb?url";
import defaultFallUrl from "../assets/flora/tree_default_fall.glb?url";
import simpleFallUrl from "../assets/flora/tree_simple_fall.glb?url";
import tallUrl from "../assets/flora/tree_tall.glb?url";

/** 一个树种：模型、在场景中的高度（世界单位，由真实米数经 worldScale.m 换算）、出现权重、可选的整体染色（樱花粉 / 枫红）。 */
export type FloraSpecies = { url: string; height: number; weight: number; tint?: string };

// 高度按真实米数写（1 单位 = 2 m）：棕榈 8–14、阔叶 9–12、松 12–18、灌木 1.5–2。曾直接写世界单位 6–12，按 2 m 读高了一倍。
export const BIOME_FLORA: Record<Biome, FloraSpecies[]> = {
  tropical: [
    { url: palmUrl, height: m(11), weight: 3 }, { url: palmBendUrl, height: m(10), weight: 2 }, { url: palmTallUrl, height: m(14), weight: 2 },
    { url: palmShortUrl, height: m(8), weight: 2 }, { url: bushLargeUrl, height: m(2), weight: 2 },
  ],
  temperate: [
    { url: oakUrl, height: m(12), weight: 3 }, { url: defaultUrl, height: m(10), weight: 3 }, { url: detailedUrl, height: m(12), weight: 2 },
    { url: fatUrl, height: m(9), weight: 2 }, { url: bushUrl, height: m(1.5), weight: 2 },
  ],
  boreal: [
    { url: pineRoundUrl, height: m(14), weight: 3 }, { url: pineTallUrl, height: m(18), weight: 3 }, { url: pineDefaultUrl, height: m(15), weight: 2 },
    { url: coneDarkUrl, height: m(12), weight: 2 }, { url: bushUrl, height: m(1.5), weight: 1 },
  ],
  savanna: [
    { url: plateauUrl, height: m(10), weight: 4 }, { url: thinUrl, height: m(11), weight: 2 }, { url: bushTriangleUrl, height: m(2), weight: 3 },
  ],
  eastasian: [
    { url: defaultFallUrl, height: m(7), weight: 3, tint: "#ffb7cf" }, // 樱花
    { url: simpleFallUrl, height: m(8), weight: 2, tint: "#d9442e" },  // 枫
    { url: tallUrl, height: m(10), weight: 2 },                        // 垂柳（近似）
    { url: pineRoundUrl, height: m(9), weight: 2 },                    // 园林松
    { url: bushUrl, height: m(1.5), weight: 2 },
  ],
};

const cache = new Map<string, Promise<THREE.BufferGeometry | null>>();

/** 加载并归一化一个模型：合并所有网格、材质色 → 顶点色、底面贴 y=0、高度归一为 1。 */
function loadSpecies(url: string): Promise<THREE.BufferGeometry | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const promise = new GLTFLoader().loadAsync(url).then((gltf) => {
    const parts: THREE.BufferGeometry[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const keep = new THREE.BufferGeometry();
      keep.setAttribute("position", geometry.getAttribute("position"));
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      keep.setAttribute("normal", geometry.getAttribute("normal"));
      if (geometry.index) keep.setIndex(geometry.index);
      const color = new THREE.Color((mesh.material as THREE.MeshStandardMaterial).color ?? "#6f9d63");
      const count = keep.getAttribute("position").count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) { colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b; }
      keep.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      parts.push(keep.index ? keep.toNonIndexed() : keep);
      geometry.dispose();
    });
    if (!parts.length) return null;
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (!merged) return null;
    merged.computeBoundingBox();
    const box = merged.boundingBox!;
    const height = Math.max(1e-3, box.max.y - box.min.y);
    merged.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    merged.scale(1 / height, 1 / height, 1 / height);
    return merged;
  }).catch((error) => {
    console.warn("[city] flora model unavailable", url, error);
    return null;
  });
  cache.set(url, promise);
  return promise;
}

export type LoadedFlora = Array<{ species: FloraSpecies; geometry: THREE.BufferGeometry }>;

/** 加载某个生态带的全部树种；任何一种失败都只是少一种，全部失败返回空数组（调用方保留程序化树）。 */
export async function loadBiomeFlora(biome: Biome): Promise<LoadedFlora> {
  const species = BIOME_FLORA[biome];
  const geometries = await Promise.all(species.map((item) => loadSpecies(item.url)));
  return species.flatMap((item, index) => (geometries[index] ? [{ species: item, geometry: geometries[index]! }] : []));
}
