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

/** PR13 §7 绑定诊断（画布可读、语义化）：槽位名/点位引用可读，绝不出裸能力键 JSON 或坐标。
 *  锚点 id 只作为 targetId 引用出现——用户在画布上点它，不是读参数。 */
export interface MountSlotDiagnostic {
  slot: string;
  severity: "error";
  code: "slot_unfillable" | "slot_underfilled" | "binding_target_missing" | "binding_capability_unmet";
  targetId?: string;
  message: string;
}

/** 对当前布局 + 已选绑定做逐槽语义复检（宿主 binding.review 同一分类，本地即时反馈）。
 *  bindings 为 null（JSON 未填/未合法）时按「尚未选点」复检候选可用性，保留选点前的提示。 */
export function mountSlotDiagnostics(
  layout: CityLayoutV1 | undefined,
  savedGame: unknown,
  bindings: Record<string, unknown> | null,
): MountSlotDiagnostic[] {
  if (!layout) return [];
  const game = validateMiniGamePack(savedGame);
  if (!game.ok) return [];
  const byId = new Map(layout.anchors.map(anchor => [anchor.id, anchor]));
  const bound = bindings ?? {};
  const diagnostics: MountSlotDiagnostic[] = [];
  for (const [id, slot] of Object.entries(game.value.slots)) {
    const label = mountSlotLabel(id);
    const requires = slot.requires ?? [];
    const capabilityText = requires.length ? `支持 ${requires.join("、")}` : "任意能力";
    const candidates = listAnchors(layout, { kind: slot.kind, requires });
    const selected = Array.isArray(bound[id])
      ? (bound[id] as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    if (candidates.length === 0) {
      diagnostics.push({ slot: id, severity: "error", code: "slot_unfillable",
        message: `“${label}”在这个城市场景里没有可用点位：没有${slot.kind === "zone" ? "区域" : slot.kind === "route" ? "路线" : "对象"}类且${capabilityText}的锚点（0 个候选）。请在 City 画布上补充锚点或换一座 City。` });
      continue;
    }
    for (const target of selected) {
      if (!byId.has(target)) {
        diagnostics.push({ slot: id, severity: "error", code: "binding_target_missing", targetId: target,
          message: `“${label}”已绑定的点位 ${target} 在当前场景里已不存在，请在地图上重新选点。` });
        continue;
      }
      const anchor = byId.get(target)!;
      const lost = requires.filter(capability => !(anchor.capabilities ?? []).includes(capability));
      if (lost.length) {
        diagnostics.push({ slot: id, severity: "error", code: "binding_capability_unmet", targetId: target,
          message: `“${label}”绑定的点位 ${target} 不再满足所需能力（缺 ${lost.join("、")}），请在地图上换成满足条件的点位。` });
      }
    }
    const usable = selected.filter(target => {
      const anchor = byId.get(target);
      return anchor && requires.every(capability => (anchor.capabilities ?? []).includes(capability));
    });
    if (usable.length < slot.min) {
      diagnostics.push({ slot: id, severity: "error", code: "slot_underfilled",
        message: `“${label}”在当前场景里只有 ${usable.length} 个可用点位，少于所需的 ${slot.min} 个。` });
    }
  }
  return diagnostics;
}
