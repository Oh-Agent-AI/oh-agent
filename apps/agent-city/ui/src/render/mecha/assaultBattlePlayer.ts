/** Board-driven battle presentation. Foot contact/IK belongs to the experimental previews, not turn playback. */
import * as THREE from "three";
import { MechaPerformancePlayer, mechaActionSpan, poseMechaModel, type MechaPerformanceOverride } from "./animation";
import { holdMechaGlbUpgrade } from "./models";
import type { MechaPerformanceEvent } from "./performance";

export const ASSAULT_BATTLE_SECONDS_PER_CELL = .2;
export const ASSAULT_BATTLE_WALK_CYCLE_SECONDS = .48;
export const ASSAULT_BATTLE_TURN_SECONDS = .1;
type Cell = { x: number; y: number };
type HeightSource = (x: number, z: number) => number;
export type AssaultBattleHeight = (x: number, z: number, fallback: number) => number;

/** Road detail is optional. Stale/missing geometry falls back to terrain, then board height, never blocks a match. */
export function createAssaultBattleHeight(road?: HeightSource, terrain?: HeightSource): AssaultBattleHeight {
  return (x, z, fallback) => {
    for (const source of [road, terrain]) {
      if (!source) continue;
      try { const value = source(x, z); if (Number.isFinite(value)) return value; } catch { /* presentation-only fallback */ }
    }
    return Number.isFinite(fallback) ? fallback : 0;
  };
}
const heading = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(from.x - to.x, from.z - to.z);
const yawDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export function createAssaultBattlePlayer(
  actors: Record<string, THREE.Group>, events: MechaPerformanceEvent[],
  cellToWorld: (cell: Cell, actor: string) => THREE.Vector3,
  effectRoot: THREE.Object3D, onComplete: () => void,
  height: AssaultBattleHeight = createAssaultBattleHeight(), initiallyFallen: readonly string[] = [],
  onEventSettled?: (index: number) => void,
): { player: MechaPerformancePlayer; release: () => void } {
  const assault = actors.Assault;
  if (!assault) throw new Error("missing Assault actor");
  const release = holdMechaGlbUpgrade(assault);
  try {
    const moveClipSpan = mechaActionSpan(assault, "move");
    const resolve = (cell: Cell, actor: string) => {
      const point = cellToWorld(cell, actor).clone();
      if (actor === "Assault") point.y = height(point.x, point.z, point.y);
      return point;
    };
    // Cache accepted waypoints, without measuring clip strides or changing rule paths.
    const routes = events.map(event => {
      if (event.actor !== "Assault" || event.kind !== "move") return null;
      const points = event.path.map(cell => resolve(cell, event.actor));
      const cumulative = [0];
      let cells = 0;
      for (let i = 1; i < points.length; i++) {
        cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
        cells += Math.hypot(event.path[i]!.x - event.path[i - 1]!.x, event.path[i]!.y - event.path[i - 1]!.y);
      }
      return { points, cumulative, length: cumulative.at(-1)!, duration: Math.max(.24, Math.min(1.2, cells * ASSAULT_BATTLE_SECONDS_PER_CELL)), startYaw: undefined as number | undefined };
    });
    const durations = events.map((event, index) => routes[index]?.duration ?? event.duration);
    const override: MechaPerformanceOverride = {
      durations,
      play(index, elapsed) {
        const route = routes[index];
        if (!route || route.points.length < 2 || route.length <= 1e-6) return elapsed / durations[index]!;
        route.startYaw ??= assault.rotation.y;
        const distance = Math.min(1, Math.max(0, elapsed / route.duration)) * route.length;
        let segment = 0;
        while (segment < route.points.length - 2 && distance >= route.cumulative[segment + 1]!) segment++;
        const from = route.points[segment]!, to = route.points[segment + 1]!;
        const length = route.cumulative[segment + 1]! - route.cumulative[segment]!;
        const local = length > 1e-6 ? (distance - route.cumulative[segment]!) / length : 1;
        assault.position.lerpVectors(from, to, local);
        assault.position.y = height(assault.position.x, assault.position.z, assault.position.y);
        const targetYaw = heading(from, to);
        const previousYaw = segment ? heading(route.points[segment - 1]!, from) : route.startYaw;
        const segmentSeconds = (distance - route.cumulative[segment]!) / route.length * route.duration;
        // Turn while travelling: no stationary turn stage or pose-transition delay.
        assault.rotation.set(0, previousYaw + yawDelta(previousYaw, targetYaw) * Math.min(1, segmentSeconds / ASSAULT_BATTLE_TURN_SECONDS), 0);
        poseMechaModel(assault, "move", elapsed / ASSAULT_BATTLE_WALK_CYCLE_SECONDS * moveClipSpan);
        return null;
      },
      afterPose(index) {
        const event = index === null ? undefined : events[index];
        // Movement already samples its root; keep knockback's intentional airborne hop.
        if (event?.actor === "Assault" && (event.kind === "move" || event.kind === "knockback")) return;
        assault.position.y = height(assault.position.x, assault.position.z, assault.position.y);
      },
      settle(index) {
        const route = routes[index];
        if (route && route.points.length > 1) assault.rotation.set(0, heading(route.points[route.points.length - 2]!, route.points.at(-1)!), 0);
      },
    };
    return { player: new MechaPerformancePlayer(actors, events, resolve, effectRoot, onComplete, override, initiallyFallen, onEventSettled), release };
  } catch (error) { release(); throw error; }
}
