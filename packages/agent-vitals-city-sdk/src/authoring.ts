import type {
  CityWorldSnapshotV4, CompileContextV1, StableIdV1, WorldCompilerV1, WorldPlanV1,
} from "./contracts";
import { sha256Text } from "./digest";
import type { DiagnosticV1, Result } from "./types";
import {
  computeCityWorldDigests, validateCityWorldSnapshot, validateCompileContext, validateWorldPlan,
} from "./sharedValidate";

export type {
  CityWorldSnapshotV4, CompileContextV1, RoutePlanV1, WorldCompilerV1, WorldPlanV1,
} from "./contracts";

const EMPTY_DIGEST = `sha256:${"0".repeat(64)}`;

export class CityWorldCompileError extends Error {
  readonly diagnostics: readonly DiagnosticV1[];
  constructor(diagnostics: readonly DiagnosticV1[]) {
    super(diagnostics[0]?.message ?? "City world compilation failed.");
    this.name = "CityWorldCompileError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export function stableIdV1(namespace: string, semanticKey: string): StableIdV1 {
  if (!/^[a-z][a-z0-9]*$/.test(namespace) || namespace.length > 112) throw new TypeError("Stable ID namespace must match [a-z][a-z0-9]* and leave room for a semantic key.");
  if (typeof semanticKey !== "string" || semanticKey.length === 0 || semanticKey.length > 4_096) {
    throw new TypeError("Stable ID semantic key must be a non-empty bounded string.");
  }
  let key = semanticKey.normalize("NFKD").toLowerCase()
    .replace(/[\u0300-\u036f]+/g, "").replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "").replace(/-{2,}/g, "-");
  if (!key || !/^[a-z0-9]/.test(key)) throw new TypeError("Stable ID semantic key has no portable alphanumeric identity.");
  const maximumKeyLength = 128 - namespace.length - 1;
  if (key.length > maximumKeyLength) {
    const suffix = sha256Text(semanticKey).slice("sha256:".length, "sha256:".length + 12);
    key = `${key.slice(0, maximumKeyLength - 14).replace(/[._-]+$/g, "")}.${suffix}`;
  }
  return `${namespace}:${key}`;
}

export const createStableIdV1 = stableIdV1;

export function defineWorldPlan<T extends WorldPlanV1>(plan: T): T {
  return plan;
}

export interface CityWorldGeneratorContextV1 extends CompileContextV1 {
  readonly random: () => number;
}
export interface CityWorldGeneratorDefinitionV1 {
  readonly id: string;
  readonly contractVersion: 1;
  readonly version?: string;
  generate(context: CityWorldGeneratorContextV1): WorldPlanV1;
}
export type CityWorldGeneratorV1 =
  | ((context: CityWorldGeneratorContextV1) => WorldPlanV1)
  | CityWorldGeneratorDefinitionV1
  | Readonly<{ generate(context: CityWorldGeneratorContextV1): WorldPlanV1 }>;

export function defineWorldGenerator<T extends CityWorldGeneratorDefinitionV1>(generator: T): T {
  return generator;
}

export function defineCityWorld<T extends CityWorldGeneratorV1>(generator: T): T {
  return generator;
}

export function createWorldGeneratorContext(context: CompileContextV1): CityWorldGeneratorContextV1 {
  return Object.freeze({ ...context, random: createSeededRandomV1(context.seed) });
}

export function createSeededRandomV1(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new TypeError("Seed must be an unsigned 32-bit integer.");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function compileWorld(plan: WorldPlanV1, context: CompileContextV1): CityWorldSnapshotV4 {
  const checkedPlan = validateWorldPlan(plan);
  const checkedContext = validateCompileContext(context);
  const diagnostics = [...(checkedPlan.ok ? [] : checkedPlan.diagnostics), ...(checkedContext.ok ? [] : checkedContext.diagnostics)];
  if (!checkedPlan.ok || !checkedContext.ok) throw new CityWorldCompileError(diagnostics);
  const normalized = checkedPlan.value;
  const roads = normalized.routes.map(route => ({
    id: route.id, kind: route.kind, fromAnchorId: route.fromAnchorId, toAnchorId: route.toAnchorId,
    directed: !route.bidirectional, travelModes: route.travelModes, centerline: route.centerline,
  }));
  const draft: CityWorldSnapshotV4 = {
    schemaVersion: 4,
    header: {
      schemaVersion: 1, cityId: checkedContext.value.cityId, cityRevision: checkedContext.value.cityRevision,
      seed: checkedContext.value.seed, generator: checkedContext.value.generator, coordinateSystem: "city-local-m-v1",
      capabilities: checkedContext.value.capabilities,
      revisions: {
        worldRevision: EMPTY_DIGEST, environmentRevision: EMPTY_DIGEST, weatherRevision: EMPTY_DIGEST,
        placeRevision: EMPTY_DIGEST, residentRevision: EMPTY_DIGEST, interactionRevision: EMPTY_DIGEST,
        appearanceRevision: EMPTY_DIGEST, renderRevision: EMPTY_DIGEST, clockRevision: EMPTY_DIGEST,
      },
      topologyDigest: EMPTY_DIGEST, snapshotDigest: EMPTY_DIGEST,
    },
    terrain: normalized.terrain,
    environment: normalized.environment ?? { medium: "air", biome: "unknown" },
    roads, sites: normalized.sites, objects: normalized.objects, anchors: normalized.anchors,
    volumes: normalized.volumes, places: normalized.places, residents: normalized.residents,
  };
  const digests = computeCityWorldDigests(draft);
  const snapshot: CityWorldSnapshotV4 = {
    ...draft,
    header: { ...draft.header, revisions: digests.revisions, topologyDigest: digests.topologyDigest, snapshotDigest: digests.snapshotDigest },
  };
  const checkedSnapshot = validateCityWorldSnapshot(snapshot);
  if (!checkedSnapshot.ok) throw new CityWorldCompileError(checkedSnapshot.diagnostics);
  return checkedSnapshot.value;
}

export const compileCityWorld = compileWorld;

export function compileWorldResult(plan: unknown, context: unknown): Result<CityWorldSnapshotV4> {
  const checkedPlan = validateWorldPlan(plan);
  const checkedContext = validateCompileContext(context);
  if (!checkedPlan.ok || !checkedContext.ok) return {
    ok: false,
    diagnostics: [...(checkedPlan.ok ? [] : checkedPlan.diagnostics), ...(checkedContext.ok ? [] : checkedContext.diagnostics)],
  };
  try {
    return { ok: true, value: compileWorld(checkedPlan.value, checkedContext.value), diagnostics: [] };
  } catch (cause) {
    if (cause instanceof CityWorldCompileError) return { ok: false, diagnostics: [...cause.diagnostics] };
    return { ok: false, diagnostics: [{ code: "city_compile_failed", severity: "error", path: "$", message: cause instanceof Error ? cause.message : "City world compilation failed." }] };
  }
}

export function createWorldCompiler(): WorldCompilerV1 {
  return Object.freeze({ compile: compileWorld });
}

export const WORLD_COMPILER_V1 = createWorldCompiler();
