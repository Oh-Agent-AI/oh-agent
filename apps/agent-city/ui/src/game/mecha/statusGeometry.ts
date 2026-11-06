/** Reconcile status-trigger geometry against the recorded movement and rule projection. */
import { displacementWorld, eq, mech, reprojectDisplacement, ringPierceCells, sporeLeapCells, sporeLeapReachable, type HealthEffect, type MatchState, type TurnEvent } from "./board";
import { canonicalJson } from "./contracts/match";
import { PRISM_FROST_RANGE } from "./prismUnit";

type EnemyEvent = Extract<TurnEvent, { type: "enemy" }>;
type GravityEvent = Extract<TurnEvent, { type: "monster_displacement" | "gravity_collision" }>;
const invalid = (reason: string) => ({ ok: false as const, reason });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function verifyStatusGeometry(before: MatchState, events: readonly TurnEvent[]): { ok: true } | { ok: false; reason: string } {
  try {
    if (!before.statusEncounter || !Array.isArray(events)) return invalid("invalid_status_geometry_input");
    const state = structuredClone(before);
    let enemy: EnemyEvent | null = null, enemyBefore: MatchState | null = null;
    let expectedHits = new Set<string>();
    const gravity: { expected: GravityEvent[] | null } = { expected: null };
    const startGravity = (): boolean => {
      if (gravity.expected) return true;
      const intent = state.boss.intent;
      if (state.monsterContent?.speciesId !== "gravity_core" || intent?.skillId !== "gravity_well" || !intent.displacement) return false;
      const projection = reprojectDisplacement(displacementWorld(state), intent.displacement);
      if (projection.status !== "reprojected") return false;
      gravity.expected = [];
      for (const effect of projection.effects) {
        if (effect.status === "move" && effect.from && effect.to) gravity.expected.push({ type: "monster_displacement", skill: "gravity_well", moves: [{ unit: effect.entityId, from: { ...effect.from }, to: { ...effect.to } }] });
        else if (effect.collision && effect.entityId.startsWith("mech:")) gravity.expected.push({ type: "gravity_collision", schema: "mecha-gravity-collision:v1", target: effect.entityId.slice(5) as "Assault" | "Gunner" | "Support", cell: { ...effect.collision.cell }, blocker: { ...effect.collision.blocker } });
      }
      return true;
    };
    for (const event of events) {
      if (!event || typeof event !== "object") return invalid("invalid_geometry_event");
      if ((event.type === "monster_displacement" && event.skill === "gravity_well") || event.type === "gravity_collision") {
        if (!startGravity() || !gravity.expected?.length) return invalid("unexpected_gravity_effect");
        const expected = gravity.expected.shift()!;
        // Presentation sequence numbers are validated by the normal change timeline.
        const actual = event.type === "monster_displacement" ? { type: event.type, skill: event.skill, moves: event.moves } : event;
        if (!same(expected, actual)) return invalid("gravity_evidence_mismatch");
      }
      if (event.type === "enemy") {
        if (expectedHits.size) return invalid("missing_status_hit");
        if (event.actor === "boss" && event.skill === "gravity_well" && !gravity.expected && !startGravity()) return invalid("unexpected_gravity_attack");
        if (gravity.expected?.length) return invalid("missing_gravity_effect");
        enemy = event; enemyBefore = structuredClone(state);
        expectedHits = new Set(event.actor === "boss" && ["spore_leap", "ring_pierce", "prism_frost"].includes(event.skill)
          ? (event.effects ?? []).filter((effect: HealthEffect) => effect.kind === "mech" && effect.after > 0 && effect.after < effect.before).map((effect: HealthEffect) => effect.id) : []);
      } else if (event.type === "status_hit") {
        if (!enemy || !enemyBefore || enemy.skill !== event.skill || enemy.actor !== "boss" || event.source !== "boss") return invalid("missing_attack_evidence");
        const target = mech(state, event.target), intent = enemyBefore.boss.intent;
        if (!target || !expectedHits.delete(event.target) || !eq(target.pos, event.cell) || !intent || intent.skillId !== event.skill) return invalid("status_target_mismatch");
        let cells;
        if (event.skill === "spore_leap") cells = sporeLeapCells(enemyBefore.boss.anchor);
        else {
          if (!intent.direction || (intent.lane !== 0 && intent.lane !== 1)) return invalid("missing_attack_binding");
          cells = ringPierceCells(enemyBefore, enemyBefore.boss.anchor, intent.direction, intent.lane);
          if (event.skill === "prism_frost") cells = cells.slice(0, PRISM_FROST_RANGE);
        }
        if (!same(cells, enemy.cells) || !cells.some(c => eq(c, event.cell))) return invalid("attack_cells_mismatch");
        if (event.skill === "prism_frost") {
          const first = cells.flatMap(c => enemyBefore!.mechs.filter(m => m.hp > 0 && eq(m.pos, c)))[0];
          if (first?.id !== event.target) return invalid("frost_target_not_first");
        }
      }
      if (event.type === "move") {
        const unit = mech(state, event.mechId);
        if (!unit || !eq(unit.pos, event.from)) return invalid("status_move_mismatch");
        unit.pos = { ...event.to };
      } else if (event.type === "boss_move") {
        if (!eq(state.boss.anchor, event.from)) return invalid("status_boss_move_mismatch");
        if (state.monsterContent?.speciesId === "spore_leaper" && state.boss.intent?.skillId === "spore_leap") {
          const offset = state.boss.intent.landingOffset;
          if (!offset || !eq(event.to, { x: event.from.x + offset.x, y: event.from.y + offset.y }) || !sporeLeapReachable(state, event.to)) return invalid("invalid_spore_landing");
        }
        state.boss.anchor = { ...event.to };
      } else if (event.type === "monster_displacement") {
        for (const move of event.moves) {
          if (move.unit === "boss") {
            if (!eq(state.boss.anchor, move.from)) return invalid("status_boss_move_mismatch");
            state.boss.anchor = { ...move.to };
          } else {
            const unit = state.mechs.find(m => `mech:${m.id}` === move.unit);
            if (!unit || unit.hp <= 0 || !eq(unit.pos, move.from)) return invalid("status_move_mismatch");
            unit.pos = { ...move.to };
          }
        }
      } else if (event.type === "shove" && !event.hit) {
        const pos = event.unit === "boss" ? state.boss.anchor : mech(state, event.unit)?.pos;
        if (!pos) return invalid("status_move_mismatch");
        pos.x += event.dir.x; pos.y += event.dir.y;
      }
      if ("effects" in event) for (const effect of event.effects ?? []) {
        const unit = effect.kind === "mech" ? state.mechs.find(m => m.id === effect.id) : effect.kind === "boss" ? state.boss :
          effect.kind === "raider" ? state.raiders.find(r => r.id === effect.id) : state.buildings.find(b => b.id === effect.id);
        if (!unit || unit.hp !== effect.before || effect.after < 0 || !Number.isSafeInteger(effect.after)) return invalid("status_health_mismatch");
        unit.hp = effect.after;
      }
    }
    if (gravity.expected?.length) return invalid("missing_gravity_effect");
    return expectedHits.size ? invalid("missing_status_hit") : { ok: true };
  } catch { return invalid("invalid_status_geometry"); }
}
