/** App-side catalog for game type discovery. It includes the four implemented
 * Miami activities and the planned ornithopter descriptor; planned entries are
 * deliberately not registered and validateTemplateLink() rejects them. */
import { MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_GAME_TYPE_V1, ORNITHOPTER_PROTOTYPE_GAME_TYPE_V1, validateTemplateLink } from "../../../../../../packages/agent-vitals-city-game-runtime/src/index";

export const CITY_GAME_TYPE_CATALOG = Object.freeze([...MIAMI_ACTIVITY_CATALOG_V1, ORNITHOPTER_PROTOTYPE_GAME_TYPE_V1, ORNITHOPTER_GAME_TYPE_V1]);
export const PLANNED_GAME_TYPE_IDS = Object.freeze(CITY_GAME_TYPE_CATALOG.filter(item => item.templateCatalog === "planned").map(item => item.id));
export const PROTOTYPE_GAME_TYPE_IDS = Object.freeze(CITY_GAME_TYPE_CATALOG.filter(item => item.id.includes("-prototype-")).map(item => item.id));
export function gameTypeBlockReason(typeId: string): string | null {
  const descriptor = CITY_GAME_TYPE_CATALOG.find(item => item.id === typeId);
  return descriptor ? validateTemplateLink(descriptor) : `Game type ${typeId} is not in the app catalog.`;
}
