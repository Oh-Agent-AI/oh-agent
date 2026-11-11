import { compileRules, createRun, parseMiniGamePackJson, validateMount, type CityGameMountV1, type CityLayoutV1, type ContentRef, type MiniGamePackV1, type RuleRunV1, type RuleStateV1, type Result, type DiagnosticV1 } from "@agent-vitals/city-sdk";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";

export type MountedMiniGamePlanV1 = Readonly<{
  layout: CityLayoutV1;
  game: MiniGamePackV1;
  mount: CityGameMountV1;
  seed: number;
  zones: Readonly<Record<string, readonly Readonly<{ x: number; y: number; z: number; radius: number }>[]>>;
}>;
export type MountedMiniGameSnapshotV1 = Readonly<{ status: "ready" | "running" | "success" | "failure" | "error"; state: RuleStateV1; reason: string | null }>;

const diagnostic = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 => ({
  code, severity: "error", path, ...(objectId ? { objectId } : {}), message,
});

/** Loads declarative JSON content through the same validation path used by SDK tools. */
export function createMountedMiniGamePlan(input: Readonly<{ view: CityLayoutSdkViewV1; packageJson: string; mount: CityGameMountV1; gameRef: ContentRef<"city-minigame">; seed: number }>): Result<MountedMiniGamePlanV1> {
  if (!input.view.layout.links) return { ok: false, diagnostics: [diagnostic("layout_topology_unavailable", "layout.links", "The trusted City adapter did not provide traversal links for mounted-game validation.")] };
  const parsed = parseMiniGamePackJson(input.packageJson);
  if (!parsed.ok) return parsed;
  const compiled = compileRules(parsed.value);
  if (!compiled.ok) return compiled;
  const mounted = validateMount({ layout: input.view.layout, game: parsed.value, mount: input.mount,
    resolvedRefs: {
      layout: { kind: "city-layout", id: input.view.layout.id, version: "1", digest: input.view.worldRevision },
      game: input.gameRef,
    } });
  if (!mounted.ok) return mounted;
  const entryAnchor = input.view.layout.anchors.find(anchor => anchor.id === mounted.value.mount.entryAnchorId);
  if (!entryAnchor || !input.view.geometry.has(entryAnchor.geometryRef)) {
    return { ok: false, diagnostics: [diagnostic("entry_geometry_unavailable", "mount.entryAnchorId", "The City adapter cannot resolve trusted geometry for the game entry.", mounted.value.mount.entryAnchorId)] };
  }
  if (!entryAnchor.capabilities.includes("drive")) {
    return { ok: false, diagnostics: [diagnostic("entry_capability_unsupported", "mount.entryAnchorId", "The current City mini-game runtime requires a drive-capable entry.", entryAnchor.id)] };
  }
  const zones: Record<string, Readonly<{ x: number; y: number; z: number; radius: number }>[]> = {};
  for (const [slotName, slot] of Object.entries(parsed.value.slots)) {
    if (slot.kind !== "zone") continue;
    const geometries = (mounted.value.mount.bindings[slotName] ?? []).map(anchorId => {
      const anchor = input.view.layout.anchors.find(item => item.id === anchorId);
      const geometry = anchor ? input.view.geometry.get(anchor.geometryRef) : null;
      return geometry?.activationRadiusMeters === undefined ? null : { x: geometry.positionMeters.x, y: geometry.positionMeters.y, z: geometry.positionMeters.z, radius: geometry.activationRadiusMeters };
    });
    if (geometries.some(item => item === null)) return { ok: false, diagnostics: [diagnostic("zone_geometry_unavailable", `mount.bindings.${slotName}`, "A bound zone does not have a trusted activation radius.")] };
    zones[slotName] = geometries as NonNullable<(typeof geometries)[number]>[];
  }
  if (Object.values(zones).reduce((total, entries) => total + entries.length, 0) > 64) return { ok: false, diagnostics: [diagnostic("content_budget_exceeded", "mount.bindings", "A mounted game may bind at most 64 trigger zones.")] };
  return { ok: true, value: Object.freeze({ layout: input.view.layout, game: parsed.value, mount: mounted.value.mount, seed: input.seed, zones: Object.freeze(zones) }), diagnostics: [] };
}

function segmentIntersectsZone(a: Readonly<{ x: number; y: number; z: number }>, b: Readonly<{ x: number; y: number; z: number }>, zone: Readonly<{ x: number; y: number; z: number; radius: number }>): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((zone.x - a.x) * dx + (zone.y - a.y) * dy + (zone.z - a.z) * dz) / lengthSquared));
  return Math.hypot(a.x + t * dx - zone.x, a.y + t * dy - zone.y, a.z + t * dz - zone.z) <= zone.radius;
}
function pointInsideZone(point: Readonly<{ x: number; y: number; z: number }>, zone: Readonly<{ x: number; y: number; z: number; radius: number }>): boolean {
  return Math.hypot(point.x - zone.x, point.y - zone.y, point.z - zone.z) <= zone.radius;
}

/** Shared fixed-step trigger and rule host for every declarative City mini-game. */
export class MountedMiniGameControllerV1 {
  private readonly run: RuleRunV1;
  private tick = 0;
  private previous: Readonly<{ x: number; y: number; z: number }> | null = null;
  private readonly triggeredZones = new Set<string>();
  private stopped = false;
  private snapshotValue: MountedMiniGameSnapshotV1;

  constructor(private readonly plan: MountedMiniGamePlanV1, private readonly onChange: (snapshot: MountedMiniGameSnapshotV1) => void) {
    const compiled = compileRules(plan.game);
    if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.code ?? "mini-game-rules-invalid");
    this.run = createRun({ rules: compiled.value, mount: plan.mount, seed: plan.seed });
    this.snapshotValue = Object.freeze({ status: "ready", state: this.run.snapshot(), reason: null });
  }

  get snapshot(): MountedMiniGameSnapshotV1 { return this.snapshotValue; }

  fixedStep(positionMeters: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.stopped || this.snapshotValue.status === "success" || this.snapshotValue.status === "failure" || this.snapshotValue.status === "error") return;
    const inputs: Array<{ type: "zone.entered"; tick: number; slot: string; index: number }> = [];
    if (this.previous) for (const [slot, zones] of Object.entries(this.plan.zones)) {
      for (let index = 0; index < zones.length; index += 1) {
        const zone = zones[index]!;
        const key = `${slot}:${index}`;
        if (this.triggeredZones.has(key)) {
          if (Math.hypot(positionMeters.x - zone.x, positionMeters.y - zone.y, positionMeters.z - zone.z) > zone.radius * 1.25) this.triggeredZones.delete(key);
          continue;
        }
        if (!pointInsideZone(this.previous, zone) && segmentIntersectsZone(this.previous, positionMeters, zone)) {
          inputs.push({ type: "zone.entered", tick: this.tick, slot, index });
          this.triggeredZones.add(key);
        }
      }
    }
    const stepped = this.run.step(this.tick, inputs);
    if (!stepped.ok) { this.publish({ status: "error", state: this.run.snapshot(), reason: stepped.diagnostics[0]?.code ?? "mini-game-step-failed" }); return; }
    this.tick += 1;
    this.previous = { ...positionMeters };
    this.publish({ status: stepped.value.state.outcome ?? "running", state: stepped.value.state, reason: null });
  }

  stop(): void { if (!this.stopped) { this.stopped = true; this.run.stop(); } }

  private publish(value: MountedMiniGameSnapshotV1): void {
    if (this.snapshotValue.status === value.status && this.snapshotValue.state.tick === value.state.tick && this.snapshotValue.state.outcome === value.state.outcome) return;
    this.snapshotValue = Object.freeze(value);
    this.onChange(this.snapshotValue);
  }
}
