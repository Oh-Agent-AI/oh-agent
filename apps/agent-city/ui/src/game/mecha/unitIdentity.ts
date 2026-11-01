import type { GameLocale } from "../gameCopy";
import type { MechId } from "./rules";

export type UnitIdentitySide = "mech" | "enemy" | "unknown";

export type UnitIdentityDescriptor = {
  /** The source ID is retained so unknown entities remain inspectable. */
  id: string;
  /** Short localized display name; unknown non-empty IDs are shown verbatim. */
  label: string;
  /** Non-color cue for compact maps, rows, and legends. */
  symbol: string;
  side: UnitIdentitySide;
  sideLabel: string;
  known: boolean;
};

type UnitIdentityDefinition = {
  side: Exclude<UnitIdentitySide, "unknown">;
  zh: string;
  en: string;
  sideZh: string;
  sideEn: string;
  symbol: string;
};

/** Stable source IDs used by the battle model and its existing presentation copy. */
export const UNIT_IDENTITY_IDS = [
  "Assault", "Gunner", "Support", "boss", "raider-west", "raider-east",
] as const;

const UNIT_IDENTITIES: Record<string, UnitIdentityDefinition> = {
  Assault: { side: "mech", zh: "突击", en: "Assault", sideZh: "我方机甲", sideEn: "Mech", symbol: "⚔" },
  Gunner: { side: "mech", zh: "射手", en: "Gunner", sideZh: "我方机甲", sideEn: "Mech", symbol: "◎" },
  Support: { side: "mech", zh: "支援", en: "Support", sideZh: "我方机甲", sideEn: "Mech", symbol: "✚" },
  boss: { side: "enemy", zh: "大怪", en: "Boss", sideZh: "敌方", sideEn: "Enemy", symbol: "⬟" },
  "raider-west": { side: "enemy", zh: "小怪西", en: "West raider", sideZh: "敌方", sideEn: "Enemy", symbol: "◀" },
  "raider-east": { side: "enemy", zh: "小怪东", en: "East raider", sideZh: "敌方", sideEn: "Enemy", symbol: "▶" },
  // Current PvE state uses these compact IDs; keep them aligned with enemyName and gameCopy.
  "raider-w": { side: "enemy", zh: "小怪西", en: "West raider", sideZh: "敌方", sideEn: "Enemy", symbol: "◀" },
  "raider-e": { side: "enemy", zh: "小怪东", en: "East raider", sideZh: "敌方", sideEn: "Enemy", symbol: "▶" },
};

/**
 * Describe only identities backed by the battle model's known IDs. Unknown IDs
 * stay visible verbatim and are explicitly marked unknown rather than guessed
 * from a prefix such as "raider-".
 */
export function describeUnitIdentity(id: string, locale: GameLocale): UnitIdentityDescriptor {
  const definition = Object.hasOwn(UNIT_IDENTITIES, id) ? UNIT_IDENTITIES[id] : undefined;
  if (!definition) {
    return {
      id,
      label: id || (locale === "en" ? "Unknown unit" : "未知单位"),
      symbol: "?",
      side: "unknown",
      sideLabel: locale === "en" ? "Side unknown" : "阵营未知",
      known: false,
    };
  }

  const en = locale === "en";
  return {
    id,
    label: en ? definition.en : definition.zh,
    symbol: definition.symbol,
    side: definition.side,
    sideLabel: en ? definition.sideEn : definition.sideZh,
    known: true,
  };
}

/** Type-narrowed convenience wrapper for the player mech avatar component. */
export function describeMechIdentity(id: MechId, locale: GameLocale): UnitIdentityDescriptor {
  return describeUnitIdentity(id, locale);
}
