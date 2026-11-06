import type { BuildingModel, Part } from "../model";

const WHITE = "#f3f1ea";
const RED = "#c8473a";
const IRON = "#3c4650";
const DARK = "#2d343b";

/**
 * 地标「lighthouse」：声明式 BuildingModel（批 1）。几何与旧 drawLighthouse 逐位一致（golden/city-landmark-baseline.json 钉住）。
 * 塔高 h = min(cap, 32)；霓虹开（sizing.neon）时多一束绕竖轴旋转的对向加色锥（group "beam" + role:"beam"，lifecycle.spin 转它）。
 * 灯室发光用迁移期的 `emissive` 倍率逐位保留（批 5 换预算类别）。
 */
export const lighthouseModel: BuildingModel = {
  id: "lighthouse",
  group: "地标",
  semantics: "decor",
  title: "灯塔",
  body: "红白条纹的岬角灯塔，夜里亮灯。由岛屿种子挑选，不代表会话。",
  sitingKey: "landmark:lighthouse",
  geometry: ({ sizing }) => {
    const h = Math.min(sizing?.cap ?? 70, 32);
    const neon = (sizing?.neon ?? 0) > 0;
    const bands = 6;
    const parts: Part[] = [];
    for (let i = 0; i < bands; i += 1) {
      const r0 = 3.4 - (i / bands) * 1.4; const r1 = 3.4 - ((i + 1) / bands) * 1.4;
      parts.push({ kind: "cylinder", at: [0, (i * h) / bands, 0], size: [r0 * 2, h / bands, r0 * 2], radiusTop: r1, segments: 14, role: "wall", color: i % 2 ? RED : WHITE });
    }
    // 细化：石砌基座 + 守塔人小屋、塔顶环形观景廊（廊板 + 栏杆立柱）、玻璃灯室（竖棂）与穹顶通风帽。
    parts.push({ kind: "cylinder", at: [0, -0.2, 0], size: [10, 1.6, 10], radiusTop: 4.6, segments: 16, role: "wall", color: "#b9b2a2" });
    parts.push({ kind: "box", at: [6.2, 0, 0], size: [7, 3.6, 5], role: "wall", color: WHITE });
    parts.push({ kind: "box", at: [6.2, 3.6, 0], size: [7.6, 0.5, 5.6], role: "roof", color: RED });
    parts.push({ kind: "cylinder", at: [0, h, 0], size: [6.2, 0.35, 6.2], segments: 18, anchor: "center", shift: [0, 0.17, 0], role: "structure", color: IRON }); // 观景廊板
    for (let k = 0; k < 16; k += 1) {
      const t = (k / 16) * Math.PI * 2;
      parts.push({ kind: "box", at: [Math.cos(t) * 2.95, h + 0.35, Math.sin(t) * 2.95], size: [0.12, 1.1, 0.12], role: "structure", color: IRON });
    }
    parts.push({ kind: "torus", at: [0, h + 1.45, 0], radius: 2.95, tube: 0.07, segments: [4, 32], bake: { x: Math.PI / 2 }, role: "structure", color: IRON });
    parts.push({ kind: "cylinder", id: "lamp", at: [0, h + 0.35, 0], size: [4, 3, 4], segments: 12, role: "lit", light: "landmark", color: "#fff2c0", emissive: 1.5 });
    for (let k = 0; k < 8; k += 1) {
      const t = (k / 8) * Math.PI * 2;
      parts.push({ kind: "box", at: [Math.cos(t) * 2.02, h + 0.35, Math.sin(t) * 2.02], size: [0.14, 3, 0.14], role: "structure", color: DARK });
    }
    parts.push({ kind: "sphere", at: [0, h + 3.35, 0], size: [2.4, 2.4, 2.4], segments: [14, 8], theta: [0, Math.PI / 2], role: "roof", color: RED });
    parts.push({ kind: "cylinder", at: [0, h + 5.6, 0], size: [0.7, 1.4, 0.7], radiusTop: 0.25, segments: 8, role: "structure", color: DARK });
    if (neon) {
      // 旋转光束：两束对向的加色锥，绕竖轴转（进 bloom）。锥几何先下移 90（尖端在原点）再绕 z 倒向两侧。
      parts.push({ kind: "group", id: "beam", at: [0, h + 1.5, 0] });
      for (const side of [-1, 1]) parts.push({ kind: "cone", parent: "beam", at: [0, 0, 0], size: [14, 160, 14], segments: 16, open: true, anchor: "center", preShift: [0, -90, 0], bake: { z: (side * Math.PI) / 2 }, role: "beam", color: "#fff2c0" });
    }
    return parts;
  },
  lifecycle: { spin: [{ parts: ["beam"], axis: "y", speed: 0.9 }] },
  picking: { decorId: "decor:landmark:lighthouse", category: "致敬地标 · 装饰", describe: "由岛屿种子挑选的城市地标。不代表任何会话，不随数据变化。" },
};
