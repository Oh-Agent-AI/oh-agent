import { useState } from "react";
import { MONSTER_SKILLS } from "./mecha/board";
import { PLANNED_MONSTER_SPECIES_IDS, type PlannedMonsterSpeciesId } from "./mecha/monsters/contracts";
import { lookupMonsterDefinition, MONSTER_CONTENT_VERSION_V1, MONSTER_RULESET_V1 } from "./mecha/monsters/registry";
import type { GameLocale } from "./gameCopy";
import type { MechaControllerState } from "./mecha/controller";

// Opt in only after authoritative turns and presentation have been verified.
const PLAYABLE_PRACTICE_SPECIES = new Set<PlannedMonsterSpeciesId>(["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle", "phase_stalker", "gravity_core", "neural_weaver"]);
export function monsterPracticeAvailable(id: PlannedMonsterSpeciesId): boolean {
  return PLAYABLE_PRACTICE_SPECIES.has(id) && Object.hasOwn(MONSTER_SKILLS, id);
}

const ENGLISH: Record<PlannedMonsterSpeciesId, { name: string; skill: string; counter: string }> = {
  spore_leaper: { name: "Spore Leaper", skill: "Spore Leap", counter: "Leave the landing area, push it back, or block its route." },
  flux_lancer: { name: "Flux Lancer", skill: "Ring Pierce", counter: "Dodge sideways, change its facing, or reorder units." },
  porous_shaper: { name: "Porous Shaper", skill: "Corrode Cell", counter: "Avoid or control the hazard, or draw it to less valuable cells." },
  prism_warden: { name: "Prism Warden", skill: "Prism Guard", counter: "Break the shield, switch targets, or split attacks." },
  swarm_mantle: { name: "Swarm Mantle", skill: "Split Swarm", counter: "Eliminate it before splitting, block spawns, or clear the swarm." },
  phase_stalker: { name: "Phase Stalker", skill: "Phase Swap", counter: "Exploit the swap or block its landing cells." },
  gravity_core: { name: "Gravity Core", skill: "Gravity Well", counter: "Keep your distance, block the pull, or push the core back." },
  neural_weaver: { name: "Neural Weaver", skill: "Neural Link", counter: "Destroy a node, separate the targets, or attack the protected unit first." },
  many_core: { name: "Many-core Lifeform", skill: "Core Migration", counter: "Time your burst and adjust targets as the core moves." },
  field_sovereign: { name: "Field Sovereign", skill: "Space Fold", counter: "Read the mapping, use safe cells, or interrupt its phase." },
};

export function MechaMonsterPractice({ locale, activeSpecies, disabled, notice, onStart, onReset, onExit }: {
  locale: GameLocale;
  activeSpecies?: PlannedMonsterSpeciesId;
  disabled: boolean;
  notice: string | null;
  onStart: (speciesId: PlannedMonsterSpeciesId) => void;
  onReset: () => void;
  onExit: () => void;
}) {
  const [selected, setSelected] = useState<PlannedMonsterSpeciesId>(activeSpecies ?? "spore_leaper");
  const [confirm, setConfirm] = useState<"start" | "reset" | "exit" | null>(null);
  const en = locale === "en";
  const lookup = lookupMonsterDefinition(MONSTER_RULESET_V1, MONSTER_CONTENT_VERSION_V1, selected);
  if (!lookup.ok || lookup.definition.kind !== "planned_species") return null;
  const monster = lookup.definition;
  const available = monsterPracticeAvailable(selected);
  return <details className="mecha-evaluation-details" data-monster-practice>
    <summary>{en ? "Local monster practice" : "怪物本地演练场"}</summary>
    <p className="mecha-help">{en ? "Practice on this city battlefield. Local only; starting replaces the current match. Descriptions are catalog guidance, not a promise of implemented effects." : "在当前城市战场本地演练；开始会替换当前对局。图鉴描述是设计提示，不代表所有技能已经实现。"}</p>
    <div className="mecha-toolbar">
      <label>{en ? "Monster" : "怪物"}<select data-monster-practice-select value={selected} disabled={disabled} onChange={(event) => {
        setSelected(event.target.value as PlannedMonsterSpeciesId); setConfirm(null);
      }}>
        {PLANNED_MONSTER_SPECIES_IDS.map((id) => {
          const item = lookupMonsterDefinition(MONSTER_RULESET_V1, MONSTER_CONTENT_VERSION_V1, id);
          if (!item.ok || item.definition.kind !== "planned_species") return null;
          return <option key={id} value={id}>{en ? ENGLISH[id].name : item.definition.name}{monsterPracticeAvailable(id) ? "" : id === "neural_weaver" ? (en ? " · unavailable" : " · 暂不可用") : (en ? " · not implemented" : " · 未实现")}</option>;
        })}
      </select></label>
      <button type="button" data-monster-practice-start disabled={disabled || !available} onClick={() => setConfirm("start")}>{en ? "Start / switch" : "开始 / 切换"}</button>
      {activeSpecies ? <><button type="button" data-monster-practice-reset disabled={disabled} onClick={() => setConfirm("reset")}>{en ? "Reset practice" : "重置演练"}</button>
        <button type="button" data-monster-practice-exit disabled={disabled} onClick={() => setConfirm("exit")}>{en ? "Return to normal match" : "返回普通对局"}</button></> : null}
    </div>
    <div data-monster-practice-info data-species-id={selected}>
      <p><strong>{en ? ENGLISH[selected].name : monster.name}</strong> · {en ? "Threat level" : "威胁等级"} <span data-monster-practice-level>{monster.threatLevel}</span></p>
      <p>{en ? "Signature skill" : "专属技能"}：<span data-monster-practice-skill>{en ? ENGLISH[selected].skill : monster.signatureSkill.name}</span></p>
      <p>{en ? "Counterplay" : "反制"}：<span data-monster-practice-counter>{en ? ENGLISH[selected].counter : monster.signatureSkill.counterplay}</span></p>
      {!available ? <p role="status" data-monster-practice-unavailable>{selected === "neural_weaver"
        ? (en ? "Practice unavailable: local replay is not yet supported." : "演练场暂不可用：本地回放尚未支持。")
        : (en ? "Not yet implemented in the local battle rules." : "该物种的本地战斗规则尚未实现。")}</p> : null}
    </div>
    {confirm ? <div role="group" aria-label={en ? "Confirm replacing match" : "确认替换对局"} data-monster-practice-confirmation>
      <p role="status">{en ? "This replaces the current match. Continue?" : "将替换当前对局，是否继续？"}</p>
      <button type="button" data-monster-practice-confirm disabled={disabled || (confirm === "start" && !available)} onClick={() => {
        const action = confirm; setConfirm(null);
        if (action === "start") onStart(selected); else if (action === "reset") onReset(); else onExit();
      }}>{en ? "Replace match" : "替换对局"}</button>
      <button type="button" data-monster-practice-cancel onClick={() => setConfirm(null)}>{en ? "Cancel" : "取消"}</button>
    </div> : null}
    {notice ? <p role="alert" data-monster-practice-notice>{notice}</p> : null}
  </details>;
}

/** Show only the committed live-match shield, never a draft or an unrevealed turn. */
export function MechaPrismShieldStatus({ locale, controllerState, sequenceWaiting }: {
  locale: GameLocale;
  controllerState: Pick<MechaControllerState, "match" | "performance" | "replay">;
  sequenceWaiting: boolean;
}) {
  const { match, performance, replay } = controllerState;
  // Replay snapshots are separate from the live match; do not mix their statuses.
  if (replay || match.monsterContent?.speciesId !== "prism_warden") return null;
  const en = locale === "en";
  if (performance || sequenceWaiting) return <span role="status" data-prism-shield-status="pending">
    {en ? "Prism shield: awaiting the end of the battle sequence." : "棱镜护盾：演出结束后确认状态。"}
  </span>;
  const hits = match.boss.shield?.hits ?? 0;
  return <span role="status" data-prism-shield-status={hits ? "active" : "absent"} data-prism-shield-hits={hits}>
    {en ? `Prism shield: ${hits ? "active" : "absent"} (${hits} hit${hits === 1 ? "" : "s"} remaining)`
      : `棱镜护盾：${hits ? "存在" : "无"}（剩余 ${hits} 次）`}
  </span>;
}
