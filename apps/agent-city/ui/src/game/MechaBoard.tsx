/** City test surface for GDD v1.3. Rules live in `mecha/rules.ts`. */
import { useMemo, useState } from "react";
import { gameText, type GameLocale } from "./gameCopy";
import {
  BOARD, bossExecute, bossPrepare, COVERS, createMatch, legalActions, living, pathDistance, STATS_MOVE,
  validateAndApplyPlan, type Action, type BossScriptId, type Cell, type CoverPresetId, type MatchState, type MechId,
} from "./mecha/rules";
import "./game.css";

const PRESETS: Array<{ id: CoverPresetId; label: string }> = [
  { id: "covers_sparse_mid", label: "稀疏中轴" },
  { id: "covers_diag_corridor", label: "对角走廊" },
  { id: "covers_twin_clusters", label: "双掩体团" },
];
const SCRIPTS: Array<{ id: BossScriptId; label: string }> = [
  { id: "cadence_ssw", label: "砸砸扫" },
  { id: "stationary_smash", label: "站桩砸击" },
];
const NAMES: Record<MechId, string> = { Assault: "突击", Gunner: "射手", Support: "支援" };

type Draft = { moveTo: Cell | null; action: Action };

function fresh(preset: CoverPresetId, script: BossScriptId): MatchState {
  const state = createMatch({ preset, script });
  bossPrepare(state);
  return state;
}

function blankDraft(state: MatchState): Record<MechId, Draft> {
  return {
    Assault: { moveTo: null, action: { kind: "skip" } },
    Gunner: { moveTo: null, action: { kind: "skip" } },
    Support: { moveTo: null, action: { kind: "skip" } },
    ...Object.fromEntries(living(state).map((m) => [m.id, { moveTo: null, action: { kind: "skip" as const } }])),
  } as Record<MechId, Draft>;
}

function same(a: Cell, b: Cell) {
  return a.x === b.x && a.y === b.y;
}

export function MechaBoard({ locale, onClose }: { locale: GameLocale; onClose: () => void }) {
  const t = (text: string) => gameText(text, locale);
  const [preset, setPreset] = useState<CoverPresetId>("covers_sparse_mid");
  const [script, setScript] = useState<BossScriptId>("cadence_ssw");
  const [state, setState] = useState<MatchState>(() => fresh("covers_sparse_mid", "cadence_ssw"));
  const [draft, setDraft] = useState<Record<MechId, Draft>>(() => blankDraft(fresh("covers_sparse_mid", "cadence_ssw")));
  const [selected, setSelected] = useState<MechId>("Assault");
  const [notice, setNotice] = useState<string | null>(null);

  const restart = (nextPreset = preset, nextScript = script) => {
    const match = fresh(nextPreset, nextScript);
    setPreset(nextPreset);
    setScript(nextScript);
    setState(match);
    setDraft(blankDraft(match));
    setSelected(living(match)[0]?.id ?? "Assault");
    setNotice(null);
  };

  const selectedMech = living(state).find((m) => m.id === selected);
  const reach = useMemo(() => {
    if (!selectedMech || state.phase !== "player_plan") return [];
    const cells: Cell[] = [];
    for (let y = 0; y < BOARD; y += 1) {
      for (let x = 0; x < BOARD; x += 1) {
        const dist = pathDistance(state, selectedMech.pos, { x, y }, selected);
        if (dist !== null && dist <= STATS_MOVE[selected]) cells.push({ x, y });
      }
    }
    return cells;
  }, [state, selected, selectedMech]);

  const actions = useMemo(() => {
    if (!selectedMech) return [];
    const scratch = structuredClone(state);
    const who = scratch.mechs.find((m) => m.id === selected && m.hp > 0);
    const dest = draft[selected]?.moveTo;
    if (who && dest) who.pos = dest;
    return legalActions(scratch, selected);
  }, [state, selected, selectedMech, draft]);

  const paint = (x: number, y: number) => {
    const c = { x, y };
    const classes = ["mecha-cell"];
    if (state.covers.some((k) => same(k, c))) classes.push("is-cover");
    if (state.boss.hp > 0 && x >= state.boss.anchor.x && x <= state.boss.anchor.x + 1 && y >= state.boss.anchor.y && y <= state.boss.anchor.y + 1) classes.push("is-boss");
    if (state.boss.intent?.projected.some((k) => same(k, c))) classes.push("is-telegraph");
    const unit = living(state).find((m) => same(m.pos, c));
    if (unit) classes.push(`is-${unit.id.toLowerCase()}`, unit.id === selected ? "is-selected" : "");
    if (draft[selected]?.moveTo && same(draft[selected].moveTo!, c)) classes.push("is-move");
    if (reach.some((k) => same(k, c))) classes.push("is-reach");
    return classes.filter(Boolean).join(" ");
  };

  const clickCell = (x: number, y: number) => {
    if (!selectedMech || state.phase !== "player_plan") return;
    if (!reach.some((k) => k.x === x && k.y === y)) return;
    const moveTo = same(selectedMech.pos, { x, y }) ? null : { x, y };
    setDraft((prev) => ({ ...prev, [selected]: { moveTo, action: { kind: "skip" } } }));
    setNotice(null);
  };

  const submit = () => {
    if (state.phase !== "player_plan") return;
    const next = structuredClone(state);
    const result = validateAndApplyPlan(next, {
      revision: next.revision,
      items: living(next).map((m) => ({ mechId: m.id, moveTo: draft[m.id]?.moveTo ?? null, action: draft[m.id]?.action ?? { kind: "skip" } })),
    });
    if (!("ok" in result)) {
      setNotice(t("整包被拒，局面未变，可以重提。"));
      return;
    }
    if (next.boss.hp > 0 && next.phase === "resolving_boss") bossExecute(next);
    if (next.phase === "enemy_prepare") bossPrepare(next);
    const alive = living(next);
    setState(next);
    setDraft(blankDraft(next));
    if (!alive.some((m) => m.id === selected) && alive[0]) setSelected(alive[0].id);
    setNotice(null);
  };

  const skill = state.boss.intent?.skillId;
  const skillLabel = skill === "sweep" ? t("横扫") : skill === "smash" ? t("砸击") : t("跳过");
  const outcome = state.outcome === "victory" ? t("歼灭") : state.outcome === "defeat_wipe" ? t("全灭") : state.outcome === "defeat_timeout" ? t("回合耗尽") : null;

  return (
    <section className="mecha-overlay" role="dialog" aria-label={t("机甲战棋")}>
      <div className="mecha-panel">
        <header>
          <h2>{t("机甲战棋")}</h2>
          <button type="button" onClick={onClose} aria-label={t("关闭机甲战棋")}>×</button>
        </header>
        <p className="mecha-help">{t("点击一台机甲，再点能走到的格子，然后选行动。")}</p>
        <div className="mecha-toolbar">
          <label>{t("布局")}<select value={preset} onChange={(e) => restart(e.target.value as CoverPresetId, script)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{t(p.label)}</option>)}</select></label>
          <label>{t("脚本")}<select value={script} onChange={(e) => restart(preset, e.target.value as BossScriptId)}>{SCRIPTS.map((s) => <option key={s.id} value={s.id}>{t(s.label)}</option>)}</select></label>
          <button type="button" onClick={() => restart()}>{t("新开一局")}</button>
        </div>
        <p>{t("回合")} {Math.min(state.turn, 15)} · {t("预告")} {skillLabel} · {t("Boss 生命")} {state.boss.hp}{outcome ? ` · ${outcome}` : ""}</p>
        <div className="mecha-grid" style={{ gridTemplateColumns: `repeat(${BOARD}, 28px)` }}>
          {Array.from({ length: BOARD * BOARD }, (_, i) => {
            const x = i % BOARD;
            const y = Math.floor(i / BOARD);
            return <button key={`${x},${y}`} type="button" className={paint(x, y)} aria-label={`${x},${y}`} onClick={() => clickCell(x, y)} />;
          })}
        </div>
        <div className="mecha-roster">
          {living(state).map((m) => (
            <button key={m.id} type="button" className={m.id === selected ? "is-selected" : ""} onClick={() => setSelected(m.id)}>
              {t(NAMES[m.id])} {m.hp} @ {m.pos.x},{m.pos.y}
            </button>
          ))}
        </div>
        <div className="mecha-actions">
          {actions.map((action) => {
            const label = action.kind === "melee" ? "近战" : action.kind === "shoot" ? "射击" : action.kind === "charge" ? "冲撞" : action.kind === "pierce" ? "穿射" : action.kind === "repair" ? "维修" : "待机";
            const on = draft[selected]?.action.kind === action.kind && (action.kind !== "repair" || draft[selected]?.action.kind === "repair" && action.kind === "repair" && draft[selected].action.target === action.target);
            return <button key={action.kind === "repair" ? `repair-${action.target}` : action.kind} type="button" className={on ? "is-selected" : ""} disabled={state.phase !== "player_plan"} onClick={() => setDraft((prev) => ({ ...prev, [selected]: { ...prev[selected], action } }))}>{t(label)}{action.kind === "repair" ? ` ${t(NAMES[action.target])}` : ""}</button>;
          })}
          <button type="button" disabled={state.phase !== "player_plan"} onClick={submit}>{t("提交三机行动")}</button>
        </div>
        {notice && <p role="alert">{notice}</p>}
        <p className="mecha-legend">{t("掩体")} {COVERS[preset].length} · {state.ruleset}</p>
      </div>
    </section>
  );
}
