/** Pure object-class declarations. No renderer/editor imports or nominal-circle
 * substitution for model geometry. Instance envelopes/heights remain explicit
 * pending capabilities until their renderer declarations are registered. */
import type { CityLayout } from "../cityLayout";
import { civicMinimumSize, GARDEN_MINIMUM_SIZE, DISTRICT_LANDMARK_ENVELOPE } from "./layoutPlacementGeometry";
import { tvTowerModel } from "./landmarks/tvTower";
import { pagodaModel } from "./landmarks/pagoda";
import { archModel } from "./landmarks/arch";
import { sailOperaModel } from "./landmarks/sailOpera";
import { lighthouseModel } from "./landmarks/lighthouse";
import { ferrisWheelModel } from "./landmarks/ferrisWheel";

export type SiteFamily = "data" | "civic" | "garden" | "district-landmark" | "context" | "landmark" | "public-site" | "scenery";
export type SiteClass = {
  readonly id: string; readonly family: SiteFamily; readonly title: string;
  readonly catalogId: string | null; readonly noCatalogReason?: string;
  readonly additionalCatalogIds?: readonly string[];
  readonly meshNames: readonly string[];
  readonly decorKind: string | null;
  /** Named renderer sub-variants may retain their historical presentation route
   * without inventing a second layout object or catalog owner. Exact names only. */
  readonly meshRoutes?: Readonly<Record<string, string>>;
  readonly source: { readonly array: "civics" | "gardens" | "districtLandmarks" | "contextBuildings" | "landmarks" | "publicSites";
    readonly match?: (raw: unknown) => boolean } | null;
  readonly placement?: { readonly mode: "face-lot" | "face-reserve" | "parcel";
    readonly minimumSize?: () => { width: number; depth: number } };
  readonly pendingCapabilities: readonly string[];
};
const hasKind = (kind: string) => (raw: unknown) => typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === kind;
const pending = ["renderer instance envelope", "renderer pick height"] as const;
const civic = (kind: string, title: string): SiteClass => ({ id: `civic:${kind}`, family: "civic", title,
  catalogId: kind, meshNames: ["city-civic-*"], decorKind: "civic", source: { array: "civics", match: hasKind(kind) },
  placement: { mode: "face-lot", minimumSize: () => {
    const minimum = civicMinimumSize(kind); if (!minimum) throw new Error(`undeclared civic geometry: ${kind}`); return minimum;
  } }, pendingCapabilities: pending });
const landmark = (kind: string, title: string, meshRoutes?: Readonly<Record<string, string>>): SiteClass => ({ id: `landmark:${kind}`, family: "landmark", title,
  catalogId: kind === "villa-complex" ? "villa" : kind, meshNames: [`city-landmark-${kind}`, ...Object.keys(meshRoutes ?? {})], decorKind: `landmark:${kind}`,
  ...(meshRoutes ? { meshRoutes } : {}),
  source: { array: "landmarks", match: hasKind(kind) }, pendingCapabilities: pending });
const publicSite = (kind: string, title: string, catalogId: string): SiteClass => ({ id: `public:${kind}`, family: "public-site", title,
  catalogId, meshNames: ["city-public-sites-*"], decorKind: "site", source: { array: "publicSites", match: hasKind(kind) }, pendingCapabilities: pending });
const sceneryDecorKinds: Readonly<Record<string, string>> = { seaside: "seaside", airport: "landmark:airport",
  "bridge-truss": "landmark:truss-bridge", volcano: "volcano", massing: "massing" };
const scenery = (id: string, title: string, catalogId: string | null, meshNames: readonly string[]): SiteClass => ({
  id: `scenery:${id}`, family: "scenery", title, catalogId, meshNames, decorKind: sceneryDecorKinds[id] ?? null, source: null,
  ...(catalogId === null ? { noCatalogReason: "纯远景或聚合显示对象，没有独立建筑目录条目" } : {}), pendingCapabilities: pending });

/** Partial B0 declarations, consumed by names and picking. Shared merged mesh
 * names identify a family, not an instance or a particular member class. */
export const SITE_CLASSES: readonly SiteClass[] = [
  civic("school", "学校"), civic("mall", "商场"), civic("hospital", "医院"),
  { id: "garden", family: "garden", title: "城区花园与景观湖", catalogId: "garden", meshNames: ["city-garden-*"], decorKind: "garden",
    source: { array: "gardens" }, placement: { mode: "face-lot", minimumSize: () => ({ ...GARDEN_MINIMUM_SIZE }) }, pendingCapabilities: pending },
  { id: "district-landmark", family: "district-landmark", title: "城区地标", catalogId: "district-landmark", meshNames: ["city-landmark-district:*"], decorKind: "district-landmark",
    source: { array: "districtLandmarks" }, placement: { mode: "face-reserve", minimumSize: () => ({ ...DISTRICT_LANDMARK_ENVELOPE }) }, pendingCapabilities: pending },
  { id: "context", family: "context", title: "背景楼", catalogId: null, noCatalogReason: "城市肌理背景建筑不代表会话，没有独立目录条目",
    meshNames: ["city-vice-context-facades", "city-vice-context-rooftops"], decorKind: "backdrop", source: { array: "contextBuildings" },
    placement: { mode: "parcel" }, pendingCapabilities: pending },
  ...[tvTowerModel, pagodaModel, archModel, sailOperaModel, lighthouseModel, ferrisWheelModel].map(model => landmark(model.id, model.title)),
  landmark("twin-towers", "双子塔"), landmark("twist-tower", "扭转塔", { "city-landmark-twisting-deco-tower": "landmark:twisting-deco-tower" }),
  landmark("villa-complex", "地中海庄园"), landmark("suspension-bridge", "悬索桥"),
  { ...landmark("islet-mansion", "豪宅岛庄园"), catalogId: null, noCatalogReason: "湾心豪宅岛的布局期装饰，不经规划选址，暂无建筑说明配图" },
  { ...landmark("islet-grounds", "豪宅岛场地"), catalogId: null, noCatalogReason: "豪宅岛的环路与绿化，纯场地装饰，没有独立目录条目" },
  publicSite("civic", "市政厅", "civic-hall"), publicSite("station", "车站", "station"), publicSite("stadium", "体育场", "stadium"),
  publicSite("park", "城市公园", "park"), publicSite("tower", "观景塔", "observation-tower"), publicSite("harbor", "港口与码头", "harbor"),
  scenery("seaside", "海滨设施", "beach", ["city-lifeguard-towers", "city-yachts", "city-beach-furniture", "city-beach-people", "city-volleyball-courts", "city-promenade-props", "city-marina"]),
  scenery("airport", "机场岛与堤道", "airport", ["city-landmark-airport"]),
  scenery("bridge-truss", "桁架桥", "truss-bridge", ["city-landmark-truss-bridge"]),
  scenery("expressway", "环线高架", "expressway", ["city-district-expressway-deck", "city-district-expressway-rails", "city-district-expressway-lines", "city-district-expressway-supports"]),
  scenery("volcano", "火山", null, ["city-sea-volcano"]), scenery("massing", "聚合楼群", null, ["city-massing"]),
  scenery("signs", "广告牌", "signs", []),
  { id: "data:session", family: "data", title: "会话楼", catalogId: "session-tower",
    additionalCatalogIds: ["session-slab", "session-deco", "session-hotel", "hero-tower"], meshNames: [], decorKind: null, source: null,
    placement: { mode: "parcel" }, pendingCapabilities: ["district slot enumeration", ...pending] },
];

/** Legacy ids and new class#instance ids resolve without dropping instance tails
 * into kind parsing. Unknown ids stay unknown rather than becoming decorations. */
export function siteClassOf(id: string): SiteClass | null {
  let classId = id.startsWith("decor:") ? id.slice("decor:".length) : id;
  classId = classId.split("#")[0];
  if (classId.startsWith("landmark:district:") && classId.length > "landmark:district:".length) classId = "district-landmark";
  if (classId.startsWith("site:")) classId = `public:${classId.slice("site:".length)}`;
  const exact = SITE_CLASSES.find(item => item.id === classId);
  if (exact) return exact;
  const aliases = SITE_CLASSES.filter(item => item.decorKind === classId || Object.values(item.meshRoutes ?? {}).includes(classId));
  return aliases.length === 1 ? aliases[0] : null;
}
export function siteClassesForInstance(array: NonNullable<SiteClass["source"]>["array"], raw: unknown): readonly SiteClass[] {
  return SITE_CLASSES.filter(item => item.source?.array === array && (!item.source.match || item.source.match(raw)));
}
/** Merged meshes yield multiple member classes with one common family route;
 * this deliberately does not claim a particular class or instance. */
export function siteClassesForMesh(name: string): readonly SiteClass[] {
  const exact = SITE_CLASSES.filter(item => item.meshNames.includes(name));
  if (exact.length) return exact;
  return SITE_CLASSES.filter(item => item.meshNames.some(pattern => pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))));
}
/** Enumeration of classification only; intentionally not a geometry proof. */
export function classifyLayoutSites(layout: CityLayout): Array<{ array: NonNullable<SiteClass["source"]>["array"]; raw: unknown; classes: readonly SiteClass[] }> {
  const arrays = [...new Set(SITE_CLASSES.flatMap(item => item.source ? [item.source.array] : []))];
  return arrays.flatMap(array => (layout[array] ?? []).map(raw => ({ array, raw, classes: siteClassesForInstance(array, raw) })));
}
