/**
 * 非会话建筑的说明（点击/悬停时显示）。
 *
 * 城市里除了会话楼，还有致敬地标、学校/商场/医院、市政设施、背景楼等装饰性建筑。
 * 它们曾经点击毫无反应——用户分不清哪些楼是自己的数据（真机截图反馈）。
 * 拾取得到的 id 形如 `decor:<kind>[:<detail>]`，这里把它翻译成标题 + 一句话说明 + 是否随数据变化。
 * 文案是中文原文，英文走 i18n.tsx 的目录（cityView 渲染时替换）。
 */

import { CIVIC_LABELS, LANDMARK_LABELS } from "./models/registry";
import { siteClassOf, siteClassesForMesh } from "./models/siteClasses";

export type DecorInfo = { title: string; category: string; body: string };

const LANDMARK_NAMES = LANDMARK_LABELS; // 名称表在 models/registry.ts（单一来源）
const CIVIC_NAMES = CIVIC_LABELS;
const classTitle = (classId: string): string => {
  const declaration = siteClassOf(classId);
  if (!declaration) throw new Error(`missing decor class declaration: ${classId}`);
  return declaration.title;
};

export function isDecorId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("decor:");
}

export function describeDecor(id: string): DecorInfo | null {
  if (decorDistrictId(id) !== null || id === "decor:district-landmark") return {
    title: classTitle("district-landmark"), category: "城区地标 · 随规模出现",
    body: "地标高度随本区会话数增长：会话越多，地标越高。" };
  const [, kind, detail] = id.split("#")[0].split(":");
  switch (kind) {
    case "landmark":
      return { title: LANDMARK_NAMES[detail] ?? "地标", category: "致敬地标 · 装饰", body: "由岛屿种子挑选的城市地标。不代表任何会话，不随数据变化。" };
    case "civic":
      return { title: CIVIC_NAMES[detail] ?? "城市配套", category: "城区公共服务", body: "每个非空城区优先规划医院和学校，额外配套随本区规模增长。设施服务所属执行环境，不代表单个会话。" };
    case "site":
      if (detail && detail !== "civic") { return { title: siteClassOf(`public:${detail}`)?.title ?? "市政设施", category: "公共用地 · 装饰", body: "随岛屿规划生成的公共设施，不代表任何会话。" }; }
      return { title: "市政设施", category: "公共用地 · 装饰", body: "市政广场、车站、体育场、观景塔或港口。随岛屿规划生成，不代表任何会话。" };
    case "backdrop":
      return { title: classTitle("context"), category: "城市氛围 · 不计入会话", body: "填充城市天际线的灰调背景楼，数量随会话数缩放。不可钻取，可在「城市设置」里关闭。" };
    case "massing":
      return { title: classTitle("scenery:massing"), category: "超出容量的会话", body: "会话数超过城市容量（4000 栋）时，多出来的会话合并成低细节楼群显示。" };
    case "seaside":
      return { title: classTitle("scenery:seaside"), category: "城市风貌 · 装饰", body: "沙滩、遮阳伞、躺椅、沙排场、游客、救生塔、码头与游艇等海滨装饰。不代表任何会话。" };
    case "garden":
      return { title: classTitle("garden"), category: "城区中心 · 随规模出现", body: "每个执行环境城区中心的花园与景观湖，城区地标立在它旁边；城区的会话楼从这里向外生长。" };
    case "volcano":
      return { title: classTitle("scenery:volcano"), category: "远景 · 装饰", body: "海平线上的远景火山。不代表任何会话。" };
    default:
      return null;
  }
}

/** Selection consumers accept one-version legacy district ids, preserving
 * colons within district identities rather than splitting them into kinds. */
export function decorDistrictId(id: string | null | undefined): string | null {
  if (!id) return null;
  const legacy = "decor:landmark:district:", current = "decor:district-landmark#district-landmark:";
  const value = id.startsWith(current) ? id.slice(current.length) : id.startsWith(legacy) ? id.slice(legacy.length) : "";
  return value || null;
}

/** 网格名 → 装饰类别（拾取时沿父级链匹配；静态城缓存复用时名字随网格一起保留）。 */
export function decorKindForName(name: string): string | null {
  // Unknown geometry stays unpickable instead of silently inheriting a prefix.
  const routes = [...new Set(siteClassesForMesh(name).map(item => item.meshRoutes?.[name] ?? item.decorKind))];
  return routes.length === 1 ? routes[0] : null;
}
