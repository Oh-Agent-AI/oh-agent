/** Public buildings are discovery points, not additional session entities or game income. */
export type CityDataPlaceId = "overview" | "activity" | "findings" | "skills" | "workflow";
export type CityDataPlace = { id: CityDataPlaceId; catalogId: string; title: string; englishTitle: string; description: string; englishDescription: string };
export const CITY_DATA_PLACES: readonly CityDataPlace[] = [
  { id: "overview", catalogId: "civic-hall", title: "市政厅 · 城市总览", englishTitle: "City Hall · Overview", description: "查看全窗口统计与城市载入覆盖。", englishDescription: "Statistics for the whole window and city loading coverage." },
  { id: "activity", catalogId: "observation-tower", title: "城市观测站 · 活动与模型", englishTitle: "Observatory · Activity & models", description: "观察每日活跃、token 和模型标识。", englishDescription: "Daily activity, tokens and observed model identifiers." },
  { id: "findings", catalogId: "hospital", title: "诊断中心 · Findings", englishTitle: "Diagnostics · Findings", description: "区分当前问题积压与窗口新增问题。", englishDescription: "Current open backlog and newly recorded findings in the window." },
  { id: "skills", catalogId: "school", title: "技能学院 · Skills", englishTitle: "Academy · Skills", description: "技能实际使用数据的入口；覆盖不足时明确说明。", englishDescription: "An entry for recorded skill usage, with explicit coverage limits." },
  { id: "workflow", catalogId: "station", title: "调度站 · Workflow", englishTitle: "Station · Workflow", description: "工具执行与结果数据的入口，不将 token 事件当调用次数。", englishDescription: "Recorded execution and outcomes; usage facts are not tool calls." },
];
export function cityDataPlaceForDecor(id: string | null | undefined): CityDataPlaceId | null {
  const base = id?.split("#")[0];
  if (base === "decor:site:civic") return "overview";
  if (base === "decor:site:tower") return "activity";
  if (base === "decor:civic:hospital") return "findings";
  if (base === "decor:civic:school") return "skills";
  if (base === "decor:site:station") return "workflow";
  return null;
}
