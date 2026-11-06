/** Rules-consistent routes for presentation; they are not a geometry collision guarantee. */
import { moveBudget, pathRoute, type Cell, type MatchState, type MechId, type TurnEvent } from "./board";

export type PresentationRoute = { actor: MechId; cost: number; cells: Cell[] };
export type PresentationRoutes = { ok: true; routes: PresentationRoute[] } | { ok: false; reason: string };

export function buildPresentationRoutes(before: MatchState, log: TurnEvent[]): PresentationRoutes {
  const seen = new Set<MechId>();
  const routes: PresentationRoute[] = [];
  let actionsStarted = false;
  for (const event of log) {
    if (event.type !== "move") { actionsStarted = true; continue; }
    if (actionsStarted || seen.has(event.mechId)) return { ok: false, reason: "invalid movement order" };
    const unit = before.mechs.find((m) => m.id === event.mechId && m.hp > 0);
    if (!unit || unit.pos.x !== event.from.x || unit.pos.y !== event.from.y) return { ok: false, reason: "movement origin does not match" };
    const route = pathRoute(before, event.from, event.to, event.mechId, { alliesPass: true });
    if (!route || route.cost > moveBudget(event.mechId)) return { ok: false, reason: "movement route unavailable" };
    seen.add(event.mechId);
    routes.push({ actor: event.mechId, cost: route.cost, cells: route.cells });
  }
  return { ok: true, routes };
}
