import {
  BOARD, MECH_IDS, createMatch, moveBudget, pathDistance,
  type Action, type ArenaPlan, type Cell, type MatchState, type MechId, type PlanFault, type TerrainKind, type TurnEvent,
} from "../rules";
import { STATS, cheb, presentationSnapshot, swapEventSink } from "../board";
import { legalActions, shotTargets } from "../combat";
import type { MatchRuleAdapter, MatchSide, RuleTurn } from "../contracts/match";
import type { RemoteArenaV1 } from "../contracts/arena";

export const PVP_RULESET = "mecha-pvp:v1";
export const PVP_MAX_TURNS = 30;
export type PvpUnit = { id: `${MatchSide}:${MechId}`; side: MatchSide; kind: MechId; pos: Cell; hp: number; cd: number; skillUsed: boolean };
export type PvpState = {
  ruleset: typeof PVP_RULESET;
  terrain: TerrainKind[][];
  heights: number[][];
  covers: Cell[];
  obstacles: Cell[];
  buildings: MatchState["buildings"];
  units: PvpUnit[];
  activeSide: MatchSide;
  turn: number;
  revision: number;
  winner: MatchSide | "draw" | null;
};

const other = (side: MatchSide): MatchSide => side === "A" ? "B" : "A";
const livingSide = (state: PvpState, side: MatchSide) => state.units.filter((unit) => unit.side === side && unit.hp > 0);
const unit = (state: PvpState, id: string) => state.units.find((item) => item.id === id && item.hp > 0);

export function pvpProjection(state: PvpState, side: MatchSide): MatchState {
  const mechs = livingSide(state, side).map((item) => ({ id: item.kind, pos: { ...item.pos } }));
  const projected = createMatch({
    preset: "covers_sparse_mid", script: "stationary_smash", covers: state.covers, terrain: state.terrain, heights: state.heights,
    buildings: state.buildings, obstacles: state.obstacles, mechs,
    raiders: livingSide(state, other(side)).map((item) => ({ id: item.id, pos: { ...item.pos }, hp: item.hp })),
    boss: { x: -1, y: -1 },
  });
  projected.boss.hp = 0;
  projected.phase = "player_plan";
  projected.turn = state.turn;
  projected.revision = state.revision;
  for (const item of projected.mechs) {
    const source = unit(state, `${side}:${item.id}`);
    item.hp = source!.hp;
    item.cd = source!.cd;
  }
  return projected;
}

export function createPvpMatch(arena: RemoteArenaV1): PvpState {
  const state: PvpState = {
    ruleset: PVP_RULESET,
    terrain: arena.terrain.map((row) => row.slice()),
    heights: arena.heights.map((row) => row.slice()),
    covers: [], obstacles: arena.blocked.map((cell) => ({ ...cell })),
    buildings: arena.buildings.map((building) => ({ id: building.id, cells: building.cells.map((cell) => ({ ...cell })), hp: 1, maxHp: 1 })),
    units: [], activeSide: "A", turn: 1, revision: 0, winner: null,
  };
  const open = (pos: Cell) => pos.x >= 0 && pos.x < BOARD && pos.y >= 0 && pos.y < BOARD
    && state.terrain[pos.y]?.[pos.x] !== "water"
    && !state.obstacles.some((cell) => cell.x === pos.x && cell.y === pos.y)
    && !state.buildings.some((building) => building.cells.some((cell) => cell.x === pos.x && cell.y === pos.y))
    && !state.units.some((item) => item.pos.x === pos.x && item.pos.y === pos.y);
  const spawn = (side: MatchSide, index: number, kind: MechId): Cell => {
    const x = [2, 5, 8][index]!;
    const candidates = Array.from({ length: BOARD }, (_, offset) => ({ x, y: side === "A" ? 9 - offset : offset }));
    const pos = candidates.find(open);
    if (!pos) throw new Error("pvp_spawn_unavailable");
    return { ...pos };
  };
  for (const side of ["A", "B"] as const) MECH_IDS.forEach((kind, index) => {
    state.units.push({ id: `${side}:${kind}`, side, kind, pos: spawn(side, index, kind), hp: STATS[kind].maxHp, cd: 0, skillUsed: false });
  });
  return state;
}

function fault(mechId: MechId, reason: string, cause: PlanFault["cause"] = "other"): { ok: false; fault: PlanFault } {
  return { ok: false, fault: { code: "PLAN_PACK_REJECTED", mechId, reason, cause } };
}

function bindTarget(state: MatchState, id: MechId, action: Exclude<Action, { kind: "skip" }>): Exclude<Action, { kind: "skip" }> {
  if (action.kind === "repair" || action.target !== undefined) return action;
  const legal = legalActions(state, id).filter((item) => item.kind === action.kind);
  return legal.length === 1 && "target" in legal[0] ? { ...action, target: legal[0].target } : action;
}

function actionLegal(state: MatchState, id: MechId, action: ArenaPlan["items"][number]["action"]): boolean {
  const legal = legalActions(state, id).filter((candidate) => candidate.kind === action.kind);
  if (action.kind === "skip") return legal.some((candidate) => candidate.kind === "skip");
  if (action.kind === "repair") return legal.some((candidate) => candidate.kind === "repair" && candidate.target === action.target);
  if (action.target === undefined) return legal.some((candidate) => !("target" in candidate) || candidate.target === undefined) || legal.length === 1;
  return legal.some((candidate) => !("target" in candidate) || candidate.target === action.target);
}

export function playPvpTurn(state: PvpState, plan: ArenaPlan): RuleTurn<PvpState> {
  if (state.winner || plan.revision !== state.revision) return { ok: false, fault: { code: "STALE_REVISION", reason: "revision mismatch", cause: "other" } };
  const side = state.activeSide;
  const alive = livingSide(state, side);
  if (alive.length === 0 || new Set(plan.items.map((item) => item.mechId)).size !== alive.length
    || alive.some((item) => !plan.items.some((order) => order.mechId === item.kind))) {
    return { ok: false, fault: { code: "NEED_ALL_OR_CONFIRM", reason: "pack must name every living mech once", cause: "other" } };
  }
  const next = structuredClone(state);
  const before = presentationSnapshot(pvpProjection(state, side));
  const log: TurnEvent[] = [];
  const outer = swapEventSink(log);
  try {
    const orders = MECH_IDS.flatMap((id) => {
      const item = plan.items.find((order) => order.mechId === id);
      return item && unit(next, `${side}:${id}`) ? [{ id, item }] : [];
    });
    const destinations = new Map<MechId, Cell>();
    for (const { id, item } of orders) {
      const actor = unit(next, `${side}:${id}`)!;
      const dest = item.moveTo ?? actor.pos;
      const distance = pathDistance(pvpProjection(next, side), actor.pos, dest, id, { alliesPass: true });
      if (distance === null || distance > moveBudget(id)) return fault(id, "destination occupied or out of reach", distance === null ? "occupied" : "out_of_reach");
      destinations.set(id, { ...dest });
    }
    for (const { id } of orders) {
      const actor = unit(next, `${side}:${id}`)!;
      const dest = destinations.get(id)!;
      if (orders.some(({ id: otherId }) => otherId !== id && destinations.get(otherId)!.x === dest.x && destinations.get(otherId)!.y === dest.y)) return fault(id, "destination occupied", "occupied");
      if (actor.pos.x !== dest.x || actor.pos.y !== dest.y) {
        log.push({ type: "move", mechId: id, from: { ...actor.pos }, to: { ...dest } });
        actor.pos = { ...dest };
      }
    }
    const afterMovement = presentationSnapshot(pvpProjection(next, side));
    for (const { id, item } of orders) {
      if (!actionLegal(pvpProjection(next, side), id, item.action)) return fault(id, "action not legal");
    }
    for (const { id, item } of orders) {
      const actor = unit(next, `${side}:${id}`);
      if (!actor || item.action.kind === "skip") continue;
      const action = bindTarget(pvpProjection(next, side), id, item.action);
      let reason = "";
      let damage = 0;
      if (action.kind === "repair") {
        const target = id === "Support" ? unit(next, `${side}:${action.target}`) : undefined;
        if (actor.cd !== 0 || !target || cheb(actor.pos, target.pos) !== 1) reason = "repair target not adjacent";
        else { target.hp = Math.min(STATS[target.kind].maxHp, target.hp + 4); actor.cd = 1; actor.skillUsed = true; }
      } else {
        const target = typeof action.target === "string" ? unit(next, action.target) : undefined;
        if (!target || target.side === side) reason = "target gone";
        else if (action.kind === "melee" || action.kind === "charge") {
          if (cheb(actor.pos, target.pos) !== 1 || (id !== "Assault" && id !== "Support") || (action.kind === "charge" && (id !== "Assault" || actor.cd !== 0))) reason = "not adjacent to an enemy";
          else {
            damage = Math.max(1, STATS[id].atk + (action.kind === "charge" ? 2 : 0) - STATS[target.kind].def);
            damage = Math.min(target.hp, damage);
            target.hp -= damage;
            if (action.kind === "charge") { actor.cd = 1; actor.skillUsed = true; }
          }
        } else {
          const projected = pvpProjection(next, side);
          if ((action.kind === "pierce" && (id !== "Gunner" || actor.cd !== 0)) || !shotTargets(projected, actor.pos, STATS[id].shoot, action.kind === "pierce" ? 1 : 0).includes(target.id)) reason = "shot blocked or out of range";
          else {
            damage = Math.max(1, STATS[id].atk - STATS[target.kind].def);
            damage = Math.min(target.hp, damage);
            target.hp -= damage;
            if (action.kind === "pierce") { actor.cd = 1; actor.skillUsed = true; }
          }
        }
      }
      log.push({ type: "act", mechId: id, action: action.kind, ...("target" in action && action.target !== undefined ? { target: action.target } : {}), damage, ...(reason ? { fizzled: true, cause: "target_gone" as const } : {}) });
      if (livingSide(next, other(side)).length === 0) { next.winner = side; break; }
    }
    for (const actor of livingSide(next, side)) {
      if (actor.skillUsed) actor.skillUsed = false;
      else if (actor.cd > 0) actor.cd -= 1;
    }
    next.revision += 1;
    if (side === "B") next.turn += 1;
    next.activeSide = other(side);
    if (!next.winner && next.turn > PVP_MAX_TURNS) {
      const a = livingSide(next, "A").reduce((sum, item) => sum + item.hp, 0);
      const b = livingSide(next, "B").reduce((sum, item) => sum + item.hp, 0);
      next.winner = a === b ? "draw" : a > b ? "A" : "B";
    }
    const afterPlayer = presentationSnapshot(pvpProjection(next, next.activeSide));
    return { ok: true, state: next, log, presentationStages: { before, afterMovement, afterPlayer, afterEnemy: afterPlayer, afterPrepare: afterPlayer } };
  } finally {
    swapEventSink(outer);
  }
}

export const pvpRules: MatchRuleAdapter<PvpState> = {
  ruleset: PVP_RULESET,
  activeSide: (state) => state.winner ? null : state.activeSide,
  playTurn: playPvpTurn,
  concede: (state, side) => ({ ...structuredClone(state), winner: other(side), revision: state.revision + 1, turn: state.turn + 1 }),
  isFinished: (state) => state.winner !== null,
};
