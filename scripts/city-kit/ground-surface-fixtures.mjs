// Synthetic-only geometry extraction fixtures. No session data or host bridge.
import { createHash } from "node:crypto";
export function groundSurfaceFixtures() {
  const edge = (id, from, to, a, b, width = 8, bridge = false) => ({ id, from, to, points: [a, b], width, kind: width >= 8 ? "arterial" : "local", bridge });
  const o = { x: 0, z: 0 }, w = { x: -60, z: 0 }, e = { x: 60, z: 0 }, n = { x: 0, z: -60 };
  const west = edge("west", "w", "o", w, o), east = edge("east", "o", "e", o, e);
  const tee = [west, east, edge("north", "o", "n", o, n, 5)];
  const flat = { height: () => 2 };
  const layout = (roadEdges, terrain = flat) => ({ extent: 400, roadEdges, terrain });
  return [
    ["empty", layout([])], ["straight", layout([west, east])],
    ["bend", layout([west, edge("north", "o", "n", o, n)])],
    ["tee", layout(tee)],
    ["skew", layout([west, east, edge("skew", "o", "s", o, { x: 46, z: 39 }, 5)])],
    ["width-transition", layout([west, { ...east, width: 5, kind: "local" }])],
    ["bridge-boundary", layout([west, { ...east, bridge: true }])],
    ["closed-loop", layout([edge("a", "o", "e", o, e), edge("b", "e", "n", e, n), edge("c", "n", "o", n, o)])],
    ["wavy-tee", layout(tee, { height: (x, z) => 2 + Math.sin(x * 0.07) * 3 + Math.cos(z * 0.05) * 2 + x * 0.01 })],
  ];
}
export function groundGeometryDigest(layers) {
  const digest = createHash("sha256");
  for (const layer of layers) for (const field of ["positions", "normals", "colors", "uv", "run", "ends", "edges", "zebra", "index"]) {
    const values = field === "index" ? new Uint32Array(layer[field]) : new Float32Array(layer[field]);
    digest.update(field + ":" + values.length + ":"); digest.update(new Uint8Array(values.buffer));
  }
  return digest.digest("hex");
}
