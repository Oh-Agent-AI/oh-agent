/**
 * Pure world-parameter capability contract for City world diversification
 * (CITY_WORLD_DIVERSIFICATION_SDK_SPEC_2026_11_15 §2). Descriptors declare
 * bounded, seed-deterministic generator parameters; validation is data-driven
 * from the capability so adding a parameter never extends this module.
 *
 * Defaults are pinned to current generator behavior: a profile that omits
 * `diversity` must produce byte-identical worlds to the pre-catalog era, and
 * engine lockstep tests reject any default drift.
 */
import type { DiagnosticV1, Result } from "./types";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const GROUPS = new Set(["shape", "landform", "water", "vegetation", "skeleton", "landscape"]);
const KINDS = new Set(["number", "integer", "enum"]);
export const WORLD_PARAMETER_LIMITS = Object.freeze({
  maxParameters: 32,
  maxPresets: 16,
  maxEnumValues: 8,
  maxUnitLength: 16,
  maxLabelLength: 64,
});

export type WorldParameterGroupV1 = "shape" | "landform" | "water" | "vegetation" | "skeleton" | "landscape";
export type WorldParameterKindV1 = "number" | "integer" | "enum";

export type WorldParameterDescriptorV1 = Readonly<{
  group: WorldParameterGroupV1;
  /** Unique within the group; the capability key is `${group}.${id}`. */
  id: string;
  kind: WorldParameterKindV1;
  min?: number;
  max?: number;
  values?: readonly string[];
  default: number | string;
  unit?: string;
}>;

export type WorldPresetV1 = Readonly<{
  id: string;
  label: string;
  parameters: Readonly<Record<string, number | string>>;
}>;

export type WorldCapabilityV1 = Readonly<{
  generatorId: string;
  /** Parameter schema version; increment on schema evolution only. Defaults
   * pinned to shipped generator behavior never move within a version. */
  contractVersion: number;
  parameters: readonly WorldParameterDescriptorV1[];
  presets: readonly WorldPresetV1[];
}>;

const error = (code: string, path: string, message: string): DiagnosticV1 => ({ code, severity: "error", path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && IDENTIFIER.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Fully qualified capability key, e.g. `shape.family`. */
export type WorldParameterKeyV1 = string;

/** Validate a world capability catalog before it may be published or consumed.
 * This is contract self-validation; the generated capability projection (S3)
 * must re-run it so a stale projection fails closed. */
export function validateWorldCapabilityV1(input: unknown): Result<WorldCapabilityV1> {
  if (!object(input)) return { ok: false, diagnostics: [error("world_capability_invalid", "", "Capability must be an object.")] };
  if (!identifier(input.generatorId)) return { ok: false, diagnostics: [error("world_capability_invalid", "generatorId", "Generator id must be an identifier.")] };
  if (!Number.isSafeInteger(input.contractVersion) || (input.contractVersion as number) < 1) {
    return { ok: false, diagnostics: [error("world_capability_invalid", "contractVersion", "Contract version must be a positive integer.")] };
  }
  if (!Array.isArray(input.parameters) || input.parameters.length === 0 || input.parameters.length > WORLD_PARAMETER_LIMITS.maxParameters) {
    return { ok: false, diagnostics: [error("world_capability_invalid", "parameters", `Capability must declare 1..${WORLD_PARAMETER_LIMITS.maxParameters} parameters.`)] };
  }
  const seen = new Set<string>();
  const parameters: WorldParameterDescriptorV1[] = [];
  for (let index = 0; index < input.parameters.length; index += 1) {
    const path = `parameters[${index}]`;
    const check = validateParameterDescriptor(input.parameters[index], path);
    if (!check.ok) return check;
    const value = check.value;
    const key = `${value.group}.${value.id}`;
    if (seen.has(key)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.id`, `Duplicate capability key ${key}.`)] };
    seen.add(key);
    parameters.push(value);
  }
  if (!Array.isArray(input.presets) || input.presets.length > WORLD_PARAMETER_LIMITS.maxPresets) {
    return { ok: false, diagnostics: [error("world_capability_invalid", "presets", `Capability must declare 0..${WORLD_PARAMETER_LIMITS.maxPresets} presets.`)] };
  }
  const presetIds = new Set<string>();
  const presets: WorldPresetV1[] = [];
  for (let index = 0; index < input.presets.length; index += 1) {
    const path = `presets[${index}]`;
    const preset = input.presets[index];
    if (!object(preset) || !identifier(preset.id) || typeof preset.label !== "string" || preset.label.length === 0 || preset.label.length > WORLD_PARAMETER_LIMITS.maxLabelLength || !object(preset.parameters)) {
      return { ok: false, diagnostics: [error("world_capability_invalid", path, "Preset requires id, bounded label and a parameters object.")] };
    }
    if (presetIds.has(preset.id)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.id`, `Duplicate preset id ${preset.id}.`)] };
    presetIds.add(preset.id);
    const presetParameters: Record<string, number | string> = {};
    for (const key of Object.keys(preset.parameters)) {
      if (!seen.has(key)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.parameters.${key}`, "Preset references an unknown capability key.")] };
      const probe = validateWorldParametersV1({ generatorId: input.generatorId as string, contractVersion: input.contractVersion as number, parameters, presets: [] }, { [key]: preset.parameters[key] });
      if (!probe.ok) return { ok: false, diagnostics: probe.diagnostics.map(item => error(item.code, `${path}.parameters.${key}`, item.message)) };
      presetParameters[key] = probe.value[key];
    }
    presets.push(Object.freeze({ id: preset.id, label: preset.label, parameters: Object.freeze(presetParameters) }));
  }
  return { ok: true, diagnostics: [], value: Object.freeze({ generatorId: input.generatorId as string, contractVersion: input.contractVersion as number, parameters: Object.freeze(parameters), presets: Object.freeze(presets) }) };
}

function validateParameterDescriptor(input: unknown, path: string): Result<WorldParameterDescriptorV1> {
  if (!object(input)) return { ok: false, diagnostics: [error("world_capability_invalid", path, "Parameter descriptor must be an object.")] };
  if (typeof input.group !== "string" || !GROUPS.has(input.group)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.group`, `Group must be one of ${[...GROUPS].join("/")}.`)] };
  if (!identifier(input.id)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.id`, "Parameter id must be an identifier.")] };
  if (typeof input.kind !== "string" || !KINDS.has(input.kind)) return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.kind`, "Kind must be number, integer or enum.")] };
  const kind = input.kind as WorldParameterKindV1;
  if (input.unit !== undefined && (typeof input.unit !== "string" || input.unit.length > WORLD_PARAMETER_LIMITS.maxUnitLength)) {
    return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.unit`, "Unit must be a short string.")] };
  }
  if (kind === "enum") {
    if (!Array.isArray(input.values) || input.values.length === 0 || input.values.length > WORLD_PARAMETER_LIMITS.maxEnumValues
      || input.values.some(item => typeof item !== "string" || !identifier(item))) {
      return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.values`, "Enum parameters need 1..8 identifier values.")] };
    }
    if (typeof input.default !== "string" || !(input.values as readonly string[]).includes(input.default)) {
      return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.default`, "Enum default must be one of the declared values.")] };
    }
    return { ok: true, diagnostics: [], value: Object.freeze({ group: input.group as WorldParameterGroupV1, id: input.id as string, kind, values: Object.freeze([...input.values as readonly string[]]), default: input.default as string, unit: input.unit as string | undefined }) };
  }
  if (!finite(input.min) || !finite(input.max) || (input.min as number) >= (input.max as number)) {
    return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.min`, "Numeric parameters need min < max.")] };
  }
  const min = input.min as number, max = input.max as number;
  if (kind === "integer") {
    if (!Number.isSafeInteger(input.default) || (input.default as number) < min || (input.default as number) > max) {
      return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.default`, "Integer default must be a safe integer inside the range.")] };
    }
    return { ok: true, diagnostics: [], value: Object.freeze({ group: input.group as WorldParameterGroupV1, id: input.id as string, kind, min, max, default: input.default as number, unit: input.unit as string | undefined }) };
  }
  if (!finite(input.default) || (input.default as number) < min || (input.default as number) > max) {
    return { ok: false, diagnostics: [error("world_capability_invalid", `${path}.default`, "Number default must be finite and inside the range.")] };
  }
  return { ok: true, diagnostics: [], value: Object.freeze({ group: input.group as WorldParameterGroupV1, id: input.id as string, kind, min, max, default: input.default as number, unit: input.unit as string | undefined }) };
}

const parameterByKey = (capability: WorldCapabilityV1): Map<string, WorldParameterDescriptorV1> => {
  const map = new Map<string, WorldParameterDescriptorV1>();
  for (const descriptor of capability.parameters) map.set(`${descriptor.group}.${descriptor.id}`, descriptor);
  return map;
};

/** Strictly validate a partial parameter set against a capability and return
 * the complete record (input merged over declared defaults), frozen. Unknown
 * keys, wrong kinds, out-of-range values and oversized sets fail closed with
 * the spec's stable error codes. */
export function validateWorldParametersV1(capability: WorldCapabilityV1, input: unknown): Result<Readonly<Record<WorldParameterKeyV1, number | string>>> {
  if (!object(capability)) return { ok: false, diagnostics: [error("world_params_invalid", "", "Capability must be an object.")] };
  if (!object(input)) return { ok: false, diagnostics: [error("world_params_invalid", "", "Parameters must be an object.")] };
  const keys = Object.keys(input);
  if (keys.length > WORLD_PARAMETER_LIMITS.maxParameters) {
    return { ok: false, diagnostics: [error("world_params_budget_exceeded", "", `At most ${WORLD_PARAMETER_LIMITS.maxParameters} parameters per set.`)] };
  }
  const byKey = parameterByKey(capability);
  const merged: Record<string, number | string> = {};
  for (const descriptor of capability.parameters) merged[`${descriptor.group}.${descriptor.id}`] = descriptor.default;
  for (const key of keys) {
    const descriptor = byKey.get(key);
    if (!descriptor) return { ok: false, diagnostics: [error("world_params_unknown", key, "Unknown world parameter for this generator.")] };
    const value = input[key];
    if (descriptor.kind === "enum") {
      if (typeof value !== "string" || !descriptor.values?.includes(value)) {
        return { ok: false, diagnostics: [error("world_params_out_of_range", key, `Value must be one of ${(descriptor.values ?? []).join("/")}.`)] };
      }
    } else if (!finite(value)) {
      return { ok: false, diagnostics: [error("world_params_invalid", key, "Value must be a finite number.")] };
    } else if (descriptor.kind === "integer" ? !Number.isSafeInteger(value) : false) {
      return { ok: false, diagnostics: [error("world_params_invalid", key, "Value must be a safe integer.")] };
    } else if (value < (descriptor.min as number) || value > (descriptor.max as number)) {
      return { ok: false, diagnostics: [error("world_params_out_of_range", key, `Value must be within ${descriptor.min}..${descriptor.max}.`)] };
    }
    merged[key] = value as number | string;
  }
  return { ok: true, diagnostics: [], value: Object.freeze(merged) };
}

/** Expand a named preset over declared defaults. Unknown preset ids fail with
 * `world_preset_unknown` so agents cannot guess preset names. */
export function resolveWorldPresetV1(capability: WorldCapabilityV1, presetId: string): Result<Readonly<Record<WorldParameterKeyV1, number | string>>> {
  const preset = capability.presets.find(item => item.id === presetId);
  if (!preset) return { ok: false, diagnostics: [error("world_preset_unknown", "presetId", `Unknown preset ${presetId}.`)] };
  return validateWorldParametersV1(capability, { ...preset.parameters });
}

/** Registered arid-dunes capability (contract v2 = catalog era; the implicit
 * pre-catalog contract is v1). Legacy dune fields keep their profile shape
 * (`parameters.dunes`); defaults are the shipped template baseline. */
export const ARID_DUNES_WORLD_V2: WorldCapabilityV1 = Object.freeze({
  generatorId: "arid-dunes-v1",
  contractVersion: 2,
  parameters: Object.freeze([
    Object.freeze({ group: "landform", id: "duneScale", kind: "number", min: 96, max: 600, default: 190, unit: "m" }),
    Object.freeze({ group: "landform", id: "duneAmplitude", kind: "number", min: 1, max: 36, default: 11, unit: "m" }),
    Object.freeze({ group: "landform", id: "orientationDeg", kind: "number", min: -180, max: 180, default: 18, unit: "deg" }),
    Object.freeze({ group: "shape", id: "family", kind: "enum", values: ["disc", "lobed", "dumbbell", "coastal"], default: "disc" }),
    Object.freeze({ group: "shape", id: "cores", kind: "integer", min: 1, max: 3, default: 1 }),
    Object.freeze({ group: "shape", id: "aspectRatio", kind: "number", min: 1.0, max: 1.8, default: 1.0 }),
    Object.freeze({ group: "shape", id: "corridorPull", kind: "number", min: 0, max: 0.4, default: 0 }),
    Object.freeze({ group: "shape", id: "coastFractal", kind: "number", min: 0, max: 0.25, default: 0.035 }),
    Object.freeze({ group: "shape", id: "radiusClass", kind: "enum", values: ["small", "medium", "large"], default: "medium" }),
    Object.freeze({ group: "landform", id: "duneFrequency", kind: "number", min: 0.5, max: 2.0, default: 1.0 }),
    Object.freeze({ group: "landform", id: "ridgeSecondary", kind: "number", min: 0, max: 1, default: 0 }),
    Object.freeze({ group: "water", id: "oasisCount", kind: "integer", min: 0, max: 3, default: 0 }),
    Object.freeze({ group: "water", id: "lakeCount", kind: "integer", min: 0, max: 3, default: 0 }),
    Object.freeze({ group: "water", id: "lakeSizeM", kind: "number", min: 40, max: 400, default: 120, unit: "m" }),
    Object.freeze({ group: "vegetation", id: "greenbeltWidth", kind: "number", min: 0, max: 80, default: 0, unit: "m" }),
    Object.freeze({ group: "vegetation", id: "forestPatchiness", kind: "number", min: 0, max: 1, default: 0 }),
    Object.freeze({ group: "landscape", id: "rockOutcropDensity", kind: "number", min: 0, max: 1, default: 0 }),
    Object.freeze({ group: "landscape", id: "riverMeander", kind: "number", min: 0, max: 1, default: 0 }),
    Object.freeze({ group: "landscape", id: "riverWidthM", kind: "number", min: 10, max: 60, default: 40, unit: "m" }),
    Object.freeze({ group: "landscape", id: "ridgeCount", kind: "integer", min: 0, max: 3, default: 0 }),
    Object.freeze({ group: "landscape", id: "ridgeHeightM", kind: "number", min: 20, max: 120, default: 60, unit: "m" }),
    Object.freeze({ group: "skeleton", id: "ringCount", kind: "integer", min: 1, max: 3, default: 2 }),
  ]),
  presets: Object.freeze([
    Object.freeze({ id: "disc", label: "圆盘沙海（现行默认）", parameters: Object.freeze({}) }),
    Object.freeze({ id: "lobed", label: "多瓣沙海", parameters: Object.freeze({ "shape.family": "lobed", "shape.cores": 3 }) }),
    Object.freeze({ id: "dumbbell", label: "双核哑铃", parameters: Object.freeze({ "shape.family": "dumbbell", "shape.cores": 2, "shape.corridorPull": 0.2 }) }),
    Object.freeze({ id: "coastal", label: "沙海岸线", parameters: Object.freeze({ "shape.family": "coastal", "shape.coastFractal": 0.18 }) }),
  ]),
});

/** Geography profile identity carried inside the coastal parameter record
 * (`parameters.coastal.profile`); declared here so types/validate/City engine
 * derive it instead of restating the literal. */
export const COASTAL_PROFILE_ID_V1 = "miami-coastal";

/** Registered coastal-islands capability: first batch only unfreezes the
 * already-implemented bay options; the remaining frozen MIAMI_COASTAL fields
 * join the catalog when the generator consumes them. */
export const COASTAL_ISLANDS_WORLD_V1: WorldCapabilityV1 = Object.freeze({
  generatorId: "coastal-islands-v1",
  contractVersion: 1,
  parameters: Object.freeze([
    Object.freeze({ group: "shape", id: "bayHalfWidth", kind: "number", min: 0.1, max: 0.5, default: 0.22 }),
    Object.freeze({ group: "shape", id: "bayShift", kind: "number", min: -0.5, max: 0.5, default: 0.33 }),
  ]),
  presets: Object.freeze([
    Object.freeze({ id: "vice-bay", label: "Vice City 海湾（现行默认）", parameters: Object.freeze({}) }),
  ]),
});

/** Capability keys whose values already exist in the legacy profile parameter
 * object (`parameters.dunes`); the diversity record must not restate them. */
export const ARID_DUNES_LEGACY_KEYS: readonly string[] = Object.freeze(["landform.duneScale", "landform.duneAmplitude", "landform.orientationDeg"]);
