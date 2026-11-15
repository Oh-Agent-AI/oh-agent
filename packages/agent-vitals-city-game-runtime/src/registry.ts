import { CREATOR_TEMPLATES_V1, validateGameTypeDescriptorV1, type GameTypeDescriptorV1 } from "@agent-vitals/city-sdk";
import { GameRuntimeError } from "./errors";
import { BUILTIN_ACTIVITY_TEMPLATE_IDS } from "./builtin";
import type { GameRuntimeV1, RegisteredGameRuntimeV1 } from "./types";

const CREATOR_TEMPLATE_IDS = new Set(CREATOR_TEMPLATES_V1.map(template => template.id));
const BUILTIN_TEMPLATE_IDS = new Set<string>(Object.values(BUILTIN_ACTIVITY_TEMPLATE_IDS));

/** `template` must resolve to the catalog named by `templateCatalog`. A planned
 * template is deliberately unregistrable until its Creator template lands. */
export function validateTemplateLink(descriptor: GameTypeDescriptorV1): string | null {
  if (descriptor.templateCatalog === "planned") return `Game type ${descriptor.id} uses a planned template and cannot be registered yet.`;
  if (descriptor.templateCatalog === "creator") {
    return CREATOR_TEMPLATE_IDS.has(descriptor.template) ? null : `Creator template ${descriptor.template} is not in CREATOR_TEMPLATES_V1.`;
  }
  return BUILTIN_TEMPLATE_IDS.has(descriptor.template) ? null : `Built-in template ${descriptor.template} is not in BUILTIN_ACTIVITY_TEMPLATE_IDS.`;
}

/** Pure registry: descriptor semantics are validated by city-sdk exactly once;
 * implementations remain trusted app code. */
export class GameRuntimeRegistryV1 {
  private readonly entries = new Map<string, RegisteredGameRuntimeV1>();

  register(descriptor: unknown, runtime: GameRuntimeV1): GameTypeDescriptorV1 {
    const checked = validateGameTypeDescriptorV1(descriptor);
    if (!checked.ok) throw new GameRuntimeError("game_type_invalid", checked.diagnostics.map(item => item.message).join(" "));
    const value = checked.value;
    const templateError = validateTemplateLink(value);
    if (templateError) throw new GameRuntimeError("game_type_template_mismatch", templateError);
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
