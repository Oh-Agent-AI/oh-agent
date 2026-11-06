/** Pure model leaf registry. Adding a model changes registration data, not the ground inspector. */
import type { PhysicalDeclaration } from "./physical";
import { resolveVillaGroundPhysical } from "./villaGeometry";

export type GroundModelInput = { readonly seed: number; readonly radius: number };
export type GroundModelResolution =
  | { readonly status: "partial"; readonly declaration: PhysicalDeclaration; readonly missing: readonly string[];
      readonly relocationCorridorEnvelope?: { readonly schemaVersion: 1; readonly coverage: "complete-conservative-renderer-xy"; readonly revision: string } }
  | { readonly status: "unsupported"; readonly reason: string };
export type GroundModelFactory = (input: GroundModelInput) => GroundModelResolution;

/** This table intentionally does not claim coverage of all fifteen planning models. */
export const GROUND_MODEL_FACTORIES: Record<string, GroundModelFactory> = {
  "villa-complex": input => {
    const resolution = resolveVillaGroundPhysical(input);
    return resolution.status === "unsupported" ? resolution : { ...resolution,
      relocationCorridorEnvelope: { schemaVersion: 1, coverage: "complete-conservative-renderer-xy", revision: "villa-renderer-xy-1" } };
  },
};
export function resolveGroundModel(modelId: string, input: GroundModelInput): GroundModelResolution {
  if (!Object.hasOwn(GROUND_MODEL_FACTORIES, modelId)) return { status: "unsupported", reason: `ground declaration not registered: ${modelId}` };
  if (!Number.isFinite(input.seed) || !Number.isFinite(input.radius) || input.radius <= 0)
    return { status: "unsupported", reason: "invalid model ground parameters" };
  try { return GROUND_MODEL_FACTORIES[modelId](input); }
  catch (error) { return { status: "unsupported", reason: error instanceof Error ? error.message : "ground factory failed" }; }
}
