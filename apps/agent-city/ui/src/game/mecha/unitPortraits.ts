import assaultSrc from "../../assets/mecha/portraits/assault.jpg";
import gunnerSrc from "../../assets/mecha/portraits/gunner.jpg";
import supportSrc from "../../assets/mecha/portraits/support.jpg";
import bossSrc from "../../assets/mecha/portraits/boss.jpg";
import raiderSrc from "../../assets/mecha/portraits/raider.jpg";

export type UnitPortraitKey = "assault" | "gunner" | "support" | "boss" | "raider";

/** Artwork only: localized names, faction and west/east cues belong to unitIdentity. */
export type UnitPortraitDescriptor = Readonly<{
  key: UnitPortraitKey;
  src: string;
  width: 256;
  height: 256;
}>;

function portrait(key: UnitPortraitKey, src: string): UnitPortraitDescriptor {
  return Object.freeze({ key, src, width: 256, height: 256 });
}

const raider = portrait("raider", raiderSrc);
const PORTRAITS: Readonly<Record<string, UnitPortraitDescriptor>> = Object.freeze({
  Assault: portrait("assault", assaultSrc),
  Gunner: portrait("gunner", gunnerSrc),
  Support: portrait("support", supportSrc),
  boss: portrait("boss", bossSrc),
  "raider-w": raider,
  "raider-e": raider,
  "raider-west": raider,
  "raider-east": raider,
});

/** Pure, exact-ID lookup. Unknown IDs never inherit a guessed unit's artwork. */
export function getUnitPortrait(unitId: string): UnitPortraitDescriptor | null {
  return Object.hasOwn(PORTRAITS, unitId) ? PORTRAITS[unitId] : null;
}

/** URL-only convenience for non-React consumers, including world DOM badges. */
export function getUnitPortraitSrc(unitId: string): string | null {
  return getUnitPortrait(unitId)?.src ?? null;
}
