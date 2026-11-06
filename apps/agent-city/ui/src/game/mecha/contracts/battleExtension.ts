/** Versioned extension boundary; not yet wired into replay or remote protocols. */
export const BATTLE_EXTENSION_CONTRACT = "battle-extension:v1" as const;
export type BattleRandomState = Readonly<{ algorithm: "xorshift32:v1"; state: number }>;
export type BattleExtensionState<S> = Readonly<{
  contract: typeof BATTLE_EXTENSION_CONTRACT; ruleset: string; contentId: string;
  contentVersion: number; revision: number; random: BattleRandomState; data: S;
}>;
export type BattleEvent<E> = Readonly<{ contract: typeof BATTLE_EXTENSION_CONTRACT; revision: number; sequence: number; data: E }>;
export type BattleTransition<S, C, E> = (state: BattleExtensionState<S>, command: C) => Readonly<{
  state: BattleExtensionState<S>; events: readonly BattleEvent<E>[];
}>;
/** Explicit state allows a random sequence to be saved and resumed. */
export function battleRandom(seed: number): BattleRandomState {
  if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff) throw new RangeError("invalid battle random seed");
  return { algorithm: "xorshift32:v1", state: seed };
}
export function nextBattleRandom(random: BattleRandomState): Readonly<{ value: number; random: BattleRandomState }> {
  if (random.algorithm !== "xorshift32:v1") throw new RangeError("unsupported battle random algorithm");
  let x = battleRandom(random.state).state;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  const state = x >>> 0;
  return { value: state, random: { algorithm: "xorshift32:v1", state } };
}
