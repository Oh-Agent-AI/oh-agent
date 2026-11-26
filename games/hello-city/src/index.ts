import { defineGame, type Vec3V1 } from "@oh-agent/city-game-sdk";

/**
 * The first vertical slice (§16 of the PRD): one run-owned entity moves along
 * the City's first trusted route and reports its progress through the HUD.
 *
 * It deliberately uses `listRoutes()` instead of a hard-coded route id: the
 * route a City publishes is world-bound, and a template that assumes
 * "city-main-road" only works on one map. A missing route is a real failure,
 * so setup throws instead of silently finishing.
 */
function lengthOf(points: readonly Vec3V1[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    total += Math.hypot(current[0] - previous[0], current[1] - previous[1], current[2] - previous[2]);
  }
  return total;
}

export default defineGame({
  id: "community.hello-city",
  setup(context) {
    // Shortest trusted route: a template should finish visibly on any City,
    // not wait minutes on the longest arterial. This is a demo choice, not a
    // gameplay rule — a real game can pick by id or by travel time.
    const routes = context.world.listRoutes();
    const measured = routes
      .map((candidate) => ({ route: candidate, length: lengthOf(candidate.points) }))
      .sort((left, right) => left.length - right.length);
    // Prefer a route long enough to see (>= 40 m); fall back to the shortest.
    const route = (measured.find((entry) => entry.length >= 40) ?? measured[0])?.route;
    if (!route || route.points.length < 2) {
      throw new Error("hello-city requires a City route with at least two points.");
    }
    const points = route.points;
    const id = context.entities.spawn("cube", { position: points[0], scale: [0.8, 0.8, 0.8] });
    const speedMetersPerSecond = 10;

    let position: Vec3V1 = points[0];
    let segment = 0;
    let travelled = 0;

    context.onFixedUpdate((dt) => {
      let remaining = speedMetersPerSecond * dt;
      while (remaining > 0 && segment < points.length - 1) {
        const target = points[segment + 1];
        const dx = target[0] - position[0];
        const dy = target[1] - position[1];
        const dz = target[2] - position[2];
        const distance = Math.hypot(dx, dy, dz);
        if (distance <= remaining) {
          position = target;
          segment += 1;
          travelled += distance;
          remaining -= distance;
        } else {
          const ratio = remaining / distance;
          position = [position[0] + dx * ratio, position[1] + dy * ratio, position[2] + dz * ratio];
          travelled += remaining;
          remaining = 0;
        }
      }
      context.entities.update(id, { position });
      context.ui.setHud({ segment, travelledMeters: Math.round(travelled) });
      if (segment >= points.length - 1) context.finish("success", "route_complete");
    });
  },
});
