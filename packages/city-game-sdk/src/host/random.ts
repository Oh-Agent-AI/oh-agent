import type { RandomAPIV1 } from "../api/types";
import { GameSdkError } from "../protocol/errors";

/**
 * mulberry32. Chosen because it is tiny, integer-only (Math.imul + shifts) and
 * therefore produces the same stream on every JS engine — a PRNG that differed
 * between the City WebView and the headless harness would break AC-04 replay.
 */
export class SeededRandomV1 implements RandomAPIV1 {
  private state: number;

  constructor(seed: number) {
    this.state = normalizeSeed(seed);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxExclusive: number): number {
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxExclusive) ||
      maxExclusive <= minInclusive ||
      maxExclusive - minInclusive > 0xffffffff
    ) {
      throw new GameSdkError(
        "game_argument_invalid",
        "random.int(min, max) requires safe integers with 0 < max - min <= 2^32.",
      );
    }
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}

export function normalizeSeed(seed: number): number {
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    throw new GameSdkError("game_argument_invalid", "seed must be a finite number.");
  }
  return Math.trunc(seed) >>> 0;
}
