import { validateGameTypeDescriptorV1, type GameTypeDescriptorV1 } from "@agent-vitals/city-sdk";
import { GameRuntimeError } from "./errors";
import type { GameRuntimeV1, RegisteredGameRuntimeV1 } from "./types";

/** Pure registry: descriptor semantics are validated by city-sdk exactly once;
 * implementations remain trusted app code. */
export class GameRuntimeRegistryV1 {
  private readonly entries = new Map<string, RegisteredGameRuntimeV1>();

  register(descriptor: unknown, runtime: GameRuntimeV1): GameTypeDescriptorV1 {
    const checked = validateGameTypeDescriptorV1(descriptor);
    if (!checked.ok) throw new GameRuntimeError("game_type_invalid", checked.diagnostics.map(item => item.message).join(" "));
    const value = checked.value;
    if (!runtime || typeof runtime.prepare !== "function" || runtime.type !== value.runtime.id || runtime.contractVersion !== value.runtime.contractVersion) {
      throw new GameRuntimeError("game_runtime_invalid", `Runtime must implement ${value.runtime.id} contract version ${value.runtime.contractVersion}.`);
    }
    if (this.entries.has(value.id)) throw new GameRuntimeError("game_type_duplicate", `Game type ${value.id} is already registered.`);
    this.entries.set(value.id, Object.freeze({ descriptor: value, runtime }));
    return value;
  }

  resolve(typeId: string, contractVersion: number): GameRuntimeV1 {
    const entry = this.entries.get(typeId);
    if (!entry) throw new GameRuntimeError("game_type_unknown", `Game type ${typeId} is not installed.`);
    if (entry.descriptor.runtime.contractVersion !== contractVersion) {
      throw new GameRuntimeError("game_type_version_mismatch", `Game type ${typeId} requires contract version ${entry.descriptor.runtime.contractVersion}, got ${contractVersion}.`);
    }
    return entry.runtime;
  }

  descriptors(): readonly GameTypeDescriptorV1[] {
    return Object.freeze([...this.entries.values()].map(entry => entry.descriptor));
  }
}

export function createGameRuntimeRegistry(): GameRuntimeRegistryV1 { return new GameRuntimeRegistryV1(); }
