/** Projection-only A/B microbenchmark, not whole AI search or GPU timing.
 * Run: node --experimental-strip-types --import ./scripts/mecha-ts-register.mjs scripts/benchmark-mecha-unit-projection.ts */
import { performance } from "node:perf_hooks";
import { createMatch, bossPrepare } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { unitForSpecies, projectUnitPure } from "../apps/agent-city/ui/src/game/mecha/unitRegistry.ts";
import type { MonsterSpeciesId } from "../apps/agent-city/ui/src/game/mecha/board.ts";
const species = ["spore_leaper", "flux_lancer", "porous_shaper", "prism_warden", "swarm_mantle", "phase_stalker", "gravity_core", "neural_weaver"] as MonsterSpeciesId[];
for (const id of species) {
  const state = createMatch({ preset: "covers_sparse_mid", script: "siege", monsterContent: { speciesId: id, contentVersion: 1 } });
  bossPrepare(state);
  const unit = unitForSpecies(id)!, intent = state.boss.intent!;
  const iterations = 300, samples = 9;
  const run = (isolated: boolean) => {
    const inputs = Array.from({ length: iterations }, () => structuredClone(intent));
    const t = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (isolated) projectUnitPure(unit, state, inputs[i]!);
      else unit.project(state, inputs[i]!);
    }
    return (performance.now() - t) / iterations;
  };
  run(false); run(true);
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < samples; i++) { if (i % 2) { b.push(run(true)); a.push(run(false)); } else { a.push(run(false)); b.push(run(true)); } }
  a.sort((x,y) => x-y); b.sort((x,y) => x-y);
  console.log(JSON.stringify({ species: id, iterations, samples, previousMedianMs: a[4], isolatedMedianMs: b[4] }));
}
