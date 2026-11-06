import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const manifest = JSON.parse(fs.readFileSync(new URL("./verification-manifest.json", import.meta.url), "utf8"));
const synthetic = ["verify-city-block-surface", "verify-city-shore-plot-access", "verify-city-joint-frontage", "verify-city-road-blocks", "verify-city-road-admission", "verify-city-junction-rings", "verify-city-highway-ramps", "verify-city-world", "verify-city-access-capabilities", "verify-city-endpoint-routing", "verify-city-road-faces", "verify-city-radius", "verify-city-network-patch", "verify-city-connect", "verify-city-footprint-geoms", "verify-city-loop", "verify-city-landing"];
const groups = {
  network: [...synthetic, "verify-city-causeway-primary", "verify-city-road-report", "verify-city-intent", "verify-city-solve", "verify-react-city-layout", "verify-city-cross-engine"],
  sites: ["verify-city-shore-plot-access", "verify-city-shore-plot-access-named", "verify-city-joint-frontage", "verify-city-required-placement", "verify-city-causeway-primary", "verify-city-world", "verify-city-access-capabilities", "verify-city-footprint-geoms", "verify-city-sitespec", "verify-city-models", "verify-city-physical", "verify-react-city-layout", "verify-city-intent"],
  planning: ["verify-city-block-surface", "verify-city-shore-plot-access", "verify-city-shore-plot-access-named", "verify-city-joint-frontage", "verify-city-required-placement", "verify-city-road-blocks", "verify-city-road-admission", "verify-city-junction-rings", "verify-city-highway-ramps", "verify-city-causeway-primary", "verify-city-world", "verify-city-road-faces", "verify-city-endpoint-routing", "verify-city-radius", "verify-city-road-report", "verify-city-planning", "verify-city-constraints", "verify-city-baseline", "verify-city-survey", "verify-city-cross-engine", "verify-plan-patch", "verify-plan-repair-controller", "verify-plan-road-rules", "verify-plan-sites", "verify-plan-bulldozer", "verify-plan-remap", "verify-plan-repair-copy", "verify-plan-repair-bridgehead", "verify-plan-terrain", "verify-city-landmark-platforms", "verify-plan-repair-drivability", "verify-city-minimap", "verify-city-road-standard"],
  display: ["verify-city-block-surface", "verify-city-road-report", "verify-city-active", "verify-react-city-layout", "verify-city-culdesac-bulbs", "verify-city-replay-snap", "verify-city-scene-baseline", "verify-react-city-seaside", "seaside-tier10", "verify-react-city-append"],
  game: ["verify-city-game-session", "verify-city-game-controller", "verify-city-game-world", "verify-city-game-flight", "verify-city-game-race", "verify-city-game-profile",
    "verify-city-driving", "verify-city-car-model", "verify-city-driving-architecture", "verify-city-audit-evidence", "verify-city-audit-planner", "verify-city-road-audit-ui", "verify-city-road-audit-history", "verify-city-road-audit-worker", "verify-city-driving-release-graph", "verify-city-driving-spawns", "verify-city-car-session", "verify-city-car-rendered-collision", "verify-city-driving-entry", "verify-city-shared-runtime"],
};
for (const id of ["verify-city-game-scene-lease", "verify-city-game-audio-service", "verify-city-runtime-diagnostics", "verify-city-shared-game-ux", "verify-city-camera-collision-query", "verify-city-preparation", "verify-city-driving-mountable", "verify-city-driving-bridge-crossing", "verify-city-static-world"]) groups.game.push(id);
groups.game.push("verify-city-mecha-ux");
groups.game.push("verify-city-continuous-driving", "verify-city-driving-collision-differential", "verify-city-rotation-budget");
const newGeometryStages = ["verify-city-layout-envelopes", "verify-city-parcel-frontage", "verify-city-block-placement", "verify-city-block-lot-candidates", "verify-city-villa-physical", "verify-city-model-ground"];
synthetic.push(...newGeometryStages);
synthetic.push("verify-city-operation-budget");
synthetic.push("verify-city-planning-job");
groups.planning.push("verify-city-planning-job");
synthetic.push("verify-city-plan-disk-cache");
groups.planning.push("verify-city-plan-disk-cache");
groups.planning.push("verify-city-operation-budget");
synthetic.push("verify-city-layout-capacity");
synthetic.push("verify-city-model-envelope");
synthetic.push("verify-city-site-registry");
synthetic.push("verify-city-joint-site-road");
// R2：纯静态 import 边界扫描（不跑规划），便宜，fast 与 planning 都带上。
synthetic.push("verify-city-import-boundary");
groups.planning.push("verify-city-import-boundary");
for (const group of ["network", "planning", "sites"]) groups[group].push("verify-city-joint-site-road");
groups.planning.push("verify-city-site-registry");
groups.sites.push("verify-city-site-registry");
groups.planning.push("verify-city-site-registry-scene");
groups.sites.push("verify-city-site-registry-scene");
groups.planning.push("verify-city-model-envelope");
groups.sites.push("verify-city-model-envelope");
groups.planning.push("verify-city-villa-placement");
groups.sites.push("verify-city-villa-placement");
groups.planning.push("verify-city-layout-capacity");
groups.display.push("verify-city-layout-capacity");
groups.planning.push(...newGeometryStages, "verify-city-road-derived-plan");
groups.sites.push(...newGeometryStages);
groups.display.push("verify-city-layout-envelopes", "verify-city-layout-placement", "verify-city-parcel-frontage", "verify-city-block-placement", "verify-city-block-lot-candidates");
groups.planning.push("verify-city-layout-placement");
groups.sites.push("verify-city-layout-placement");
groups.display.push("verify-city-coastal-receivers");
export function selectStages(mode, group) {
  if (mode === "full") return manifest;
  if (mode === "fast") return manifest.filter((s) => synthetic.includes(s.id));
  if (mode === "module" && groups[group]) return manifest.filter((s) => groups[group].includes(s.id));
  throw new Error("Usage: verify-city-suite.mjs full|fast|module <network|sites|planning|display|game> [--no-cache] [--report <path>]");
}
export const typecheck = {
  id: "typecheck", cwd: fileURLToPath(new URL("../../apps/agent-city/ui/", import.meta.url)),
  command: "npm", args: ["run", "typecheck"],
};
export const build = { ...typecheck, id: "build", args: ["run", "build"] };
