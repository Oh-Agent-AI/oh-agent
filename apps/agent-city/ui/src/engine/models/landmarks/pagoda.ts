import type { BuildingModel, Part } from "../model";

/**
 * 地标「pagoda」：声明式 BuildingModel（批 0b PoC）。几何与旧 drawPagoda 逐位一致（golden/city-landmark-baseline.json 钉住）。
 * 檐的四棱锥用 bake.y = π/4（烘焙进顶点，不是网格旋转）；四角起翘用网格 rot [-0.5, atan2, 0]。
 */
export const pagodaModel: BuildingModel = {
  id: "pagoda",
  group: "地标",
  semantics: "decor",
  title: "宝塔",
  body: "多层出檐的塔，东亚风格岛屿更常见。由岛屿种子挑选，不代表会话。",
  sitingKey: "landmark:pagoda",
  geometry: () => {
    const tiers = 7;
    const parts: Part[] = [{ kind: "box", id: "plinth", at: [0, 0, 0], size: [16, 2, 16], role: "trim", color: "#d9d3c2" }];
    let y = 2;
    for (let i = 0; i < tiers; i += 1) {
      const w = 10 - i * 1.1;
      parts.push({ kind: "box", at: [0, y, 0], size: [w, 3.6, w], role: "wall", color: "#b5463a" });
      // 檐：四棱锥扁台，比墙宽一圈。
      parts.push({ kind: "cone", at: [0, y + 3.6, 0], size: [w * 0.95 * 2, 1.6, w * 0.95 * 2], segments: 4, bake: { y: Math.PI / 4 }, role: "roof", color: "#3d5a4f" });
      // 四角起翘（檐角小斜块）。
      for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        parts.push({ kind: "box", at: [cx * w * 0.66, y + 3.7, cz * w * 0.66], size: [0.5, 0.4, 1.6], anchor: "center", rot: [-0.5, Math.atan2(cx, cz), 0], role: "roof", color: "#3d5a4f" });
      }
      // 每层平座栏杆。
      for (const side of [-1, 1]) {
        parts.push({ kind: "box", at: [0, y + 0.1, side * (w / 2 + 0.2)], size: [w + 0.4, 0.5, 0.15], role: "trim", color: "#e8d9b0" });
        parts.push({ kind: "box", at: [side * (w / 2 + 0.2), y + 0.1, 0], size: [0.15, 0.5, w + 0.4], role: "trim", color: "#e8d9b0" });
      }
      // 正面门洞。
      parts.push({ kind: "box", at: [0, y + 0.6, w / 2 + 0.05], size: [w * 0.3, 2.2, 0.15], role: "structure", color: "#3a2a22" });
      y += 4.4;
    }
    parts.push({ kind: "cylinder", id: "finial", at: [0, y, 0], size: [0.7, 6, 0.7], radiusTop: 0.2, segments: 6, role: "trim", color: "#c9a24a" });
    return parts;
  },
  lifecycle: {},
  picking: { decorId: "decor:landmark:pagoda", category: "致敬地标 · 装饰", describe: "由岛屿种子挑选的城市地标。不代表任何会话，不随数据变化。" },
};
