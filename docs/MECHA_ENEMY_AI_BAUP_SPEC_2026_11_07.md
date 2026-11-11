# SPEC: Mecha Enemy AI v2 — Bounded Adversarial Utility Planning (BAUP)

- Status: Draft / implementation-ready
- Date: 2026-11-07
- Scope: v1.5 command engine, local PvE
- Supersedes: the design sketch in `MECHA_ENEMY_AI_V2_DESIGN_2026_11_07.md`
- Owner: Mecha combat / AI

---

## 0. TL;DR

Replace the fixed `scriptedEnemyPrepare` target picker with a **deterministic, bounded,
telegraphed adversarial planner**:

```text
enemy candidate plans
  -> resolve enemy actions on a clone
  -> model the player's next turn with an ensemble of policies
  -> score from the enemy perspective
  -> commit one legal EnemyPlan as Intent, before the player turn
```

The enemy never sees hidden player plans, never changes intent after seeing the player move,
and never uses randomness. Difficulty changes search depth/beam/weights, not stats.

---

## 1. Background

Current enemy decision path:

```text
prepareEnemy(state, scriptedEnemyPlanner)
  -> scriptedEnemyPrepare(state)
     - boss skill by script + cadence
     - pickSmash / pickSweep: local threat max, deterministic tie-break
     - raiders: nearest building assignment + one Dijkstra step
  -> applyEnemyPlan(state, plan)
  -> player turn
  -> resolveEnemyPhase(state)  // bossExecute + next prepare
```

Strengths: readable, deterministic, replayable, fully telegraphed.

Weaknesses:

- no player-response model;
- no boss/raider coordination;
- no objective trade-off (building vs mech vs survival);
- only local threat, so it cannot punish overextension or bait;
- difficulty only changes stats.

---

## 2. Goals

### G1. Stronger decisions
Choose among legal intents by their **worst-case / expected value after the player's
next turn**, not by the immediate threat of one cell.

### G2. Fairness
- identical public information for both sides;
- no reading of uncommitted player input;
- no randomness;
- no hidden intent changes;
- enemy plans remain fully visible before the player acts.

### G3. Readability
Every intent is still committed as `EnemyPlan`/`Intent`; the player can inspect all
threatened cells. A complexity penalty prevents "everything is dangerous" plans.

### G4. Determinism and replay
Same state + same difficulty -> byte-identical plan. Plan and execution are replayable.

### G5. Bounded cost
One planning pass per enemy phase; explicit evaluation budget; target < 30 ms normal,
< 100 ms hard on CI hardware.

### G6. Difficulty by search, not cheating
Easy/Normal/Hard differ in depth, beam width, opponent-model ensemble and weights.
Stats remain unchanged across difficulties.

### Non-goals
- No online learning, no neural nets, no Monte Carlo randomness.
- No hidden information or fog of war.
- No change to the player's command semantics.
- No change to the telegraph contract (enemy still declares before player turn).

---

## 3. Definitions

| Term | Meaning |
|---|---|
| `EnemyPlan` | Existing plan contract: boss anchor/cadence/intent, raider positions/intents, next phase/revision |
| `EnemyCandidate` | A legal `EnemyPlan` plus metadata (skill, targets, raider goals) |
| `PlayerPolicy` | `greedy`, `coordinated`, `beam` from `ai/difficulty.ts` |
| `ResponseModel` | Ensemble of player policies used to estimate the player's next turn |
| `EnemyValue` | Enemy-perspective utility after the simulated player response |
| `Commit` | The chosen plan is applied to the live state and telegraphed |
| `Simulation` | Applying a candidate to a clone; never publishes events or touches live state |

---

## 4. Architecture

```text
src/game/mecha/enemy/
  plannerV2.ts          // EnemyPlanner implementation, policy "baup:v1"
  candidates.ts         // boss + raider candidate generation
  simulate.ts           // plan -> state -> player response -> state
  evaluate.ts           // enemy utility + weights
  search.ts             // bounded beam/minimax loop
  contractsV2.ts        // optional: candidate/evaluation types
```

### 4.1 Public interfaces

```ts
export type EnemyDifficulty = "easy" | "normal" | "hard";

export interface EnemyPlannerV2 extends EnemyPlanner {
  readonly policy: "baup:v1";
  plan(state: MatchState, options?: { difficulty?: EnemyDifficulty; budget?: number }): EnemyPlan;
}

export type EnemyCandidate = {
  plan: EnemyPlan;
  skill: BossSkill | "skip";
  targets: Cell[];
  raiderGoals: Record<string, Cell[]>;
  tags: string[];
};
```

`prepareEnemy` passes the current difficulty/budget; `SequentialTurn`'s
`enemyPlanner` injection is the integration point for tests and EvE.

### 4.2 Evaluation-only mode

`applyEnemyPlan` must expose a pure-check mode used by search:

```ts
validateEnemyPlan(state, plan, { mode: "search" | "commit" }): boolean
```

- `search`: only legality/invariants; no events, no mutation.
- `commit`: current behavior plus evidence checks.

`simulate` always clones; it must never call `swapEventSink` or publish.

---

## 5. Candidate generation

### 5.1 Boss

Enumerate **legal** skills for the turn:

- `smash`: adjacent non-obstacle cells; cap 6 by threat.
- `sweep`: legal pairs within lane; cap 8.
- monster skills: use the species `declare` candidate set; cap 8.
- `skip`: always present.

Each candidate stores the exact `Intent` (`local` / `projected`) that would be telegraphed.

### 5.2 Raiders

For each living raider:

- goal classes:
  1. nearest building;
  2. second-nearest building;
  3. nearest mech;
  4. intercept/cut-off cell (rescue mode).
- per goal, take the first 1–2 Dijkstra steps;
- combine raider choices with a beam `B_raider`, not a Cartesian product;
- deterministic order: raider id, goal rank, cell order.

### 5.3 Caps

| Difficulty | Boss candidates | Raider beam | Total candidates |
|---|---:|---:|---:|
| easy | 1 (scripted) | 1 | 4 |
| normal | 8 | 4 | 64 |
| hard | 16 | 8 | 256 |

---

## 6. Simulation

For each candidate:

```ts
function simulate(state: MatchState, candidate: EnemyPlan, model: ResponseModel): MatchState {
  const afterEnemy = clone(state);
  applyEnemyPlanSearch(afterEnemy, candidate);       // set intents/positions
  beginEnemyPhase(afterEnemy);
  resolveEnemyPhase(afterEnemy, { capturePresentation: false }); // enemy actions
  return simulatePlayerResponse(afterEnemy, model);  // player commands, stop before next enemy phase
}
```

### 6.1 Player response model

Do **not** call the real player's UI or the live controller. Use:

```ts
type ResponseModel = Array<{ policy: SequentialPolicy; weight: number }>;
```

- `easy`: `[greedy: 1]`
- `normal`: `[greedy: .3, coordinated: .3, beam: .4]`
- `hard`: `[coordinated: .3, beam: .7]`

For each policy, run a bounded player turn on a clone:

- execute commands from the policy until it returns `end` or budget expires;
- evaluate **before** executing the end/enemy phase;
- do not inspect the live player's input or future plans.

`EnemyValue` for a candidate is:

```text
expected = Σ weight * evaluate(enemy, state_p)
worst    = min over policies evaluate(enemy, state_p)
value    = expected - λ * (expected - worst)   // λ = 0 easy, .25 normal, .5 hard
```

---

## 7. Enemy utility

```text
E = +10 * mech_damage
    + 8 * building_damage
    +12 * objective_progress
    + 6 * enemy_hp
    + 4 * status_value
    + 3 * threat_coverage
    - 8 * player_damage_to_enemy
    - .5 * complexity
```

- `mech_damage`: HP removed from living mechs.
- `building_damage`: HP removed from defended buildings.
- `objective_progress`: buildings destroyed / rescue blocked.
- `status_value`: freeze/stun/shove value applied to mechs.
- `threat_coverage`: number of valuable player cells threatened, capped.
- `player_damage_to_enemy`: expected damage the player can deal next turn.
- `complexity`: simultaneously threatened cells; cap 8 to protect readability.

Weights live in one exported table (`ENEMY_WEIGHTS`) and are covered by snapshot tests.

---

## 8. Search

Bounded beam/minimax:

```text
frontier = [root]
for depth in 0..D:
  expand each node with candidates (enemy) or player responses
  keep top B by E
  at the last enemy ply, record the best complete plan
return best plan
```

| Difficulty | Depth D | Beam B | Player responses P | Budget |
|---|---:|---:|---:|---:|
| easy | 0 | 1 | 1 | 8 |
| normal | 2 | 4 | 4 | 512 |
| hard | 4 | 8 | 8 | 2048 |

Rules:

- only complete plans are committed;
- budget exhaustion -> return best complete plan found, else scripted fallback;
- no partial plan, no random tie-break.

Deterministic tie-break:

```text
score desc -> canonical intent JSON asc -> target (x,y) asc -> raider id asc
```

---

## 9. Fairness contract

The following are **normative**:

1. The planner reads only public `MatchState` fields and the current difficulty.
2. It must not read player input state, UI draft, pending commands or future plans.
3. The committed intent is visible before the player acts and cannot change after.
4. Simulation must not mutate the live state or emit events.
5. No `Math.random`, `Date.now`, network or environment-dependent behavior in decisions.
6. Enemy and player use the same public rules; no stat cheating by difficulty.
7. Difficulty may increase search/conditional intents, not hidden information.

### Fairness metrics

Measured by `scripts/benchmark-mecha-ai.mjs` + EvE harness:

| Metric | Target (normal) |
|---|---|
| win rate vs beam player | 45–55% |
| win rate vs greedy | 50–60% |
| average player HP | not lower than scripted by > 20% |
| average building loss | not higher than scripted by > 20% |
| average decision time | < 30 ms normal, < 100 ms hard |
| average threatened cells | ≤ 6 normal, ≤ 8 hard |

If normal exceeds 65% vs beam, reduce λ/depth or increase player-side compensation.

---

## 10. Contract changes

1. `EnemyPlan.policy` accepts `"baup:v1"`.
2. `applyEnemyPlan`:
   - `mode:"search"` validates legality but not scripted equality;
   - `mode:"commit"` validates evidence:
     - revision matches;
     - boss/raider intent is legal for the state;
     - raider positions respect movement/path limits;
     - monster invariants (swarm origin, neural links, corrode targets) hold.
3. Preview and execution must use the same planner instance/difficulty.
4. `scriptedEnemyPlanner` stays as easy fallback and golden oracle.
5. `SequentialTurn(initial, { enemyPlanner })` remains the injection point.

---

## 11. Telemetry (local only)

Per planning pass, log to an in-memory ring buffer (no upload):

```ts
{ revision, difficulty, candidates, evaluated, chosenPolicy, score, ms, fallback }
```

Expose via MCP `mecha_enemy_plan` for debugging. No user data leaves the machine.

---

## 12. Test plan

### Unit
- candidate generation: legal cells, caps, deterministic order;
- evaluator: weights, sign, complexity cap, mission scoring;
- tie-break: canonical order;
- fallback: budget exhausted -> scripted plan.

### Property / golden
- 100 deterministic openings -> same plan twice;
- every committed plan passes `applyEnemyPlan` commit validation;
- preview plan equals executed plan;
- replay of committed plans reconstructs the same revision.

### Integration
- `prepareEnemy` with BAUP; one player turn; `resolveEnemyPhase`;
- monster species invariants (spore/prism/gravity/swarm/neural/corrode/phase);
- rescue mission objective.

### Benchmark
- EvE: player greedy/coordinated/beam × enemy scripted/BAUP easy/normal/hard;
- report win rate, HP, buildings, ms, threatened cells;
- CI budget: BAUP normal benchmark < 20 s.

### UI
- telegraph renders all BAUP intent cells;
- no hidden extra threat;
- performance of online preview.

---

## 13. Acceptance criteria

- [ ] `enemy/plannerV2.ts` exports `EnemyPlanner` policy `baup:v1`.
- [ ] Normal: depth 2, beam 4, response model 3 policies; deterministic.
- [ ] All committed plans legal; no event leakage from simulation.
- [ ] Preview == execution for the same state/difficulty.
- [ ] `verify:mecha` green; new BAUP tests ≥ 12.
- [ ] Benchmark normal: 45–55% vs beam, decision < 30 ms.
- [ ] No hidden player input; no randomness.
- [ ] Scripted fallback still works.

---

## 14. Rollout

1. Land `plannerV2` + tests behind `difficulty` (default still scripted).
2. Add MCP `mecha_enemy_plan` and benchmark rows.
3. Tune weights on 3+ scenarios until fairness targets hold.
4. Make normal default; keep easy=scripted.
5. Only then consider conditional intents (declared reaction branches).

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Enemy feels like it reads player | Ensemble response model, no live input, λ cap |
| Too slow | budget, beam caps, candidate cache |
| Unreadable threat soup | complexity penalty, threatened-cell cap |
| Custom plans rejected by old validation | mode:"search"/"commit" split, evidence checks |
| Replay divergence | deterministic tie-break, same planner in preview/execution |
| Difficulty only feels like more HP | search depth/beam/λ table, no stat changes |

---

## 16. Pseudocode

```ts
function planEnemy(state: MatchState, difficulty: EnemyDifficulty): EnemyPlan {
  const candidates = generateCandidates(state, difficulty);       // legal, capped
  const model = responseModelFor(difficulty);                     // policy ensemble
  let best: { plan: EnemyPlan; value: number } | null = null;
  for (const candidate of candidates) {
    if (budget.exhausted()) break;
    const after = simulate(state, candidate.plan, model);
    const value = evaluateEnemy(state, candidate.plan, after);
    if (!best || value > best.value || (value === best.value && canonical(candidate.plan) < canonical(best.plan))) {
      best = { plan: candidate.plan, value };
    }
  }
  return best?.plan ?? scriptedEnemyPlanner.plan(state);
}
```

---

## 17. Open questions

1. Should normal allow one declared reaction branch, or keep it hard-only?
2. Should raider goals include "intercept rescue target" by default?
3. How much of `next` phase metadata must BAUP fill for validation/replay?
4. Do we expose difficulty in MCP only, or also a hidden debug switch in UI?
5. What is the exact player-response budget per policy (commands vs time)?
