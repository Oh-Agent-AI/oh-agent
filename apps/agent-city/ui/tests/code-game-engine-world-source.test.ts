import test from "node:test";
import assert from "node:assert/strict";
import { createCityEngineWorldSourceV1 } from "../src/game/codeGameHost/cityEngineWorldSource.ts";
import type { CityEngineWorldLayoutV1 } from "../src/game/codeGameHost/cityEngineWorldSource.ts";

/**
 * The live-City projection must be deterministic (sorted arterial edges) and
 * must never use a generated-but-unaccepted road: only `arterial` edges become
 * routes. Terrain height/normal come from the actual field, not from y = 0.
 */

const layout: CityEngineWorldLayoutV1 = {
  seed: 123,
  terrain: {
    height: (x, _z) => x * 0.1,
    buildable: (x, _z) => x >= 0,
  },
  roadEdges: [
    {
      id: "local-1",
      from: "n0",
      to: "n1",
      width: 6,
      kind: "local",
      points: [
        { x: 0, z: 0 },
        { x: 5, z: 5 },
      ],
    },
    {
      id: "b-arterial",
      from: "n1",
      to: "n2",
      width: 12,
      kind: "arterial",
      points: [
        { x: 10, z: 0 },
        { x: 20, z: 4 },
      ],
    },
    {
      id: "a-arterial",
      from: "n0",
      to: "n1",
      width: 14,
      kind: "arterial",
      points: [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
      ],
    },
  ],
  roadNodes: [
    { id: "n0", x: 0, z: 0 },
    { id: "n1", x: 10, z: 0 },
  ],
  blocks: [{ id: "block-1", x: 4, z: 2, width: 8, depth: 6 }],
};

test("only arterial edges become routes, in stable id order", () => {
  const world = createCityEngineWorldSourceV1({
    cityId: "city-live",
    cityRevision: 9,
    worldRevision: "world-9",
    layoutId: "layout-live",
    layout,
  });
  assert.deepEqual(world.city(), {
    cityId: "city-live",
    seed: 123,
    worldRevision: "world-9",
    layoutId: "layout-live",
  });
  const routes = world.listRoutes();
  assert.deepEqual(routes.map((route) => route.id), ["road-a-arterial", "road-b-arterial"]);
  assert.deepEqual(routes[0]?.points, [
    [0, 0, 0],
    [10, 1, 0],
  ]);
  assert.equal(world.getRoute("road-a-arterial")?.points.length, 2);
  assert.equal(world.getRoute("road-local-1"), null);
});

test("terrain sampling uses the real field for height, normal and walkability", () => {
  const world = createCityEngineWorldSourceV1({
    cityId: "city-live",
    cityRevision: 9,
    worldRevision: "world-9",
    layoutId: "layout-live",
    layout,
  });
  const sample = world.sampleTerrain(5, 2);
  assert.ok(sample);
  assert.equal(sample.height, 0.5);
  const length = Math.hypot(sample.normal[0], sample.normal[1], sample.normal[2]);
  assert.ok(Math.abs(length - 1) < 1e-9, "normal must be unit length");
  assert.ok(Math.abs(sample.normal[0] + 0.1 / Math.hypot(0.1, 1)) < 1e-9);
  assert.equal(sample.walkable, true);
  assert.equal(world.sampleTerrain(-5, 0)?.walkable, false);
});

test("block queries are bounded by the requested box and expose block bounds", () => {
  const world = createCityEngineWorldSourceV1({
    cityId: "city-live",
    cityRevision: 9,
    worldRevision: "world-9",
    layoutId: "layout-live",
    layout,
  });
  const inside = world.queryObjects({ min: [0, 0, 0], max: [10, 10, 10] });
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.id, "block-1");
  assert.deepEqual(inside[0]?.bounds.min, [0, -0.6, -1]);
  const outside = world.queryObjects({ min: [50, 0, 50], max: [60, 10, 60] });
  assert.equal(outside.length, 0);
  assert.equal(world.sampleTerrain(Number.NaN, 0), null);
});

test("the generated world's seed is the City layout seed, not a game seed", () => {
  const world = createCityEngineWorldSourceV1({
    cityId: "city-live",
    cityRevision: 9,
    worldRevision: "world-9",
    layoutId: "layout-live",
    layout,
  });
  assert.equal(world.city().seed, 123);
});
