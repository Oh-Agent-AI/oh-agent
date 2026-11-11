import type { GameLocale } from "./gameCopy";
import type { Intent, MatchState } from "./mecha/board";

type Preview = { monsterProjection: Intent | null } | null;
const cell = (value: { x: number; y: number } | null | undefined) => value ? `${value.x},${value.y}` : "—";
const reasons: Record<string, [string, string]> = {
  finished: ["对局已结束", "match ended"], caster_dead: ["施放者已损毁", "caster destroyed"],
  stale: ["意图已过期", "intent expired"], outside_board: ["超出棋盘", "outside board"],
  blocked: ["地形阻挡", "terrain blocked"], already_corroded: ["已有蚀格", "cell already corroded"],
  capacity: ["地形数量已达上限", "field limit reached"], target_unavailable: ["目标不可用", "target unavailable"],
  actor_unavailable: ["施放者不可用", "caster unavailable"], out_of_range: ["超出范围", "out of range"],
  occupied: ["落点被占用", "destination occupied"], water: ["水域阻挡", "water blocks landing"],
  obstacle: ["障碍阻挡", "obstacle blocks landing"], out_of_bounds: ["落点超出棋盘", "landing outside board"],
  actor_obstacle: ["施放者位置被障碍阻挡", "caster position blocked by obstacle"],
  actor_water: ["施放者位置位于水域", "caster position blocked by water"],
  actor_occupied: ["施放者位置被占用", "caster position occupied"],
  actor_out_of_bounds: ["施放者位置超出棋盘", "caster position outside board"],
  terminal: ["对局已结束", "match ended"], stale_projection: ["投影已过期", "projection expired"],
  protected_path: ["保护通路", "protected path"], spawn_limit: ["本次召唤数量已达上限", "per-action spawn limit"],
  summon_cap: ["召唤单位数量已达上限", "summon cap reached"], unit_limit: ["单位数量已达上限", "unit limit reached"],
  id_exhausted: ["召唤编号已耗尽", "summon IDs exhausted"], id_collision: ["召唤编号冲突", "summon ID collision"],
  invalid_state: ["状态无效", "invalid state"], invalid_intent: ["宣告无效", "invalid intent"],
  stale_round: ["宣告回合已过期", "declaration round expired"], actor_dead: ["施放者已损毁", "caster destroyed"],
  target_dead: ["目标已损毁", "target destroyed"], source_dead: ["来源已损毁", "source destroyed"],
  expired: ["链接已到期", "link expired"], side_changed: ["阵营已变化", "side changed"],
  already_resolved: ["宣告已结算", "declaration already resolved"], action_limit: ["行动数量已达上限", "action limit reached"],
  reconciliation_required: ["等待状态同步", "state reconciliation required"],
  no_displacement: ["无法位移", "no displacement"],
  no_legal_displacement: ["没有合法位移", "no legal displacement"], attack_out_of_bounds: ["攻击范围超出棋盘", "attack outside board"],
};

/** Keep existing hazards visible even when the detailed threat panel is collapsed. */
export function MechaCorrodeSummary({ locale, state }: { locale: GameLocale; state: MatchState }) {
  const fields = state.corrode?.fields ?? [];
  if (!fields.length) return null;
  const en = locale === "en";
  return <p role="status" data-monster-hazards>{en ? "Active corrode fields" : "现存蚀格"}: {fields.map(field =>
    `${cell(field.cell)} (${Math.max(0, field.expiresAfterRound - state.turn + 1)}${en ? " turns" : " 回合"})`).join("、")}
    {en ? " · Living units on these cells take damage at round end." : " · 回合末会伤害格上的存活单位。"}
  </p>;
}

/** Read-only, local explanation of declared and post-draft authoritative projections. */
export function MechaMonsterIntent({ locale, state, preview }: { locale: GameLocale; state: MatchState; preview: Preview }) {
  const en = locale === "en";
  const label = (zh: string, english: string) => en ? english : zh;
  const reason = (value: string | null | undefined) => value ? (reasons[value]?.[en ? 1 : 0] ?? value) : label("原因不可用", "reason unavailable");
  const intent = state.boss.intent;
  const skill = intent?.skillId;
  const special = skill === "corrode_cell" || skill === "phase_swap" || skill === "gravity_well" || skill === "split_swarm" || skill === "neural_link";
  const fields = state.corrode?.fields ?? [];
  const links = state.neural?.links ?? [];
  if (!special && !fields.length && !links.length) return null;
  const renderIntent = (value: Intent, projection: boolean) => {
    if (skill === "neural_link") {
      const binding = intent?.swarm, request = binding?.request, other = value.swarm, otherRequest = other?.request;
      if (!binding || request?.skillId !== "neural_link") return <p>{intent?.status === "void" ? label("本回合没有可用的链接宣告。", "No link declaration is available this round.") : label("链接宣告不可用；不能视为安全。", "Link declaration unavailable; do not assume safety.")}</p>;
      const sameBinding = value.skillId === "neural_link" && other?.version === binding.version && other.round === binding.round &&
        otherRequest?.skillId === "neural_link" && otherRequest.actionId === request.actionId && otherRequest.actorId === request.actorId &&
        otherRequest.targetId === request.targetId && otherRequest.range === request.range && otherRequest.attackBonus === request.attackBonus && otherRequest.lifetime === request.lifetime;
      const result = sameBinding ? value.swarmProjection : undefined;
      const valid = value.status !== "void" && result?.status === "reprojected" && result.skillId === "neural_link" && result.sourceId === request.actorId &&
        result.targetId === request.targetId && result.range === request.range && result.attackBonus === request.attackBonus &&
        result.expiresAtRound === binding.round + request.lifetime;
      return <>
        <p>{label("固定宣告目标", "Fixed declared target")}: {request.targetId.replace(/^raider:/, "")} · {label("范围", "Range")}: {request.range} · {label("攻击加成（防御前）", "Attack bonus (before defense)")}: +{request.attackBonus}</p>
        {result?.status === "void" && value.status === "void" ? <p>{label("链接落空", "Link void")}: {reason(result.reason)} · {label("不会改选目标。", "The target will not be reselected.")}</p> : valid ?
          <p>{label("预测链接（尚未执行）", "Projected link (not yet executed)")} · {label("到期回合", "Expires at round")}: {result.expiresAtRound}</p> :
          <p>{label("链接投影不可用；不能视为安全。", "Link projection unavailable; do not assume safety.")}</p>}
        <p>{label("断链条件：来源或目标损毁、阵营变化、到期、超出范围或对局结束。", "Breaks on source or target destruction, side change, expiry, leaving range or match end.")}</p>
      </>;
    }
    if (skill === "split_swarm") {
      const binding = intent?.swarm;
      const request = binding?.request;
      const candidates = request?.skillId === "split_swarm" && Array.isArray(request.candidates) &&
        request.candidates.every(c => c && Number.isSafeInteger(c.x) && Number.isSafeInteger(c.y)) ? request.candidates : null;
      const other = value.swarm;
      const otherRequest = other?.request;
      const sameBinding = !projection || Boolean(binding && other && request?.skillId === "split_swarm" &&
        otherRequest?.skillId === "split_swarm" && candidates && Array.isArray(otherRequest.candidates) &&
        binding.version === other.version && binding.round === other.round &&
        request.actionId === otherRequest.actionId && request.actorId === otherRequest.actorId &&
        request.speciesId === otherRequest.speciesId && request.hp === otherRequest.hp &&
        request.lifetime === otherRequest.lifetime && request.maxSpawn === otherRequest.maxSpawn &&
        request.summonCap === otherRequest.summonCap && request.spawnRange === otherRequest.spawnRange &&
        candidates.length === otherRequest.candidates.length && candidates.every((c, i) =>
          c.x === otherRequest.candidates[i]?.x && c.y === otherRequest.candidates[i]?.y));
      const result = value.skillId === "split_swarm" && sameBinding ? value.swarmProjection : undefined;
      const slots = value.status !== "void" && result?.status === "reprojected" && result.skillId === "split_swarm" && candidates &&
        Array.isArray(result.slots) && result.slots.length === candidates.length &&
        result.slots.every((slot, i) => slot && slot.cell?.x === candidates[i]?.x && slot.cell?.y === candidates[i]?.y)
        ? result.slots : null;
      return <>
        {!projection ? <p>{label("原始候选格（顺序固定）", "Original candidate cells (fixed order)")}: {candidates?.map(cell).join("、") || label("不可用", "unavailable")}</p> : null}
        {result?.status === "void" ? <p>{label("技能落空", "Skill void")}: {reason(result.reason)}</p> : slots ? <>
          <p>{label("以下为预测召唤，并非已生成。", "Projected spawns, not units already spawned.")}</p>
          <ol>{slots.map((slot, index) => {
            const valid = slot.reason === null && slot.unit && slot.unit.cell?.x === slot.cell.x && slot.unit.cell?.y === slot.cell.y;
            const invalid = typeof slot.reason === "string" && slot.reason.length > 0 && slot.unit === null;
            const slotReason = slot.reason === "blocked" ? label("格子被阻挡", "cell blocked") : reason(slot.reason);
            return <li key={index} data-swarm-slot={cell(slot.cell)} data-status={valid ? "valid" : invalid ? "invalid" : "unknown"}>
              {cell(slot.cell)} · {valid ? label("有效（预测召唤）", "valid (projected spawn)") : invalid ? `${label("无效", "invalid")}: ${slotReason}` : label("结果不可用", "result unavailable")}
            </li>;
          })}</ol>
        </> : <p>{label("候选投影不可用；不能视为安全。", "Candidate projection unavailable; do not assume safety.")}</p>}
      </>;
    }
    if (value.skillId === "corrode_cell") return <>
      {value.corrode ? <p>{label("绑定格", "Bound cell")}: {cell(value.corrode.target)} · {label("持续", "Duration")}: {value.corrode.durationTurns} {label("回合（含创建回合）", "turns (including creation turn)")}</p> : null}
      {value.status === "void" ? <p>{label("落空", "Void")}: {reason(value.corrode?.reason)}</p> : null}
    </>;
    const binding = value.displacement;
    const result = value.displacementProjection;
    if (!binding || !result) return <p>{label("无合法绑定或投影", "No legal binding or projection")}</p>;
    return <>
      <p>{label("绑定目标及顺序", "Bound targets and order")}: {binding.request.targetIds.map(id => id.replace(/^mech:/, "")).join(" → ")} · {label("范围", "Range")}: {binding.request.radius}</p>
      {result.status === "void" ? <p>{label("技能落空", "Skill void")}: {reason(result.reason)}</p> : null}
      <ol>{result.effects.map((effect, index) => <li key={`${effect.entityId}-${index}`}>
        {effect.entityId.replace(/^mech:/, "")} · {cell(effect.from)} → {cell(effect.to)} · {effect.status === "move" ? label("落点", "landing") : `${label("落空（箭头为尝试位置）", "void (arrow is attempted destination)")}: ${reason(effect.reason)}`}
      </li>)}</ol>
      <p>{projection ? label("草稿攻击格", "Projected attack cells") : label("宣告攻击格", "Declared attack cells")}: {result.attackCells.map(cell).join("、") || "—"}</p>
    </>;
  };
  return <section data-monster-intent aria-label={label("怪物技能详情", "Monster skill details")}>
    {special && intent ? <>
      <strong>{label("当前技能宣告", "Current skill declaration")}</strong>{renderIntent(intent, false)}
      <strong>{label("草稿重投影", "Draft reprojection")}</strong>
      {!preview ? <p>{label("预测不可用；不能视为安全。", "Preview unavailable; do not assume safety.")}</p> :
        !preview.monsterProjection ? <p>{label("敌方阶段未执行（例如对局提前结束）。", "Enemy phase not reached (for example, the match ended early).")}</p> : renderIntent(preview.monsterProjection, true)}
    </> : null}
    {links.length ? <><strong>{label("当前生效链接", "Active links")}</strong><ul>{links.map(link => <li key={link.id}>
      {link.targetId.replace(/^raider:/, "")} · +{link.attackBonus} · {label("到期回合", "Expires at round")}: {link.expiresAtRound}
    </li>)}</ul></> : null}
    {(skill === "corrode_cell" || fields.length > 0) ? <p>{label("蚀格危险不计入攻击威胁格列表；请查看绑定格和剩余寿命。", "Corrode hazards are not included in the attack-threat cell list; check the bound cell and remaining duration.")}</p> : null}
    {fields.length ? <><strong>{label("现存蚀格", "Active corrode fields")}</strong><ul>{fields.map(field => <li key={field.id}>
      {cell(field.cell)} · {label("剩余", "Remaining")}: {Math.max(0, field.expiresAfterRound - state.turn + 1)} {label("回合；回合末对格上存活单位造成 1 点伤害", "turns; living units on the cell take 1 damage at round end")}
    </li>)}</ul></> : null}
  </section>;
}
