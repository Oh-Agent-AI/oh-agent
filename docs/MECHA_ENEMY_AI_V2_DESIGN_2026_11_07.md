# Mecha Enemy AI v2: Bounded Adversarial Utility Planning (BAUP)

Status: design, 2026-11-07. Applies to the v1.5 command engine.

## 1. Why the current enemy is weak

`scriptedEnemyPrepare` is a deterministic script:

- boss skill by `script` + `cadence`;
- `pickSmash` / `pickSweep` maximize a local threat score;
- raiders take one Dijkstra step toward a greedily assigned building;
- no player-response model, no objective trade-off, no coordination between boss and raiders.

It is readable and replayable, but it cannot punish overextension, cannot choose between
two equally legal attacks with different next-turn consequences, and cannot coordinate
raider pressure with the boss.

## 2. Design principles

1. **Telegraph first.** Every decision is still committed as an `Intent` before the player
   turn; BAUP only chooses *which* legal intent to declare.
2. **Deterministic.** No randomness. Ties resolve by canonical intent JSON, then cell order.
3. **No hidden information.** Candidates and scores use only the public state the player sees.
4. **Bounded.** A fixed evaluation budget; planning runs once per enemy phase.
5. **Legible.** Prefer plans whose threatened cells are few and coherent; penalize
   "everything is dangerous" intents.
6. **Difficulty changes search, not only stats.** Easy/Normal/Hard alter depth, beam width
   and utility weights.

## 3. Decision problem

At `enemy_prepare`, choose an `EnemyPlan`:

```text
plan = { boss: {anchor, intent}, raiders: [{id, pos, intent}], revision }
```

BAUP solves a depth-2 (optionally depth-4) alternating game:

```text
enemy plan  ->  player response  ->  value
   max              min
```

The player response is a **model**, not the actual player: it uses a cheap policy
(`coordinated` or a small beam) on a cloned state. This keeps the enemy challenging
without making it depend on the exact player implementation.

## 4. Candidate generation

### Boss

For each legal skill available this turn:

- `smash`: every adjacent non-obstacle cell (cap K=6 by threat);
- `sweep`: every legal pair within the sweep lane (cap K=8);
- monster skills (`spore_leap`, `prism_guard`, `gravity_well`, ...): use the species
  `declare` candidate set, capped;
- `skip`: always included (feints / repositioning).

### Raiders

- Assign each raider a small set of goal classes:
  - nearest building,
  - second-nearest building,
  - nearest mech,
  - cut-off/intercept cell.
- For each goal, take the first 1-2 Dijkstra steps.
- Combine raider choices with a beam of width `B_raider`, not a Cartesian product.

### Cap

`maxCandidates = 64` for normal, `16` for easy, `256` for hard.

## 5. Evaluation

Enemy-perspective utility after the player response:

```text
E =  + w_mech_damage      * damage dealt to mechs
     + w_building_damage  * building HP removed
     + w_objective        * objective progress (destroy buildings / block rescue)
     + w_enemy_survival   * enemy HP remaining
     + w_status           * freeze/stun/shove value
     + w_position         * threat coverage of valuable cells
     - w_player_damage    * damage the player can deal back
     - w_complexity       * number of simultaneously threatened cells
```

Suggested weights (normal):

```text
mech 10, building 8, objective 12, survival 6,
status 4, position 3, player_damage 8, complexity 0.5
```

The complexity term is the readability guard: an intent that threatens every cell is
less useful than a focused one, even if raw damage is equal.

## 6. Search

```text
frontier = [root]
for depth in 0..D:
  for node in frontier:
    if node.turn == enemy: expand legal enemy plans (max A)
    else: expand player responses (max P, cheap policy)
  frontier = top B nodes by heuristic
  if depth is odd: record best enemy plan by minimax value
return best plan
```

- Normal: `D=2`, `B=4`, `A=16`, `P=4`.
- Hard: `D=4`, `B=8`, `A=32`, `P=8`.
- Easy: `D=0` (current scripted plan) or `D=2, B=1`.

Budget: stop after `maxEvaluations` (default 512 normal, 2048 hard) and return the best
complete plan; partial plans are never committed.

## 7. Determinism

- Candidate order fixed by `(skillId, target cells, raider id, goal rank)`.
- Score ties: canonical JSON of the intent, then `(x,y)`.
- No timers, no `Math.random`, no iteration over object key insertion order.

## 8. Contract changes

`applyEnemyPlan` currently accepts only the scripted plan for most species. To ship BAUP:

1. Add `planner: "scripted:v1" | "baup:v1"` to `EnemyPlan`.
2. Replace the scripted-equality check with **evidence validation**:
   - intent is legal for the current state;
   - target cells are in the legal candidate set;
   - raider positions satisfy movement/Dijkstra limits;
   - revision matches; monster-specific invariants (swarm origin, neural links) hold.
3. Preview uses the same planner as execution (`prepareEnemy`), so the telegraph matches.
4. Keep the scripted planner as the Easy fallback and as a golden oracle.

## 9. Performance budget

- Planning once per enemy phase, not per render.
- Target: < 30 ms normal, < 100 ms hard on the MCP/CI machine.
- Cache legal candidate sets per `(state.revision, turn)`.
- Reuse `structuredClone` carefully; avoid cloning full `SequentialRecord` history.

## 10. Tests and acceptance

- **Determinism**: same state -> same plan, 100 random openings.
- **Legality**: every committed plan passes `applyEnemyPlan` validation.
- **Telegraph**: preview plan equals executed plan.
- **No hidden info**: planner reads only `MatchState` public fields.
- **Benchmark** (EvE harness):
  - player policies: greedy / coordinated / beam;
  - enemy: scripted vs BAUP easy/normal/hard;
  - report win rate, average player HP, building loss, decision time.
- **Readability**: average threatened cells per intent; cap hard at 8.

## 11. Rollout

1. Implement BAUP as `enemy/plannerV2.ts` behind `difficulty`.
2. Keep scripted planner as default for one release; A/B via MCP/EvE.
3. When normal/hard win rates and decision time meet targets, make BAUP default.
4. Keep the telegraph contract and replay format unchanged.

## 12. Pseudocode

```ts
function planEnemy(state, difficulty): EnemyPlan {
  const candidates = generateEnemyCandidates(state, difficulty); // legal, capped
  let best = null;
  for (const candidate of candidates) {
    const afterEnemy = simulateEnemy(state, candidate);
    const playerResponses = generatePlayerResponses(afterEnemy, difficulty);
    const worst = Math.min(...playerResponses.map(r => evaluateEnemy(simulatePlayer(afterEnemy, r))));
    if (!best || worst > best.value) best = { candidate, value: worst };
  }
  return best.candidate; // committed as Intent before the player turn
}
```
