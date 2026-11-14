import type { ContentPackageManifestV2, DiagnosticV1, Result } from "./types";
import { canonicalJson } from "./package";
import { validateCityWorldProfile, validateSceneDraft, validateCityProjectAssetCatalog } from "./validate";
import { validateMiniGamePack } from "./content";
import { inspectGlbBytes } from "./model";
import { validateWorldPlanPatch } from "./worldPlanPatch";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_FILES = 128;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
const fail = (code: string, path: string, message: string): Result<never> => ({ ok: false, diagnostics: [{ code, path, message, severity: "error" } as DiagnosticV1] });
const safePath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !v.startsWith("/") && !v.includes("\\")
  && v.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part) && part !== "." && part !== "..");

/** Validate only the v2 manifest. File bytes, digest and installation are separate gates. */
export function validateContentPackageManifestV2(input: unknown): Result<ContentPackageManifestV2> {
  let value: unknown;
  try { value = JSON.parse(canonicalJson(input)); } catch { return fail("content_manifest_invalid", "$", "Manifest must be a plain, finite JSON object."); }
  if (!record(value) || !keys(value, ["formatVersion", "kind", "packageId", "version", "sdkContractVersion", "minCityRuntimeVersion", "entry", "files", "contentDigest"]))
    return fail("content_manifest_invalid", "$", "Manifest must contain exactly the v2 fields.");
  if (value.formatVersion !== 2 || (value.kind !== "city-world" && value.kind !== "city-minigame")) return fail("content_manifest_unsupported", "kind", "Only v2 world and mini-game packages are supported.");
  if (typeof value.packageId !== "string" || !ID.test(value.packageId) || [value.version, value.sdkContractVersion, value.minCityRuntimeVersion].some(v => typeof v !== "string" || !VERSION.test(v)))
    return fail("content_identity_invalid", "$", "Package identity and version fields are required.");
  if (typeof value.contentDigest !== "string" || !DIGEST.test(value.contentDigest)) return fail("content_digest_invalid", "contentDigest", "A lowercase SHA-256 digest is required.");
  if (!record(value.entry)) return fail("content_entry_invalid", "entry", "Entry must be an object.");
  const entry = value.entry;
  const world = value.kind === "city-world";
  if (!(world ? (keys(entry, ["profile", "scene", "assets", "generatorVersion", "defaultSeed"]) || keys(entry, ["profile", "scene", "assets", "generatorVersion", "defaultSeed", "patch"])) : keys(entry, ["game", "assets"])))
    return fail("content_entry_invalid", "entry", "Entry fields do not match the package kind.");
  if (world && (!Number.isSafeInteger(entry.generatorVersion) || (entry.generatorVersion as number) < 1 || !Number.isSafeInteger(entry.defaultSeed) || (entry.defaultSeed as number) < 0 || (entry.defaultSeed as number) > 0xffffffff))
    return fail("content_entry_invalid", "entry", "World generator version and seed are invalid.");
  const entryPaths = world ? [entry.profile, entry.scene, entry.assets, ...(entry.patch === undefined ? [] : [entry.patch])] : [entry.game, entry.assets];
  if (!entryPaths.every(safePath) || new Set(entryPaths).size !== entryPaths.length) return fail("content_entry_invalid", "entry", "Entry paths must be distinct safe relative paths.");
  if (!Array.isArray(value.files) || value.files.length < entryPaths.length || value.files.length > MAX_FILES) return fail("content_file_count_invalid", "files", "File count is outside the allowed range.");
  const paths = new Map<string, string>();
  const foldedPaths = new Set<string>();
  let previous = "", total = 0;
  for (const [index, file] of value.files.entries()) {
    const at = `files[${index}]`;
    if (!record(file) || !keys(file, ["path", "mediaType", "byteLength", "sha256"]) || !safePath(file.path) || typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)) return fail("content_file_invalid", at, "Invalid file declaration.");
    const extensions: Record<string, string> = { "application/json": ".json", "model/gltf-binary": ".glb", "image/png": ".png", "image/jpeg": ".jpg" };
    const extension = typeof file.mediaType === "string" ? extensions[file.mediaType] : undefined;
    if (!extension || !file.path.endsWith(extension) || !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 1 || (file.byteLength as number) > (file.mediaType === "application/json" ? MAX_JSON_BYTES : MAX_MEDIA_BYTES)) return fail("content_file_invalid", at, "Unsupported file type, extension or byte length.");
    if (file.path <= previous || foldedPaths.has(file.path.toLowerCase())) return fail("content_file_order_invalid", at, "File paths must be sorted and portable without case collisions.");
    previous = file.path; foldedPaths.add(file.path.toLowerCase()); paths.set(file.path, file.mediaType as string);
    total += file.byteLength as number;
    if (total > MAX_TOTAL_BYTES) return fail("content_budget_exceeded", "files", "Package exceeds the aggregate raw byte limit.");
  }
  if (entryPaths.some(path => paths.get(path as string) !== "application/json")) return fail("content_entry_missing", "entry", "Each entry must reference a declared JSON file.");
  const result = value as unknown as ContentPackageManifestV2;
  Object.freeze(result.entry); for (const file of result.files) Object.freeze(file); Object.freeze(result.files); Object.freeze(result);
  return { ok: true, value: result, diagnostics: [] };
}

export const CONTENT_PACKAGE_V2_LIMITS = Object.freeze({ maxFiles: MAX_FILES, maxTotalBytes: MAX_TOTAL_BYTES, maxJsonBytes: MAX_JSON_BYTES, maxMediaBytes: MAX_MEDIA_BYTES });

/**
 * Digest input: UTF-8 canonicalJson of the complete manifest with only
 * contentDigest removed. File hashes cover the exact raw bytes, not decoded JSON.
 * This checks integrity, not authenticity, semantic validity or installability.
 */
export async function verifyContentPackageBytesV2(input: unknown, files: ReadonlyMap<string, Uint8Array>): Promise<Result<ContentPackageManifestV2>> {
  const checked = validateContentPackageManifestV2(input);
  if (!checked.ok) return checked;
  const manifest = checked.value;
  if (!(files instanceof Map) || Object.getPrototypeOf(files) !== Map.prototype || files.size !== manifest.files.length)
    return fail("content_file_set_mismatch", "files", "The supplied files must exactly match the manifest.");
  const copies = new Map<string, Uint8Array>();
  for (const declaration of manifest.files) {
    const data = files.get(declaration.path);
    if (!(data instanceof Uint8Array) || data.byteLength !== declaration.byteLength
      || (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer))
      return fail("content_file_length_mismatch", `files.${declaration.path}`, "File is missing, shared, or has an unexpected byte length.");
    copies.set(declaration.path, Uint8Array.from(data));
  }
  if (!globalThis.crypto?.subtle) return fail("content_crypto_unavailable", "$", "SHA-256 is unavailable in this environment.");
  const hash = async (data: Uint8Array<ArrayBuffer>): Promise<string> => {
    const result = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
    return `sha256:${Array.from(result, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  try {
    const { contentDigest, ...digestInput } = manifest;
    if (await hash(new TextEncoder().encode(canonicalJson(digestInput))) !== contentDigest)
      return fail("content_digest_mismatch", "contentDigest", "Manifest digest does not match its canonical contents.");
    for (const declaration of manifest.files) {
      const data = copies.get(declaration.path)!;
      if (await hash(data as Uint8Array<ArrayBuffer>) !== declaration.sha256)
        return fail("content_file_digest_mismatch", `files.${declaration.path}`, "File digest does not match the declared bytes.");
    }
  } catch { return fail("content_crypto_unavailable", "$", "SHA-256 could not be computed."); }
  return { ok: true, value: manifest, diagnostics: [] };
}

/** Inspect a private snapshot; an unchecked item is never an installation grant. */
export async function inspectContentPackageV2(input: unknown, files: ReadonlyMap<string, Uint8Array>): Promise<Result<{ manifest: ContentPackageManifestV2; unchecked: readonly string[] }>> {
  const shape = validateContentPackageManifestV2(input);
  if (!shape.ok) return shape;
  if (!(files instanceof Map) || Object.getPrototypeOf(files) !== Map.prototype || files.size !== shape.value.files.length)
    return fail("content_file_set_mismatch", "files", "The supplied files must exactly match the manifest.");
  const snapshot = new Map<string, Uint8Array>();
  for (const declaration of shape.value.files) {
    const bytes = files.get(declaration.path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== declaration.byteLength || (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer))
      return fail("content_file_length_mismatch", `files.${declaration.path}`, "File is missing, shared, or has an unexpected byte length.");
    snapshot.set(declaration.path, Uint8Array.from(bytes));
  }
  const integrity = await verifyContentPackageBytesV2(shape.value, snapshot);
  if (!integrity.ok) return integrity;
  const manifest = integrity.value;
  const parse = (path: string): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.get(path)!));
  try {
    const assets = validateCityProjectAssetCatalog(parse(manifest.entry.assets));
    if (!assets.ok) return fail("content_asset_catalog_invalid", "entry.assets", "Asset catalog did not pass the bounded project catalog contract.");
    const declared = new Map(manifest.files.map(file => [file.path, file]));
    for (const asset of assets.value.entries) {
      const file = declared.get(asset.relativePath);
      if (!file || file.mediaType !== "model/gltf-binary" || file.sha256 !== asset.sha256 || file.byteLength !== asset.byteLength)
        return fail("content_asset_missing", `assets.${asset.assetId}`, "Catalog asset is missing or does not match its declared file.");
    }
    const catalogPaths = new Set(assets.value.entries.map(asset => asset.relativePath));
    for (const file of manifest.files) if (file.mediaType === "model/gltf-binary") {
      if (!catalogPaths.has(file.path)) return fail("content_asset_unregistered", `files.${file.path}`, "Each model must appear in the asset catalog.");
      if (!inspectGlbBytes(snapshot.get(file.path)!).ok) return fail("content_model_invalid", `files.${file.path}`, "Model did not pass the restricted GLB inspection.");
    }
    if (manifest.kind === "city-world" && "profile" in manifest.entry) {
      if (!validateCityWorldProfile(parse(manifest.entry.profile)).ok) return fail("content_profile_invalid", "entry.profile", "World profile did not pass the SDK contract.");
      const scene = validateSceneDraft(parse(manifest.entry.scene));
      if (!scene.ok) return fail("content_scene_invalid", "entry.scene", "Scene did not pass the SDK contract.");
      if (manifest.entry.patch !== undefined) {
        const patch = validateWorldPlanPatch(parse(manifest.entry.patch), manifest.entry.defaultSeed, manifest.entry.generatorVersion);
        if (!patch.ok) return patch;
      }
      const byId = new Map(assets.value.entries.map(asset => [asset.assetId, asset]));
      for (const object of scene.value.objects) if (object.kind === "model") {
        const asset = byId.get(object.asset.assetId);
        if (!asset || asset.sha256 !== object.asset.digest) return fail("content_scene_asset_unresolved", `scene.${object.id}`, "Scene model is not present in the asset catalog with the same digest.");
        const ref = object.asset.package;
        if (ref.kind !== "city-world" || ref.id !== manifest.packageId || ref.version !== manifest.version || ref.digest !== "self")
          return fail("content_scene_asset_scope_invalid", `scene.${object.id}`, "Scene model must explicitly refer to this world package and use the self reference.");
      }
    } else if (manifest.kind === "city-minigame" && "game" in manifest.entry) {
      if (!validateMiniGamePack(parse(manifest.entry.game)).ok) return fail("content_game_invalid", "entry.game", "Game did not pass the SDK contract.");
    } else return fail("content_entry_invalid", "entry", "Entry does not match its package kind.");
  } catch { return fail("content_json_invalid", "entry", "Entry must be valid UTF-8 JSON."); }
  const unchecked = ["package_authenticity", "runtime_compatibility", "image_decode", "additional_json_semantics", "world_geometry_and_roads", "installation"];
  return { ok: true, value: Object.freeze({ manifest, unchecked: Object.freeze(unchecked) }), diagnostics: [] };
}
