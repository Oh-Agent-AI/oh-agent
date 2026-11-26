/**
 * Creator Studio 视口的「移动候选 ghost 预览」。
 *
 * editable 选中会话楼后，浮动卡片只列候选文字，用户看不出候选地块在地图哪里。
 * 这里把每个候选画成半透明占地盒体，挂到引擎场景根（CityEngine.addOverlay，与
 * CityApp 的 creator 模型同一条 sanctioned 通道）；不复用 planRepair/overlay.ts 的
 * ParcelOverlay——那个类和修复控制器（钩子/预览带）耦合，视口只需要
 * 「候选列表 → 一组贴地盒子 + hover 高亮」这一件事。
 * 地块朝向沿用 Parcel.yaw 约定（局部 z 轴 = (sin yaw, cos yaw)，即 three 的 rotation.y = yaw）。
 * 所有盒子 raycast = noop：不参与拾取，点画布要落到地面/楼体上，不能被 ghost 挡住。
 */
import * as THREE from "three";

/** 与 RepairCandidate 的几何字段结构对齐；视口侧不引 planRepair 类型，保持模块单向依赖。 */
export type MoveGhostCandidate = {
  x: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  warnings: readonly string[];
};

const BASE_OPACITY = 0.45;
const HOVER_OPACITY = 0.8;
const COLORS = {
  ok: 0x2dd4bf,        // 无 warnings：青绿——能落的候选
  warn: 0xf59e0b,      // 有 warnings：琥珀——有代价的候选
  okHover: 0x7cf7e8,   // hover 提亮后的青绿
  warnHover: 0xffd166, // hover 提亮后的琥珀
} as const;

export type MoveGhost = {
  group: THREE.Group;
  /** 高亮第 index 个候选（null = 全部恢复常态）；索引即创建时的候选顺序，与卡片按钮一一对应。 */
  setHighlighted(index: number | null): void;
  dispose(): void;
};

export function createMoveGhost(candidates: readonly MoveGhostCandidate[]): MoveGhost {
  const group = new THREE.Group();
  group.name = "city-move-ghost-overlay";
  // 单位盒（0.5 高）只建一份，占地尺寸走 scale——dispose 时也只需释放这一份几何。
  const geometry = new THREE.BoxGeometry(1, 0.5, 1);
  const meshes: Array<{ mesh: THREE.Mesh; warned: boolean }> = [];
  candidates.forEach((candidate, index) => {
    const warned = candidate.warnings.length > 0;
    const material = new THREE.MeshBasicMaterial({
      color: warned ? COLORS.warn : COLORS.ok,
      transparent: true,
      opacity: BASE_OPACITY,
      depthWrite: false, // 半透明盒体互叠/与地面叠时不写深度，避免排序问题把后面的候选裁没
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(candidate.width, 1, candidate.depth);
    mesh.position.set(candidate.x, 0.25, candidate.z); // 高 0.5、中心 0.25 → 底面贴地
    mesh.rotation.y = candidate.yaw;
    mesh.renderOrder = 20; // 与叠加层同档：画在城市本体之后
    mesh.raycast = () => {};
    mesh.userData.ghostIndex = index;
    meshes.push({ mesh, warned });
    group.add(mesh);
  });

  const setHighlighted = (index: number | null) => {
    for (const { mesh, warned } of meshes) {
      const highlighted = index !== null && mesh.userData.ghostIndex === index;
      const material = mesh.material as THREE.MeshBasicMaterial;
      const hoverOpacity = highlighted ? HOVER_OPACITY : BASE_OPACITY;
      const hoverColor = highlighted ? (warned ? COLORS.warnHover : COLORS.okHover) : (warned ? COLORS.warn : COLORS.ok);
      material.opacity = hoverOpacity;
      material.color.setHex(hoverColor);
    }
  };

  const dispose = () => {
    group.clear();
    for (const { mesh } of meshes) (mesh.material as THREE.Material).dispose();
    meshes.length = 0;
    geometry.dispose();
  };

  return { group, setHighlighted, dispose };
}
