import { defineGame, type Vec3V1 } from "@oh-agent/city-game-sdk";

/**
 * DeepSeek Tower Defense — a minimal 3D tower-defense slice on the City route.
 *
 * Enemies are cubes that walk the first trusted route at 4 m/s. Two towers sit
 * one third and two thirds of the way along that route (by arc length) and each
 * burn the nearest enemy inside a 6 m radius at 25 dps. Three waves of five
 * enemies spawn 0.8 s apart; a leak costs 20 of the 100 base HP. The HUD tracks
 * wave/baseHealth/alive/killed, and the run ends as soon as wave 3 is cleared
 * (success) or the base is destroyed (failure).
 */

const ENEMY_SPEED = 4;
const ENEMY_HP = 30;
const TOWER_RANGE = 6;
const TOWER_DPS = 25;
const WAVE_SIZE = 5;
const WAVE_COUNT = 3;
const SPAWN_INTERVAL = 0.8;
const BASE_HEALTH = 100;
const LEAK_DAMAGE = 20;

function distanceBetween(a: Vec3V1, b: Vec3V1): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function routeLength(points: readonly Vec3V1[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceBetween(points[index - 1], points[index]);
  }
  return total;
}

/** World position at an arc-length offset, clamped to the route. */
function pointAtDistance(points: readonly Vec3V1[], offset: number): Vec3V1 {
  let remaining = Math.max(0, offset);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const segment = distanceBetween(previous, current);
    if (segment === 0) continue;
    if (remaining <= segment) {
      const ratio = remaining / segment;
      return [
        previous[0] + (current[0] - previous[0]) * ratio,
        previous[1] + (current[1] - previous[1]) * ratio,
        previous[2] + (current[2] - previous[2]) * ratio,
      ];
    }
    remaining -= segment;
  }
  return points[points.length - 1];
}

type Enemy = {
  id: string;
  hp: number;
  position: Vec3V1;
  segment: number;
};

export default defineGame({
  id: "community.tower-defense",
  setup(context) {
    const route = context.world.listRoutes()[0];
    if (!route || route.points.length < 2) {
      throw new Error("DeepSeek Tower Defense requires a City route with at least two points.");
    }
    const points = route.points;
    const totalLength = routeLength(points);
    const towers: Vec3V1[] = [
      pointAtDistance(points, totalLength / 3),
      pointAtDistance(points, (totalLength * 2) / 3),
    ];

    const enemies: Enemy[] = [];
    let wave = 1;
    let spawnedInWave = 0;
    let spawnCooldown = 0;
    let baseHealth = BASE_HEALTH;
    let killed = 0;
    let finished = false;

    function spawnEnemy(): void {
      const id = context.entities.spawn("cube", {
        position: points[0],
        scale: [0.8, 0.8, 0.8],
      });
      enemies.push({ id, hp: ENEMY_HP, position: points[0], segment: 0 });
      spawnedInWave += 1;
      spawnCooldown = SPAWN_INTERVAL;
    }

    context.onFixedUpdate((dt) => {
      if (finished) return;

      // Spawn: one enemy per wave slot, 0.8 s apart.
      if (spawnedInWave < WAVE_SIZE) {
        spawnCooldown -= dt;
        if (spawnCooldown <= 0) spawnEnemy();
      }

      // Movement + leaks. Iterate backwards so removals stay local.
      for (let index = enemies.length - 1; index >= 0; index -= 1) {
        const enemy = enemies[index];
        let remaining = ENEMY_SPEED * dt;
        while (remaining > 0 && enemy.segment < points.length - 1) {
          const target = points[enemy.segment + 1];
          const dx = target[0] - enemy.position[0];
          const dy = target[1] - enemy.position[1];
          const dz = target[2] - enemy.position[2];
          const segmentLength = Math.hypot(dx, dy, dz);
          if (segmentLength <= remaining) {
            enemy.position = target;
            enemy.segment += 1;
            remaining -= segmentLength;
          } else {
            const ratio = remaining / segmentLength;
            enemy.position = [
              enemy.position[0] + dx * ratio,
              enemy.position[1] + dy * ratio,
              enemy.position[2] + dz * ratio,
            ];
            remaining = 0;
          }
        }
        context.entities.update(enemy.id, { position: enemy.position });

        if (enemy.segment >= points.length - 1) {
          context.entities.destroy(enemy.id);
          enemies.splice(index, 1);
          baseHealth = Math.max(0, baseHealth - LEAK_DAMAGE);
        }
      }

      // Towers damage the nearest living enemy inside their radius.
      for (const tower of towers) {
        let nearest: Enemy | null = null;
        let nearestDistance = TOWER_RANGE;
        for (const enemy of enemies) {
          const distance = distanceBetween(tower, enemy.position);
          if (distance <= nearestDistance) {
            nearest = enemy;
            nearestDistance = distance;
          }
        }
        if (nearest) nearest.hp -= TOWER_DPS * dt;
      }

      // Remove enemies killed this tick.
      for (let index = enemies.length - 1; index >= 0; index -= 1) {
        if (enemies[index].hp > 0) continue;
        context.entities.destroy(enemies[index].id);
        enemies.splice(index, 1);
        killed += 1;
      }

      context.ui.setHud({
        wave,
        baseHealth,
        alive: enemies.length,
        killed,
      });

      if (baseHealth <= 0) {
        finished = true;
        context.finish("failure", "base_destroyed");
        return;
      }

      if (spawnedInWave >= WAVE_SIZE && enemies.length === 0) {
        if (wave >= WAVE_COUNT) {
          finished = true;
          context.finish("success", "all_waves_cleared");
          return;
        }
        wave += 1;
        spawnedInWave = 0;
        spawnCooldown = 0;
      }
    });
  },
});
