import type { CityContentPackageV1, DiagnosticV1, PackageManifestV1, Result } from "./types";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_PACKAGE_FILES = 128;
const MAX_JSON_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 140 * 1024 * 1024;
const diagnostic = (code: string, path: string, message: string): DiagnosticV1 => ({ code, severity: "error", path, message });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  if (value.endsWith("==")) return BASE64_ALPHABET.indexOf(value[value.length - 3]!) % 16 === 0;
  if (value.endsWith("=")) return BASE64_ALPHABET.indexOf(value[value.length - 2]!) % 4 === 0;
  return true;
}

/** Stable JSON encoding used for content-file and manifest digest inputs. */
export function canonicalJson(value: unknown): string {
  const encode = (item: unknown, path: string, ancestors: Set<object>): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(`${path} contains a non-finite number.`);
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError(`${path} contains a cycle.`);
      if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).some(key => {
        if (key === "length") return false;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= item.length || String(index) !== key;
      })) {
        throw new TypeError(`${path} contains non-JSON array properties.`);
      }
      ancestors.add(item);
      const entries = Array.from({ length: item.length }, (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(item, index)) throw new TypeError(`${path}[${index}] is missing.`);
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}[${index}] must be a data property.`);
        return encode(item[index], `${path}[${index}]`, ancestors);
      });
      const encoded = `[${entries.join(",")}]`;
      ancestors.delete(item);
      return encoded;
    }
    if (object(item)) {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object.`);
      if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length) {
        throw new TypeError(`${path} contains non-JSON object properties.`);
      }
      if (ancestors.has(item)) throw new TypeError(`${path} contains a cycle.`);
      ancestors.add(item);
      const keys = Object.keys(item).sort();
      const encoded = `{${keys.map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || descriptor.get || descriptor.set) throw new TypeError(`${path}.${key} must be a data property.`);
        const entry = item[key];
        if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
          throw new TypeError(`${path}.${key} is not a JSON value.`);
        }
        return `${JSON.stringify(key)}:${encode(entry, `${path}.${key}`, ancestors)}`;
      }).join(",")}}`;
      ancestors.delete(item);
      return encoded;
    }
    throw new TypeError(`${path} is not a JSON value.`);
  };
  return encode(value, "$", new Set());
}

function isPackagePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(part) && part !== "." && part !== "..");
}

/** Validate the bounded, unsigned package manifest contract. Hash verification belongs to the loader. */
export function validatePackageManifest(value: unknown): Result<PackageManifestV1> {
  if (!object(value) || !exactKeys(value, ["schemaVersion", "package", "entry", "files", "packageDigest", "signature"])) {
    return { ok: false, diagnostics: [diagnostic("package_manifest_invalid_shape", "$", "Manifest must contain exactly the version 1 package fields.")] };
  }
  if (value.schemaVersion !== 1 || value.signature !== null) {
    return { ok: false, diagnostics: [diagnostic("package_manifest_unsupported", "$", "Only unsigned version 1 development manifests are supported.")] };
  }
  if (!object(value.package) || !exactKeys(value.package, ["kind", "id", "version"]) || value.package.kind !== "city-minigame"
    || typeof value.package.id !== "string" || !ID.test(value.package.id)
    || typeof value.package.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.package.version)) {
    return { ok: false, diagnostics: [diagnostic("package_identity_invalid", "package", "Package identity must be a supported City mini-game ID and version.")] };
  }
  if (!object(value.entry) || !exactKeys(value.entry, ["layout", "game", "mount"])
    || !isPackagePath(value.entry.layout) || !isPackagePath(value.entry.game) || !isPackagePath(value.entry.mount)) {
    return { ok: false, diagnostics: [diagnostic("package_entry_invalid", "entry", "Package entry paths must be normalized relative paths.")] };
  }
  if (!Array.isArray(value.files) || value.files.length < 3 || value.files.length > MAX_PACKAGE_FILES) {
    return { ok: false, diagnostics: [diagnostic("package_file_count_invalid", "files", `A City mini-game package must declare 3 to ${MAX_PACKAGE_FILES} files.`)] };
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  let previousPath = "";
  for (const [index, raw] of value.files.entries()) {
    const path = `files[${index}]`;
    const maxLength = object(raw) && raw.mediaType === "model/gltf-binary" ? MAX_BINARY_FILE_BYTES : MAX_JSON_FILE_BYTES;
    if (!object(raw) || !exactKeys(raw, ["path", "mediaType", "byteLength", "sha256"]) || !isPackagePath(raw.path)
      || (raw.mediaType !== "application/json" && raw.mediaType !== "model/gltf-binary")
      || (raw.mediaType === "model/gltf-binary" && (!raw.path.endsWith(".glb") || (raw.byteLength as number) < 20))
      || !Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) < 1
      || (raw.byteLength as number) > maxLength || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) {
      return { ok: false, diagnostics: [diagnostic("package_file_invalid", path, "Each file must declare a safe JSON or GLB media type, bounded length and sha256: digest.")] };
    }
    if (paths.has(raw.path)) return { ok: false, diagnostics: [diagnostic("package_file_duplicate", `${path}.path`, "Package file paths must be unique.")] };
    if (raw.path <= previousPath) return { ok: false, diagnostics: [diagnostic("package_files_not_sorted", path, "Package files must be sorted lexicographically by path.")] };
    paths.add(raw.path);
    previousPath = raw.path;
    totalBytes += raw.byteLength as number;
    if (totalBytes > MAX_PACKAGE_BYTES) return { ok: false, diagnostics: [diagnostic("package_budget_exceeded", "files", "Package exceeds the version 1 aggregate raw byte limit.")] };
  }
  for (const [name, entryPath] of Object.entries(value.entry)) {
    if (!paths.has(entryPath as string)) return { ok: false, diagnostics: [diagnostic("package_entry_missing", `entry.${name}`, "Entry path must refer to a declared package file.")] };
  }
  if (new Set(Object.values(value.entry)).size !== 3) return { ok: false, diagnostics: [diagnostic("package_entry_collision", "entry", "Layout, game and mount must use distinct files.")] };
  if (typeof value.packageDigest !== "string" || !SHA256.test(value.packageDigest)) {
    return { ok: false, diagnostics: [diagnostic("package_digest_invalid", "packageDigest", "Package digest must use sha256:<lowercase hex> format.")] };
  }
  const files = value.files.map(file => ({ path: (file as Record<string, unknown>).path as string,
    mediaType: (file as Record<string, unknown>).mediaType as PackageManifestV1["files"][number]["mediaType"], byteLength: (file as Record<string, unknown>).byteLength as number,
    sha256: (file as Record<string, unknown>).sha256 as string }));
  return { ok: true, value: Object.freeze({ schemaVersion: 1, package: Object.freeze({ ...value.package }) as PackageManifestV1["package"],
    entry: Object.freeze({ ...value.entry }) as PackageManifestV1["entry"], files: Object.freeze(files.map(file => Object.freeze(file))),
    packageDigest: value.packageDigest, signature: null }), diagnostics: [] };
}

/** Structural validation only. The consumer must verify SHA-256 digests before resolving package content. */
export function validateCityContentPackage(value: unknown): Result<CityContentPackageV1> {
  if (!object(value) || !exactKeys(value, ["format", "manifest", "files"]) || value.format !== "oh-agent-city-package-v1" || !object(value.files)) {
    return { ok: false, diagnostics: [diagnostic("package_invalid_shape", "$", "Package must contain the version 1 format, manifest and files map.")] };
  }
  const manifestResult = validatePackageManifest(value.manifest);
  if (!manifestResult.ok) return manifestResult;
  const declared = manifestResult.value.files.map(file => file.path).sort();
  const actual = Object.keys(value.files).sort();
  if (declared.length !== actual.length || declared.some((path, index) => path !== actual[index])) {
    return { ok: false, diagnostics: [diagnostic("package_file_set_mismatch", "files", "Package file map must exactly match manifest file paths.")] };
  }
  for (const declaration of manifestResult.value.files) if (declaration.mediaType === "model/gltf-binary") {
    const encoded = value.files[declaration.path];
    if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_BINARY_FILE_BYTES / 3) * 4 || !isCanonicalBase64(encoded)) {
      return { ok: false, diagnostics: [diagnostic("package_binary_encoding_invalid", `files.${declaration.path}`, "GLB file content must use bounded canonical base64 encoding.")] };
    }
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const decodedLength = encoded.length / 4 * 3 - padding;
    if (decodedLength !== declaration.byteLength) return { ok: false, diagnostics: [diagnostic("package_binary_length_mismatch", `files.${declaration.path}`, "Decoded GLB byte length must match the manifest declaration.")] };
  }
  let filesSnapshot: Record<string, unknown>;
  try {
    const serialized = canonicalJson(value.files);
    if (new TextEncoder().encode(serialized).byteLength > MAX_PACKAGE_JSON_BYTES) {
      return { ok: false, diagnostics: [diagnostic("package_budget_exceeded", "files", "Package content exceeds the version 1 aggregate byte limit.")] };
    }
    filesSnapshot = JSON.parse(serialized) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, diagnostics: [diagnostic("package_file_invalid_json", "files", error instanceof Error ? error.message : "Files must contain JSON values.")] };
  }
  const freeze = (item: unknown): unknown => {
    if (Array.isArray(item)) { item.forEach(freeze); return Object.freeze(item); }
    if (object(item)) { Object.values(item).forEach(freeze); return Object.freeze(item); }
    return item;
  };
  freeze(filesSnapshot);
  return { ok: true, value: Object.freeze({ format: "oh-agent-city-package-v1", manifest: manifestResult.value,
    files: filesSnapshot }), diagnostics: [] };
}

export const PACKAGE_V1_LIMITS = Object.freeze({ maxFiles: MAX_PACKAGE_FILES, maxJsonFileBytes: MAX_JSON_FILE_BYTES,
  maxBinaryFileBytes: MAX_BINARY_FILE_BYTES, maxPackageBytes: MAX_PACKAGE_BYTES, maxPackageJsonBytes: MAX_PACKAGE_JSON_BYTES });
