/**
 * 界面叠层系统（标签 / 悬停·选中环 / 拾取目标 / 锚点）：自 cityParts.ts 原样搬出（纯搬迁，见 docs/CITY_ENGINE_SPLIT_SPEC.md）。
 * 函数体与原方法逐字一致，仅 `this.` → `host.`；host 是 CityParts 本身，下面的接口只列出这里实际用到的成员。
 */
import * as THREE from "three";
import { PLAYABLE_CAR_PREFIX, PLAYABLE_MECHA_NAME, PLAYABLE_PLANE_NAME } from "../render/playableVehicles";
import { hashSeed, type CityBuilding, type CityModel } from "../../cityModel";
import type { CityLayout } from "../cityLayout";
import { decorKindForName } from "../cityDecor";
import { makeLabelSprite, paletteFor } from "../cityTextures";

export interface UiOverlayHost {
  layout: CityLayout;
  group: THREE.Group;
  disposables: Array<{ dispose: () => void }>;
  labels: THREE.Sprite[];
  labelsVisible: boolean;
  hoverRing: THREE.Mesh;
  selectRing: THREE.Mesh;
  hoveredId: string | null;
  selectedId: string | null;
  scaffoldMesh: THREE.InstancedMesh;
  decorTargetsCache: THREE.Object3D[] | null;
  civicMeshes: THREE.InstancedMesh[];
  civicPieces: Array<{ civic: number; mesh: 0 | 1 | 2; index: number }>;
  shaftMeshes: THREE.InstancedMesh[];
  shaftIdByInstance: Array<Map<number, string>>;
  runtimeById: Map<string, { slot: { x: number; z: number }; building: CityBuilding; groundY: number }>;
  districtLandmarkHeight(districtId: string, sessions?: number): number;
  anchorFor(id: string): { x: number; z: number; height: number; ground: number } | null;
}

export function makeGroundRing(host: UiOverlayHost, color: string): THREE.Mesh {
  const geometry = new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  mesh.renderOrder = 3;
  host.group.add(mesh);
  host.disposables.push(geometry, material);
  return mesh;
}

export function buildLabels(host: UiOverlayHost): void {
  for (const district of host.layout.districts) {
    const palette = paletteFor(district.id);
    const detail = `${district.sessionCount} sessions`;
    const { texture, aspect } = makeLabelSprite(district.label, detail, palette.accent);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, sizeAttenuation: false });
    const sprite = new THREE.Sprite(material);
    // 标签略放大，且彼此靠近（<150）时逐个抬高，避免重叠（多视角评估：标签小且叠在一起）。
    const height = 0.024;
    sprite.scale.set(height * aspect, height, 1);
    sprite.renderOrder = 20;
    // 标签立在本区地标正上方（用户：把城区标签放到地标建筑上方）；没有地标时退回城区中心上空。
    const landmark = (host.layout.districtLandmarks ?? []).find((l) => l.districtId === district.id);
    if (landmark) sprite.position.set(landmark.x, Math.max(0.3, landmark.y) + host.districtLandmarkHeight(district.id) + 22, landmark.z);
    else {
      const crowd = host.labels.filter((other) => Math.hypot(other.position.x - district.center.x, other.position.z - district.center.z) < 150).length;
      sprite.position.set(district.center.x, district.plaza.y + 45 + crowd * 34, district.center.z);
    }
    host.group.add(sprite);
    host.labels.push(sprite);
    host.disposables.push(material, texture);
  }
}

export function hideOverlaysForPhoto(host: UiOverlayHost): () => void {
  const labels = host.labels.map((label) => label.visible);
  const rings = [host.hoverRing.visible, host.selectRing.visible];
  const scaffold = host.scaffoldMesh.visible;
  // 「计划高度」脚手架壳在照片里读作悬空的半透明方块（航拍/导出也藏它）。
  host.scaffoldMesh.visible = false;
  for (const label of host.labels) label.visible = false;
  host.hoverRing.visible = false;
  host.selectRing.visible = false;
  return () => {
    host.labels.forEach((label, index) => { label.visible = labels[index]; });
    host.hoverRing.visible = rings[0];
    host.selectRing.visible = rings[1];
    host.scaffoldMesh.visible = scaffold;
  };
}

export function setLabelsVisible(host: UiOverlayHost, visible: boolean): void {
  host.labelsVisible = visible;
  for (const label of host.labels) label.visible = visible;
}

export function decorTargets(host: UiOverlayHost): THREE.Object3D[] {
  if (host.decorTargetsCache) return host.decorTargetsCache;
  const out: THREE.Object3D[] = [];
  host.group.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh || !object.visible) return;
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (decorKindForName(node.name)) { out.push(object); return; }
    }
  });
  host.decorTargetsCache = out;
  return out;
}

export function decorAt(host: UiOverlayHost, mesh: THREE.Object3D, instanceId: number | undefined, point?: THREE.Vector3): string | null {
  // 可开的载具（停车场的车、机坪的飞机）挂在地标/机场组里：先认它们，点到的是「开这辆」而不是地标说明。
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    if (node.name === PLAYABLE_PLANE_NAME) return "play:plane";
    if (node.name === PLAYABLE_MECHA_NAME) return "play:mecha";
    if (node.name.startsWith(PLAYABLE_CAR_PREFIX)) return `play:car:${node.name.slice(PLAYABLE_CAR_PREFIX.length)}`;
  }
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) {
    const kind = decorKindForName(node.name);
    if (!kind) continue;
    if (kind === "civic" && instanceId !== undefined) {
      const meshIndex = host.civicMeshes.indexOf(mesh as THREE.InstancedMesh);
      const matches = host.civicPieces.filter((item) => item.mesh === meshIndex && item.index === instanceId);
      const piece = matches.length === 1 ? matches[0] : undefined;
      const civic = piece ? (host.layout.civics ?? [])[piece.civic] : undefined;
      return civic ? `decor:civic:${civic.kind}#${civic.id}` : "decor:civic";
    }
    if (kind === "district-landmark") {
      const prefix = "city-landmark-district:", districtId = node.name.slice(prefix.length);
      const instances = (host.layout.districtLandmarks ?? []).filter(item => item.districtId === districtId);
      return instances.length === 1 ? `decor:district-landmark#district-landmark:${districtId}` : "decor:district-landmark";
    }
    // 公共用地是一批合并网格：按命中点找最近的用地，市政厅（civic）面板展示全城信息。
    if (kind === "site" && point) {
      const site = [...host.layout.publicSites].sort((a, b) => Math.hypot(a.x - point.x, a.z - point.z) - Math.hypot(b.x - point.x, b.z - point.z))[0];
      if (site && Math.hypot(site.x - point.x, site.z - point.z) < site.radius * 1.4) return `decor:site:${site.kind}`;
    }
    return `decor:${kind}`;
  }
  return null;
}

export function idAt(host: UiOverlayHost, mesh: THREE.Object3D, instanceId: number): string | null {
  const index = host.shaftMeshes.indexOf(mesh as THREE.InstancedMesh);
  if (index < 0) return null;
  return host.shaftIdByInstance[index].get(instanceId) ?? null;
}

export function anchors(host: UiOverlayHost): Map<string, { x: number; z: number; height: number; ground: number }> {
  const out = new Map<string, { x: number; z: number; height: number; ground: number }>();
  for (const [id, runtime] of host.runtimeById) out.set(id, { x: runtime.slot.x, z: runtime.slot.z, height: runtime.building.height, ground: runtime.groundY });
  return out;
}

export function anchorFor(host: UiOverlayHost, id: string): { x: number; z: number; height: number; ground: number } | null {
  const runtime = host.runtimeById.get(id);
  if (!runtime) return null;
  return { x: runtime.slot.x, z: runtime.slot.z, height: runtime.building.height, ground: runtime.groundY };
}

export function setHovered(host: UiOverlayHost, id: string | null): void {
  host.hoveredId = id;
  const anchor = id ? host.anchorFor(id) : null;
  if (!anchor) {
    host.hoverRing.visible = false;
    return;
  }
  const runtime = id ? host.runtimeById.get(id) : null;
  const ringRadius = runtime ? runtime.building.footprint * 1.5 : 3;
  host.hoverRing.scale.set(ringRadius, 1, ringRadius);
  host.hoverRing.position.set(anchor.x, anchor.ground + 0.18, anchor.z);
  host.hoverRing.visible = true;
}

export function setSelected(host: UiOverlayHost, id: string | null): void {
  host.selectedId = id;
  const anchor = id ? host.anchorFor(id) : null;
  if (!anchor) {
    host.selectRing.visible = false;
    return;
  }
  const runtime = id ? host.runtimeById.get(id) : null;
  const ringRadius = runtime ? runtime.building.footprint * 1.7 : 3.4;
  host.selectRing.scale.set(ringRadius, 1, ringRadius);
  host.selectRing.position.set(anchor.x, anchor.ground + 0.2, anchor.z);
  host.selectRing.visible = true;
}
