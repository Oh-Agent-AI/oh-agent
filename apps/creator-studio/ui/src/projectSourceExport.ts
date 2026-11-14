import { canonicalJson, validateAssetRefs, validateCityInstance, validateCityLayoutScope, validateCityProjectAssetCatalog,
  validateMiniGamePack, validateMount, validateSceneDraft, validateWorldPlanPatch } from "@agent-vitals/city-sdk";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (code: string): never => { throw new Error(code); };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Export an independent City without requiring a game project. */
export function buildCitySourceExport(rawCity: unknown, generatorVersion: number): Readonly<{ files: Record<string, string> }> {
  const city = validateCityInstance(rawCity);
  if (!city.ok) return fail("creator_export_city_invalid");
  const patch = city.value.planPatch;
  if (patch != null && !validateWorldPlanPatch(patch, city.value.seed, generatorVersion).ok) return fail("creator_export_patch_not_portable");
  if (object(patch) && Array.isArray(patch.suppressedContext) && patch.suppressedContext.length) return fail("creator_export_patch_context_unresolved");
  const files: Record<string, string> = {
    "README.md": `# City source export\n\nWorld seed: ${city.value.seed}. Generator version: ${generatorVersion}.\n\nThis is an unsigned source project, not an installable runtime package. No game or playtest results are included.\n`,
    ".gitignore": "dist/\n",
    "world/world.json": json(city.value.profile),
  };
  if (patch != null) files["world/plan-patch.json"] = json(patch);
  return Object.freeze({ files });
}

/** Build data-only source files; the host separately copies verified assets. */
export async function buildProjectSourceExport(rawProject: unknown, rawCity: unknown, generatorVersion: number): Promise<Readonly<{ files: Record<string, string>; assetDigests: string[] }>> {
  if (!object(rawProject)) return fail("creator_export_project_invalid");
  const city = validateCityInstance(rawCity);
  if (!city.ok) return fail("creator_export_city_invalid");
  if (rawProject.cityId !== city.value.cityId || rawProject.cityRevision !== city.value.revision) return fail("creator_export_city_scope_mismatch");
  const snapshot = rawProject.cityLayout;
  if (!object(snapshot)) return fail("creator_export_layout_missing");
  const scope = validateCityLayoutScope({ ...snapshot, schemaVersion: 2, cityId: city.value.cityId, cityRevision: city.value.revision }, city.value);
  if (!scope.ok) return fail("creator_export_layout_invalid");
  const game = validateMiniGamePack(rawProject.game);
  if (!game.ok) return fail("creator_export_game_invalid");
  const catalog = validateCityProjectAssetCatalog(rawProject.assets ?? { schemaVersion: 1, entries: [] });
  if (!catalog.ok || catalog.value.entries.length > 64) return fail("creator_export_assets_invalid");
  const scene = validateSceneDraft(rawProject.scene ?? { schemaVersion: 1, objects: [] });
  if (!scene.ok) return fail("creator_export_scene_invalid");
  const patch = rawProject.cityPatch ?? city.value.planPatch;
  if (patch != null && !validateWorldPlanPatch(patch, city.value.seed, generatorVersion).ok) return fail("creator_export_patch_not_portable");
  // Existing context identifiers have no typed public/private distinction.
  // Refuse them instead of accidentally exporting a session-derived reference.
  if (object(patch) && Array.isArray(patch.suppressedContext) && patch.suppressedContext.length) return fail("creator_export_patch_context_unresolved");
  const mounts = rawProject.mounts;
  if (!Array.isArray(mounts) || mounts.length > 1 || (mounts.length === 1 && !object(mounts[0]))) return fail("creator_export_single_mount_required");
  const layout = scope.value.layout;
  const gameDigest = await digest(game.value);
  const gameRef = { kind: "city-minigame" as const, id: game.value.id, version: "1", digest: gameDigest };
  let exportedMount: unknown = null;
  if (mounts.length === 1) {
    const rawMount = mounts[0];
    if (!object(rawMount.layout) || !object(rawMount.game) || rawMount.layout.id !== layout.id || rawMount.layout.digest !== scope.value.worldRevision
      || rawMount.game.id !== game.value.id || rawMount.game.digest !== gameDigest) return fail("creator_export_mount_scope_mismatch");
    const mount = { ...rawMount, layout: { kind: "city-layout" as const, id: layout.id, version: "1", digest: await digest(layout) }, game: gameRef };
    const checkedMount = validateMount({ layout, game: game.value, mount, resolvedRefs: { layout: mount.layout, game: gameRef } });
    if (!checkedMount.ok) return fail("creator_export_mount_invalid");
    exportedMount = checkedMount.value.mount;
  }
  const byId = new Map(catalog.value.entries.map(entry => [entry.assetId, entry]));
  const registeredRefs = rawProject.assetRefs === undefined ? [] : rawProject.assetRefs;
  if (!Array.isArray(registeredRefs)) return fail("creator_export_asset_reference_invalid");
  const rewritten = { schemaVersion: 1, objects: scene.value.objects.map(item => {
    if (item.kind !== "model") return item;
    const asset = byId.get(item.asset.assetId);
    if (!asset || asset.sha256 !== item.asset.digest || !asset.boundsMeters
      || !registeredRefs.some(ref => canonicalJson(ref) === canonicalJson(item.asset))) return fail("creator_export_asset_reference_invalid");
    return { ...item, asset: { ...item.asset, package: gameRef } };
  }) };
  const modelCatalog = { schemaVersion: 1 as const, entries: catalog.value.entries.filter(entry => entry.boundsMeters).map(entry => ({
    ref: { package: gameRef, assetId: entry.assetId, digest: entry.sha256 }, relativePath: entry.relativePath,
    byteLength: entry.byteLength, boundsMeters: entry.boundsMeters!, unit: "meter" as const,
  })) };
  if (!validateAssetRefs({ refs: rewritten.objects.flatMap(item => item.kind === "model" ? [item.asset] : []), catalog: modelCatalog }).ok)
    return fail("creator_export_asset_reference_invalid");
  const files: Record<string, string> = {
    "README.md": `# City source export\n\nWorld seed: ${city.value.seed}. Generator version: ${generatorVersion}.\n\nWorld and game are separate projects. ${exportedMount ? "The game layout and mount are a snapshot-specific development binding. Regenerate the City and rebind after any world or patch change." : "The game has no mount; bind it to a City layout before validation or playtest."} No playtest results are included. This export is unsigned and is not an installable runtime package. A game trace is not generated; create and validate one before a CLI headless playtest.\n`,
    ".gitignore": "dist/\n",
    "world/world.json": json(city.value.profile),
    "games/game/game.json": json(game.value),
    "games/game/layout.json": json(layout),
    "games/game/scene.json": json(rewritten),
    "games/game/assets/catalog.json": json(catalog.value),
  };
  if (exportedMount) files["games/game/mount.json"] = json(exportedMount);
  if (patch != null) files["world/plan-patch.json"] = json(patch);
  return Object.freeze({ files, assetDigests: catalog.value.entries.map(entry => entry.sha256) });
}
