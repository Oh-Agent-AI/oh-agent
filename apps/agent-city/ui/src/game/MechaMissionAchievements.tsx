import type { GameLocale } from "./gameCopy";
import type { MissionAchievements, MissionAchievementStatus } from "./mecha/missionAchievements";
import "./MechaMissionAchievements.css";

type Props = { achievements: MissionAchievements | null; locale: GameLocale };

/** Place inside the local victory result; contains no controls and does not gate its actions. */
export function MechaMissionAchievements({ achievements, locale }: Props) {
  if (!achievements) return null;
  const en = locale === "en";
  const labels: Record<MissionAchievementStatus, string> = en
    ? { achieved: "Achieved", "not-achieved": "Not achieved", "not-applicable": "No such objective", unverifiable: "Cannot verify" }
    : { achieved: "已达成", "not-achieved": "未达成", "not-applicable": "无此目标", unverifiable: "无法核验" };
  return <section className="mecha-mission-achievements" aria-label={en ? "Optional battle facts" : "可选战斗事实"} data-mission-achievements>
    <h3>{en ? "Optional battle facts" : "可选战斗事实"}</h3>
    <p>{en ? "Descriptive only; these do not affect the match outcome." : "仅作事实展示，不影响胜负。"}</p>
    <ul>{achievements.items.map(item => <li key={item.id} data-achievement={item.id} data-status={item.status}>
      <div><strong>{item.id === "all-survived" ? (en ? "All mechs survived" : "全员生还") : (en ? "Protected buildings undamaged" : "受保护建筑无损")}</strong>
        <span>{labels[item.status]}</span></div>
      <p>{item.id === "all-survived"
        ? (en ? "Every starting mech stayed above zero HP throughout the recorded battle." : "开局每台机甲在整场记录中生命值始终高于零。")
        : item.status === "not-applicable"
          ? (en ? "This mission has no protected-building objective." : "本任务没有保护建筑目标。")
          : (en ? "Every protected building started at full HP and took no damage during the recorded battle." : "所有受保护建筑开局满血，且整场记录中没有受到伤害。")}</p>
      {item.status === "unverifiable" ? <p>{en ? "The complete, authoritative replay or objective data is unavailable." : "完整的权威重演记录或目标数据不可用。"}</p> : null}
    </li>)}</ul>
  </section>;
}
