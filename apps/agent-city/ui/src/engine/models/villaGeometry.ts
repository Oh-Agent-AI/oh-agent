/** Shared renderer dimensions. Plot radius is not a scale of the legacy fixed-size mesh. */
import { declarePhysical, type LocalFootprint, type PhysicalDeclaration } from "./physical";
export const VILLA_SITE_RADIUS = 34;
export const VILLA_GEOMETRY_REVISION = "U1-ground-1";

export function villaSeedStream(seed: number, salt: number): number {
  if (!Number.isFinite(seed) || !Number.isSafeInteger(salt)) throw new RangeError("invalid villa seed/stream");
  const n = Math.abs(seed), frac = n - Math.floor(n);
  const base = ((Math.floor(n) % 0x1_0000_0000) ^ Math.floor(frac * 0x1_0000_0000)) >>> 0;
  let h = (base ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x01000193);
  return (h >>> 0) / 0x1_0000_0000;
}
export function villaGeometryParameters(seed: number, radius = VILLA_SITE_RADIUS) {
  if (radius !== VILLA_SITE_RADIUS) throw new RangeError("villa fixed-size renderer supports plot radius 34 only; resize is unimplemented");
  const bodyL = 60 + villaSeedStream(seed, 1) * 2.4, bodyD = 13;
  const groundH = 4.6, upperH = 3.8, wallTop = groundH + upperH, deckTop = 0.55;
  const bays = 8 + Math.floor(villaSeedStream(seed, 2) * 5), margin = 3.5;
  const pitch = (bodyL - margin * 2) / bays, pierS = 1.2, pierH = 3.1, archR = (pitch - pierS) / 2;
  const towerSide = villaSeedStream(seed, 3) < 0.5 ? 1 : -1;
  const towerHalf = 2.6, towerEmbed = 1.05, towerOut = towerEmbed + towerHalf, deckOut = 0.6;
  const bodyCx = (-towerSide * (towerOut - deckOut)) / 2;
  const towerX = bodyCx + towerSide * bodyL / 2 + towerSide * towerEmbed;
  return Object.freeze({ seed, plotRadius: radius, bodyL, bodyD, groundH, upperH, wallTop, deckTop, bays, margin, pitch,
    pierS, pierH, archR, towerSide, towerHalf, towerEmbed, towerOut, deckOut, bodyCx, towerX,
    deckWidth: bodyL + deckOut * 2, deckDepth: 19.2,
    stepWidth: 8, stepHeight: 0.28, stepDepth: 1.4, firstStepY: 0.42, firstStepZ: 8.9, secondStepY: 0.14, secondStepZ: 9.9,
    towerBaseWidth: 5.9, towerBaseHeight: 1.9, towerBaseY: 0.95,
    roofWidth: bodyL + 3, roofDepth: bodyD + 2.8 });
}
export type VillaGeometryParameters = ReturnType<typeof villaGeometryParameters>;
/** Actual y=0 contact patches, not a circle or a hull covering empty space. */
export function villaGroundSupport(p: VillaGeometryParameters): LocalFootprint {
  return { parts: [
    { shape: "rect", center: { x: p.bodyCx, z: 0 }, width: p.deckWidth, depth: p.deckDepth },
    { shape: "rect", center: { x: p.bodyCx, z: p.secondStepZ }, width: p.stepWidth, depth: p.stepDepth },
    { shape: "rect", center: { x: p.towerX, z: 0 }, width: p.towerBaseWidth, depth: p.towerBaseWidth },
  ] };
}
export type VillaGroundPhysicalResolution =
  | { status: "partial"; declaration: PhysicalDeclaration; parameters: VillaGeometryParameters;
      missing: readonly ["entrance-and-approach", "scene-support-and-road-proof"] }
  | { status: "unsupported"; reason: string };
/** Local ground contract only. No renderer piles exist, so water support cannot be declared away. */
export function resolveVillaGroundPhysical(input: { seed: number; radius?: number }): VillaGroundPhysicalResolution {
  try {
    const parameters = villaGeometryParameters(input.seed, input.radius ?? VILLA_SITE_RADIUS), support = villaGroundSupport(parameters);
    const declaration = declarePhysical({ modelId: "villa-complex", modelRevision: VILLA_GEOMETRY_REVISION, footprint: support,
      overhang: { parts: [
        { shape: "rect", center: { x: parameters.bodyCx, z: 0 }, width: parameters.roofWidth, depth: parameters.roofDepth },
        { shape: "rect", center: { x: parameters.towerX, z: 0 }, width: parameters.towerBaseWidth, depth: parameters.towerBaseWidth },
      ] },
      foundation: { kind: "ground", support, maxRelief: 1, maxGap: 0.2, maxEmbed: 0.6, baseOffset: 0 }, entrances: [],
      notes: "Ground support geometry only; doorway/approach and scene support are pending. Empty entrances is not zero entrance demand or complete physical coverage.",
    });
    return { status: "partial", declaration, parameters, missing: ["entrance-and-approach", "scene-support-and-road-proof"] };
  } catch (error) { return { status: "unsupported", reason: error instanceof Error ? error.message : "unsupported villa parameters" }; }
}
