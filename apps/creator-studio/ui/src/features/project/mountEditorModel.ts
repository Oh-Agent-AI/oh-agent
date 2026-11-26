import { listAnchors, validateMiniGamePack, type CityLayoutV1 } from "@oh-agent/city-sdk";

export function mountChoices(layout: CityLayoutV1 | undefined, savedGame: unknown) {
  if (!layout) return { entries: [], slots: [] };
  const game = validateMiniGamePack(savedGame);
  if (!game.ok) return { entries: listAnchors(layout, { kind: "spawn" }), slots: [] };
  const slots = Object.entries(game.value.slots);
  const requires = [...new Set(slots.flatMap(([, slot]) => slot.requires ?? []))];
  return {
    entries: listAnchors(layout, { kind: "spawn", requires }),
    slots: slots.map(([id, slot]) => ({
      id, min: slot.min, max: slot.max, anchors: listAnchors(layout, { kind: slot.kind, requires: slot.requires }),
    })),
  };
}

export const mountSlotLabel = (id: string) => id === "points" ? "检查点" : id === "targets" ? "收集目标" : id === "gates" ? "空中检查点" : id;

export function readMountBindings(value: string): Record<string, unknown> | null {
  try {
    const bindings: unknown = JSON.parse(value);
    return bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
