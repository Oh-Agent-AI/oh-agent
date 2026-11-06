import type { GameLocale } from "../gameCopy";

/** Presentation-only labels. Unknown IDs remain visible rather than masquerading as another skill. */
const SKILLS: Readonly<Record<string, readonly [string, string]>> = {
  smash: ["砸击", "Smash"], sweep: ["横扫", "Sweep"], skip: ["跳过", "Skip"],
  spore_leap: ["孢子弹跳", "Spore leap"], ring_pierce: ["环轨穿刺", "Ring pierce"],
  corrode_cell: ["蚀格", "Corrode cell"], prism_guard: ["棱镜护盾", "Prism guard"], prism_frost: ["棱晶寒束", "Prism frost"],
  split_swarm: ["分群围猎", "Split swarm"], phase_swap: ["相位交换", "Phase swap"],
  gravity_well: ["引力井", "Gravity well"], neural_link: ["神经链接", "Neural link"],
  core_migration: ["核心迁移", "Core migration"], space_fold: ["空间折叠", "Space fold"],
};

export function monsterSkillName(skill: string | null, locale: GameLocale): string {
  if (skill === null) return locale === "en" ? "No attack" : "无攻击";
  return SKILLS[skill]?.[locale === "en" ? 1 : 0] ?? skill;
}
