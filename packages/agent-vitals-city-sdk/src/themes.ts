/**
 * City 视觉主题注册表（CityThemeIdV1 / CitySkinPackIdV1 的唯一人工维护点）。
 *
 * 生成器侧已有 worldParameters.ts；主题此前没有对应机制，`"miami" | "desert"`
 * 闭集词汇散落在 types/validate/City 引擎/能力目录多处。本文件把词汇收敛为
 * `as const` 数组（与 protocol/permissions.ts 的 catalog 模式一致）：
 * 类型、守卫、皮肤目录都从这里派生——新增主题只改这一处声明。
 *
 * `skinPacks` 记录主题关联的皮肤包 id（CitySkinPackV1.id）；皮肤包的完整记录
 * （renderContract、compatibleGeographies）留在 City 渲染层，这里只钉 id 与
 * 主题归属，validateCitySkinPack 在校验时回查本注册表防止两边漂移。
 */

export type CityThemeIdV1 = "miami" | "desert";
export type CitySkinPackIdV1 = "miami-vice" | "desert-evening";

// 注：这里刻意不写 `(typeof ARR)[number]` 派生——TS 7.0.2 原生编译器对
// readonly 元组声明做 `[number]` 索引会丢字面量联合（探针钉在
// tests/themes.test.ts 注释里）；改为「类型唯一声明 + satisfies 反向钉住
// 运行时数组」，两侧相邻、漂移由 tests/themes.test.ts 锁死。
export const CITY_THEME_IDS_V1 = Object.freeze(["miami", "desert"] as const satisfies readonly CityThemeIdV1[]);
export const CITY_SKIN_PACK_IDS_V1 = Object.freeze(["miami-vice", "desert-evening"] as const satisfies readonly CitySkinPackIdV1[]);

export type CityVisualThemeV1 = Readonly<{
  schemaVersion: 1;
  id: CityThemeIdV1;
  /** 关联的皮肤包 id；每个皮肤包恰好归属一个主题。 */
  skinPacks: readonly string[];
}>;

export const CITY_THEMES_V1: readonly CityVisualThemeV1[] = Object.freeze([
  Object.freeze({ schemaVersion: 1, id: "miami", skinPacks: Object.freeze(["miami-vice"]) }),
  Object.freeze({ schemaVersion: 1, id: "desert", skinPacks: Object.freeze(["desert-evening"]) }),
]);

/** 主题 id 是否在注册表中；运行时校验的唯一判定入口。 */
export function isCityThemeIdV1(value: unknown): value is CityThemeIdV1 {
  return typeof value === "string" && (CITY_THEME_IDS_V1 as readonly string[]).includes(value);
}

/** 皮肤包 id 是否在注册表中；供未信宿主数据在进入强类型面之前收窄。 */
export function isCitySkinPackIdV1(value: unknown): value is CitySkinPackIdV1 {
  return typeof value === "string" && (CITY_SKIN_PACK_IDS_V1 as readonly string[]).includes(value);
}

/** 皮肤包归属的主题；未登记的皮肤包返回 undefined。 */
export function cityThemeForSkinPack(skinPackId: string): CityVisualThemeV1 | undefined {
  return CITY_THEMES_V1.find(theme => theme.skinPacks.includes(skinPackId));
}

/** 主题的首选皮肤包（目录序第一个）；未登记的主题返回 undefined。 */
export function citySkinPackForTheme(themeId: string): CitySkinPackIdV1 | undefined {
  const theme = CITY_THEMES_V1.find(entry => entry.id === themeId);
  const pack = theme?.skinPacks[0];
  return pack != null && (CITY_SKIN_PACK_IDS_V1 as readonly string[]).includes(pack) ? pack as CitySkinPackIdV1 : undefined;
}
