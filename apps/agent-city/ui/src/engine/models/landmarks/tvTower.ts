import type { BuildingModel, Part } from "../model";

const WHITE = "#f3f1ea";
const STEEL = "#c9cfd3";
const RED = "#c8473a";

/**
 * 地标「tv-tower」：声明式 BuildingModel（批 0b PoC）。几何与旧 drawTvTower 逐位一致（golden/city-landmark-baseline.json 钉住）。
 * 塔高 h = min(cap, 70)，cap / neon 经 GeometryInput.sizing 传入（数值化：neon 1/0）。
 * 两处自发光（观景球舱环、天线航空灯球）用迁移期的 `emissive` 倍率逐位保留，批 5 换预算类别。
 * 球舱是 SphereGeometry(5.5).scale(1,.55,1)：sphere.size 三轴半径 [5.5, 3.025, 5.5] 表达，编译器同样「先建球再烘焙缩放」。
 */
export const tvTowerModel: BuildingModel = {
  id: "tv-tower",
  group: "地标",
  semantics: "decor",
  title: "电视塔",
  body: "细高塔身加观景球舱与霓虹环，市中心的竖向标志。由岛屿种子挑选，不代表会话。",
  sitingKey: "landmark:tv-tower",
  geometry: ({ sizing }) => {
    const h = Math.min(sizing?.cap ?? 70, 70);
    const neon = (sizing?.neon ?? 0) > 0;
    const parts: Part[] = [
      { kind: "cylinder", id: "shaft", at: [0, 0, 0], size: [6.4, h * 0.78, 6.4], radiusTop: 1.6, segments: 12, role: "structure", color: STEEL },
      { kind: "sphere", id: "pod", at: [0, h * 0.72, 0], size: [5.5, 5.5 * 0.55, 5.5], segments: [18, 12], anchor: "center", role: "wall", color: WHITE },
      { kind: "torus", id: "pod-ring", at: [0, h * 0.72, 0], radius: 6.2, tube: 0.5, segments: [6, 32], bake: { x: Math.PI / 2 }, role: "lit", light: "landmark", color: "#7fb4c2", emissive: neon ? 0.8 : 0.2 },
      { kind: "cylinder", id: "antenna", at: [0, h * 0.78, 0], size: [0.9, h * 0.24, 0.9], radiusTop: 0.25, segments: 6, role: "trim", color: RED },
      // 细化：裙房入口、塔基三脚支撑、塔身两道环形检修平台、球舱下方深色玻璃观景层、天线上的航空灯球。
      { kind: "cylinder", at: [0, 0, 0], size: [17, 4, 17], radiusTop: 8, segments: 16, role: "wall", color: WHITE },
    ];
    for (let k = 0; k < 3; k += 1) {
      const t = (k / 3) * Math.PI * 2;
      parts.push({ kind: "box", at: [Math.cos(t) * 4.5, 3, Math.sin(t) * 4.5], size: [1.4, 14, 1.4], rot: [-Math.sin(t) * 0.18, 0, Math.cos(t) * 0.18], role: "structure", color: STEEL });
    }
    for (const f of [0.3, 0.5]) parts.push({ kind: "cylinder", at: [0, h * f, 0], size: [6.8, 0.5, 6.8], segments: 14, anchor: "center", role: "wall", color: WHITE });
    parts.push({ kind: "cylinder", id: "deck", at: [0, h * 0.72 - 3.8, 0], size: [9.2, 1.8, 9.2], radiusTop: 5.2, segments: 18, role: "glass", color: "#2f4552" });
    parts.push({ kind: "sphere", id: "beacon", at: [0, h * 0.78 + h * 0.24, 0], size: [0.6, 0.6, 0.6], segments: [8, 6], anchor: "center", role: "lit", light: "beacon", color: "#ff3b3b", emissive: 1.5 });
    return parts;
  },
  lifecycle: {},
  picking: { decorId: "decor:landmark:tv-tower", category: "致敬地标 · 装饰", describe: "由岛屿种子挑选的城市地标。不代表任何会话，不随数据变化。" },
};
