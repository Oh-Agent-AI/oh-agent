import type { CityModel } from "../cityModel";
import type { CinematicCard } from "./cityCinematic";

/** Pure copy shared by the foreground tour and the isolated export Worker. */
export function cinematicCopy(model: CityModel, card: CinematicCard, locale: "en" | "zh-Hans") {
  const en = locale === "en";
  const tokens = model.stats.tokensTotal.toLocaleString(en ? "en-US" : "zh-CN");
  const windowLabel = en ? model.windowLabel.replace(/^最近 (\d+) 天$/, "Last $1 days").replace(/^(\d+) 天$/, "$1 days") : model.windowLabel;
  if (card.kind === "title") return { eyebrow: "AGENT VITALS",
    title: en ? `${model.stats.renderedSessions} sessions, one city` : `${model.stats.renderedSessions} 个会话，一座城市`,
    subtitle: `${windowLabel} · ${tokens} tokens` };
  if (card.kind === "district") return { eyebrow: en ? "Harness districts" : "执行环境城区",
    title: card.text, subtitle: `${card.detail ?? ""}${en ? " sessions" : " 个会话"}` };
  return { title: tokens, subtitle: `${model.districts.length}${en ? " districts · Loaded tokens · Not a bill" : " 个城区 · 已载入的 token · 非费用账单"}` };
}
