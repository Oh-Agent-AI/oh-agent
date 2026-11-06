import * as THREE from "three";
import type { CarPath } from "./types";

export const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

/** 单位圆柱（半径 1、高 1、底面为原点）：sx/sz 当半径、sy 当高度。 */
export const CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 14).translate(0, 0.5, 0);
export { EXPRESSWAY_DECK_Y, EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH, EXPRESSWAY_DECK_TOP, EXPRESSWAY_RAMP, expresswayDeckHeights } from "../surface/structureProfiles";

/** 带「按自身颜色补自发光」的白底材质（颜色来自实例色）：彩色环境光下保住执行环境色相。 */
export function selfLitMaterial(amount: number): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * ${amount.toFixed(3)};`);
  };
  material.customProgramCacheKey = () => `city-self-lit-${amount.toFixed(3)}`;
  return material;
}

export function samplePolyline(path: CarPath, distance: number): { x: number; z: number; dx: number; dz: number } {
  const d = ((distance % path.total) + path.total) % path.total;
  let index = 1;
  while (index < path.cumulative.length - 1 && path.cumulative[index] < d) index += 1;
  const segmentStart = path.points[index - 1];
  const segmentEnd = path.points[index];
  const segmentLength = path.cumulative[index] - path.cumulative[index - 1] || 1;
  const t = (d - path.cumulative[index - 1]) / segmentLength;
  return {
    x: segmentStart.x + (segmentEnd.x - segmentStart.x) * t,
    z: segmentStart.z + (segmentEnd.z - segmentStart.z) * t,
    dx: (segmentEnd.x - segmentStart.x) / segmentLength,
    dz: (segmentEnd.z - segmentStart.z) / segmentLength,
  };
}

/** 动画起点：车/船/云/旋转件第一次出现时的状态。它们在静态缓存里跨实例共享、每帧原地累加，
 *  所以起点按对象记在模块级 WeakMap，只在第一次见到时写入——之后的任何实例都能把它们放回原位。
 *  胶片导出靠它从同一个状态开拍（曾经接着实时循环的状态开拍：同一座城两次导出从第 ~17 帧开始逐像素不同）。 */
const animationOrigin = new WeakMap<object, number>();
const carBaseSpeed = new WeakMap<object, number>();
/** 车的原速：第一次见到时记下（构造时 speed 还是原值），低画质藏车不再丢失它。 */
export function baseSpeedOf(car: { speed: number }): number {
  if (!carBaseSpeed.has(car)) carBaseSpeed.set(car, car.speed);
  return carBaseSpeed.get(car) as number;
}
export function originOf(owner: object, value: number): number {
  if (!animationOrigin.has(owner)) animationOrigin.set(owner, value);
  return animationOrigin.get(owner) as number;
}

/** 简易几何合并（部件都是 position/normal/uv 布局，不值得引 utils）。 */
export function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"] as const) {
    const first = geometries[0].getAttribute(name);
    if (!first) continue;
    const combined = new Float32Array(geometries.reduce((sum, geometry) => sum + (geometry.getAttribute(name)?.array.length ?? 0), 0));
    let offset = 0;
    for (const geometry of geometries) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) continue;
      combined.set(attribute.array as Float32Array, offset);
      offset += attribute.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(combined, first.itemSize));
  }
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const geometry of geometries) {
    if (geometry.index) {
      for (const index of geometry.index.array as unknown as number[]) indices.push(index + vertexOffset);
    } else {
      for (let index = 0; index < geometry.getAttribute("position").count; index += 1) indices.push(index + vertexOffset);
    }
    vertexOffset += geometry.getAttribute("position").count;
  }
  merged.setIndex(indices);
  return merged;
}

/** Low-poly Art Deco tower silhouette: chamfered corners, podium, and stepped crown. */
export function artDecoTowerGeometry(): THREE.BufferGeometry {
  const profiles: Array<[number, number]> = [
    [0, 0.92], [0.08, 1], [0.14, 0.88], [0.82, 0.88],
    [0.9, 0.78], [0.95, 0.68], [1, 0.68],
  ];
  const corners: Array<[number, number]> = [
    [-0.36, -0.5], [0.36, -0.5], [0.5, -0.36], [0.5, 0.36],
    [0.36, 0.5], [-0.36, 0.5], [-0.5, 0.36], [-0.5, -0.36],
  ];
  const positions: number[] = []; const uvs: number[] = []; const indices: number[] = [];
  profiles.forEach(([y, scale], ring) => corners.forEach(([x, z], corner) => {
    positions.push(x * scale, y, z * scale);
    uvs.push(corner / corners.length, y);
    if (ring > 0) {
      const previous = (ring - 1) * corners.length + corner;
      const next = (ring - 1) * corners.length + (corner + 1) % corners.length;
      const current = ring * corners.length + corner;
      const currentNext = ring * corners.length + (corner + 1) % corners.length;
      indices.push(previous, current, currentNext, previous, currentNext, next);
    }
  }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
