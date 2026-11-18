import type { GameDiagnosticV1 } from "./diagnostics";
import { GameSdkError } from "./errors";
import { deepFreeze } from "./freeze";
import {
  validateCodeGameManifestV1,
  type CodeGameAssetV1,
  type CodeGameManifestV1,
} from "./manifest";
import {
  GAME_PERMISSIONS_V2,
  V1_CAPABILITY_MAP_V2,
  WORLD_CAPABILITIES_V2,
  isGamePermissionV2,
  isWorldCapabilityV2,
  permissionForCapabilityV2,
  type GamePermissionV2,
  type WorldCapabilityV2,
} from "./permissions";
import type { ResultV1 } from "./result";
import { CITY_GAME_SDK_PACKAGE, CODE_GAME_KIND } from "./version";

export const CITY_SDK_PACKAGE = "@oh-agent/city-sdk";

export type CodeGameAssetV2 = CodeGameAssetV1;
export type CodeGamePresentationV2 = "overlay" | "exclusive";

export type CodeGameEntryV2 = Readonly<{
  id: string;
  export: string;
  presentation: readonly CodeGamePresentationV2[];
}>;

export type CodeGameManifestV2 = Readonly<{
  schemaVersion: 2;
  kind: "code-game";
  gameId: string;
  displayName: string;
  version: string;
  entry: string;
  sdk: Readonly<{ name: typeof CITY_GAME_SDK_PACKAGE; apiMajor: 2 }>;
  citySdk: Readonly<{ name: typeof CITY_SDK_PACKAGE; schemaMajor: 2 }>;
  world: Readonly<{
    requiredCapabilities: readonly WorldCapabilityV2[];
    compatibleBiomes?: readonly string[];
    minSnapshotSchema?: number;
    binding: "capability-based";
  }>;
  render: Readonly<{
    compatibleProfiles: readonly string[];
    preferredProfile?: string;
  }>;
  presentation: Readonly<{
    supported: readonly CodeGamePresentationV2[];
    default: CodeGamePresentationV2;
  }>;
  permissions: readonly GamePermissionV2[];
  entries: readonly CodeGameEntryV2[];
  limits: Readonly<{ maxEntities: number; maxProjectiles: number }>;
  assets: readonly CodeGameAssetV2[];
}>;

export type CodeGameManifest = CodeGameManifestV1 | CodeGameManifestV2;

const TOP_KEYS = [
  "schemaVersion",
  "kind",
  "gameId",
  "displayName",
  "version",
  "entry",
  "sdk",
  "citySdk",
  "world",
  "render",
  "presentation",
  "permissions",
  "entries",
  "limits",
  "assets",
] as const;
const GAME_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCRIPT_ENTRY = /\.(?:ts|tsx|js|mjs)$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MODEL_PATH = /\.glb$/;
const AUDIO_PATH = /\.(?:mp3|ogg|wav|m4a)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (field: string, message: string): GameDiagnosticV1 =>
  Object.freeze({
    code: "game_manifest_invalid" as const,
    severity: "error" as const,
    stage: "static" as const,
    message: `${field}: ${message}`,
  });

function checkExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
  diagnostics: GameDiagnosticV1[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) diagnostics.push(invalid(`${field}.${key}`, "Unsupported field."));
  }
  for (const key of required) {
    if (!(key in value)) diagnostics.push(invalid(`${field}.${key}`, "Missing required field."));
  }
}

function checkRelativePath(value: unknown, field: string, diagnostics: GameDiagnosticV1[]): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    diagnostics.push(invalid(field, "Path must be a non-empty string of at most 200 characters."));
    return false;
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes(":")) {
    diagnostics.push(invalid(field, "Path must be workspace-relative and must not contain a drive or scheme."));
    return false;
  }
  if (/[\u0000-\u001f]/.test(value)) {
    diagnostics.push(invalid(field, "Path must not contain control characters."));
    return false;
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    diagnostics.push(invalid(field, "Path must not contain empty, '.' or '..' segments."));
    return false;
  }
  return true;
}

function checkStringList(
  value: unknown,
  field: string,
  maximum: number,
  diagnostics: GameDiagnosticV1[],
  minimum = 0,
): string[] {
  const result: string[] = [];
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    diagnostics.push(invalid(field, `Must be an array of ${minimum}..${maximum} strings.`));
    return result;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !STABLE_ID.test(item)) {
      diagnostics.push(invalid(`${field}[${index}]`, "Must be a lower-case stable identifier (max 64 chars)."));
    } else if (result.includes(item)) {
      diagnostics.push(invalid(`${field}[${index}]`, "Duplicate value."));
    } else {
      result.push(item);
    }
  }
  return result;
}

function checkPresentationList(
  value: unknown,
  field: string,
  diagnostics: GameDiagnosticV1[],
): CodeGamePresentationV2[] {
  const result: CodeGamePresentationV2[] = [];
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    diagnostics.push(invalid(field, "Must contain one or both presentation modes."));
    return result;
  }
  for (const [index, item] of value.entries()) {
    if (item !== "overlay" && item !== "exclusive") {
      diagnostics.push(invalid(`${field}[${index}]`, 'Must be "overlay" or "exclusive".'));
    } else if (result.includes(item)) {
      diagnostics.push(invalid(`${field}[${index}]`, "Duplicate presentation mode."));
    } else {
      result.push(item);
    }
  }
  return result;
}

export function validateCodeGameManifestV2(input: unknown): ResultV1<CodeGameManifestV2> {
  const diagnostics: GameDiagnosticV1[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: Object.freeze([invalid("$", "Manifest must be a JSON object.")]) };
  }
  checkExactKeys(input, TOP_KEYS, TOP_KEYS, "$", diagnostics);

  if (input.schemaVersion !== 2) {
    diagnostics.push(
      Object.freeze({
        code: "game_manifest_unsupported" as const,
        severity: "error" as const,
        stage: "static" as const,
        message: "$.schemaVersion: only schema version 2 is supported by this validator.",
      }),
    );
  }
  if (input.kind !== CODE_GAME_KIND) diagnostics.push(invalid("$.kind", 'Manifest kind must be "code-game".'));
  if (typeof input.gameId !== "string" || !GAME_ID.test(input.gameId)) {
    diagnostics.push(invalid("$.gameId", "Game id must be a lower-case stable identifier (3..128 chars)."));
  }
  if (typeof input.displayName !== "string" || input.displayName.length === 0 || input.displayName.length > 80) {
    diagnostics.push(invalid("$.displayName", "Display name must be 1..80 characters."));
  }
  if (typeof input.version !== "string" || !SEMVER.test(input.version)) {
    diagnostics.push(invalid("$.version", "Version must be a semantic version such as 0.1.0."));
  }
  if (checkRelativePath(input.entry, "$.entry", diagnostics) && typeof input.entry === "string" && !SCRIPT_ENTRY.test(input.entry)) {
    diagnostics.push(invalid("$.entry", "Entry must be a .ts, .tsx, .js or .mjs file."));
  }

  const sdkInput = isRecord(input.sdk) ? input.sdk : null;
  if (sdkInput === null) {
    diagnostics.push(invalid("$.sdk", "SDK pin must be an object."));
  } else {
    checkExactKeys(sdkInput, ["name", "apiMajor"], ["name", "apiMajor"], "$.sdk", diagnostics);
    if (sdkInput.name !== CITY_GAME_SDK_PACKAGE) {
      diagnostics.push(invalid("$.sdk.name", `SDK name must be "${CITY_GAME_SDK_PACKAGE}".`));
    }
    if (sdkInput.apiMajor !== 2) {
      diagnostics.push(
        Object.freeze({
          code: "game_manifest_unsupported" as const,
          severity: "error" as const,
          stage: "static" as const,
          message: "$.sdk.apiMajor: only API major 2 is supported by this validator.",
        }),
      );
    }
  }

  const citySdkInput = isRecord(input.citySdk) ? input.citySdk : null;
  if (citySdkInput === null) {
    diagnostics.push(invalid("$.citySdk", "City SDK pin must be an object."));
  } else {
    checkExactKeys(citySdkInput, ["name", "schemaMajor"], ["name", "schemaMajor"], "$.citySdk", diagnostics);
    if (citySdkInput.name !== CITY_SDK_PACKAGE) {
      diagnostics.push(invalid("$.citySdk.name", `City SDK name must be "${CITY_SDK_PACKAGE}".`));
    }
    if (citySdkInput.schemaMajor !== 2) {
      diagnostics.push(
        Object.freeze({
          code: "game_manifest_unsupported" as const,
          severity: "error" as const,
          stage: "static" as const,
          message: "$.citySdk.schemaMajor: only City schema major 2 is supported by this validator.",
        }),
      );
    }
  }

  const capabilities: WorldCapabilityV2[] = [];
  const worldInput = isRecord(input.world) ? input.world : null;
  let compatibleBiomes: string[] | undefined;
  let minSnapshotSchema: number | undefined;
  if (worldInput === null) {
    diagnostics.push(invalid("$.world", "World binding must be an object."));
  } else {
    checkExactKeys(
      worldInput,
      ["requiredCapabilities", "compatibleBiomes", "minSnapshotSchema", "binding"],
      ["requiredCapabilities", "binding"],
      "$.world",
      diagnostics,
    );
    const raw = worldInput.requiredCapabilities;
    if (!Array.isArray(raw) || raw.length > WORLD_CAPABILITIES_V2.length) {
      diagnostics.push(invalid("$.world.requiredCapabilities", "Must be a bounded array of City capabilities."));
    } else {
      for (const [index, item] of raw.entries()) {
        const field = `$.world.requiredCapabilities[${index}]`;
        if (!isWorldCapabilityV2(item)) {
          diagnostics.push(invalid(field, `Unknown capability; expected one of ${WORLD_CAPABILITIES_V2.join(", ")}.`));
        } else if (capabilities.includes(item)) {
          diagnostics.push(invalid(field, "Duplicate capability."));
        } else {
          capabilities.push(item);
        }
      }
    }
    if (worldInput.binding !== "capability-based") {
      diagnostics.push(invalid("$.world.binding", 'World binding must be "capability-based".'));
    }
    if (worldInput.compatibleBiomes !== undefined) {
      compatibleBiomes = checkStringList(worldInput.compatibleBiomes, "$.world.compatibleBiomes", 32, diagnostics);
    }
    if (worldInput.minSnapshotSchema !== undefined) {
      const value = worldInput.minSnapshotSchema;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        diagnostics.push(invalid("$.world.minSnapshotSchema", "Must be a positive integer."));
      } else {
        minSnapshotSchema = value;
      }
    }
  }

  const renderInput = isRecord(input.render) ? input.render : null;
  let compatibleProfiles: string[] = [];
  let preferredProfile: string | undefined;
  if (renderInput === null) {
    diagnostics.push(invalid("$.render", "Render compatibility must be an object."));
  } else {
    checkExactKeys(
      renderInput,
      ["compatibleProfiles", "preferredProfile"],
      ["compatibleProfiles"],
      "$.render",
      diagnostics,
    );
    compatibleProfiles = checkStringList(renderInput.compatibleProfiles, "$.render.compatibleProfiles", 16, diagnostics);
    if (renderInput.preferredProfile !== undefined) {
      if (typeof renderInput.preferredProfile !== "string" || !STABLE_ID.test(renderInput.preferredProfile)) {
        diagnostics.push(invalid("$.render.preferredProfile", "Must be a lower-case stable identifier."));
      } else {
        preferredProfile = renderInput.preferredProfile;
        if (!compatibleProfiles.includes(preferredProfile)) {
          diagnostics.push(invalid("$.render.preferredProfile", "Preferred profile must also be compatible."));
        }
      }
    }
  }

  const presentationInput = isRecord(input.presentation) ? input.presentation : null;
  let supported: CodeGamePresentationV2[] = [];
  let defaultPresentation: CodeGamePresentationV2 = "exclusive";
  if (presentationInput === null) {
    diagnostics.push(invalid("$.presentation", "Presentation must be an object."));
  } else {
    checkExactKeys(presentationInput, ["supported", "default"], ["supported", "default"], "$.presentation", diagnostics);
    supported = checkPresentationList(presentationInput.supported, "$.presentation.supported", diagnostics);
    if (presentationInput.default !== "overlay" && presentationInput.default !== "exclusive") {
      diagnostics.push(invalid("$.presentation.default", 'Must be "overlay" or "exclusive".'));
    } else {
      defaultPresentation = presentationInput.default;
      if (!supported.includes(defaultPresentation)) {
        diagnostics.push(invalid("$.presentation.default", "Default presentation must be supported."));
      }
    }
  }

  const permissions: GamePermissionV2[] = [];
  if (!Array.isArray(input.permissions) || input.permissions.length < 1 || input.permissions.length > GAME_PERMISSIONS_V2.length) {
    diagnostics.push(invalid("$.permissions", "Permissions must be a bounded, non-empty array of requests."));
  } else {
    for (const [index, item] of input.permissions.entries()) {
      const field = `$.permissions[${index}]`;
      if (!isGamePermissionV2(item)) {
        diagnostics.push(invalid(field, `Unknown permission; expected one of ${GAME_PERMISSIONS_V2.join(", ")}.`));
      } else if (permissions.includes(item)) {
        diagnostics.push(invalid(field, "Duplicate permission."));
      } else {
        permissions.push(item);
      }
    }
  }
  for (const capability of capabilities) {
    const permission = permissionForCapabilityV2(capability);
    if (!permissions.includes(permission)) {
      diagnostics.push(
        invalid(
          "$.permissions",
          `Required City capability "${capability}" also needs the "${permission}" permission request.`,
        ),
      );
    }
  }

  const entries: CodeGameEntryV2[] = [];
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 32) {
    diagnostics.push(invalid("$.entries", "Entries must be an array of 1..32 registered exports."));
  } else {
    const ids = new Set<string>();
    for (const [index, item] of input.entries.entries()) {
      const field = `$.entries[${index}]`;
      if (!isRecord(item)) {
        diagnostics.push(invalid(field, "Entry must be an object."));
        continue;
      }
      checkExactKeys(item, ["id", "export", "presentation"], ["id", "export", "presentation"], field, diagnostics);
      let usable = true;
      if (typeof item.id !== "string" || !STABLE_ID.test(item.id)) {
        diagnostics.push(invalid(`${field}.id`, "Entry id must be a lower-case stable identifier (max 64 chars)."));
        usable = false;
      } else if (ids.has(item.id)) {
        diagnostics.push(invalid(`${field}.id`, "Duplicate entry id."));
        usable = false;
      } else {
        ids.add(item.id);
      }
      if (typeof item.export !== "string" || !EXPORT_NAME.test(item.export)) {
        diagnostics.push(invalid(`${field}.export`, "Entry export must be a JavaScript identifier or default."));
        usable = false;
      }
      const entryPresentations = checkPresentationList(item.presentation, `${field}.presentation`, diagnostics);
      for (const presentation of entryPresentations) {
        if (!supported.includes(presentation)) {
          diagnostics.push(invalid(`${field}.presentation`, `Presentation "${presentation}" is not globally supported.`));
          usable = false;
        }
      }
      if (usable && typeof item.id === "string" && typeof item.export === "string") {
        entries.push({ id: item.id, export: item.export, presentation: entryPresentations });
      }
    }
  }

  const limitsInput = isRecord(input.limits) ? input.limits : null;
  let maxEntities = 0;
  let maxProjectiles = 0;
  if (limitsInput === null) {
    diagnostics.push(invalid("$.limits", "Limits must be an object."));
  } else {
    checkExactKeys(limitsInput, ["maxEntities", "maxProjectiles"], ["maxEntities", "maxProjectiles"], "$.limits", diagnostics);
    if (
      typeof limitsInput.maxEntities !== "number" ||
      !Number.isSafeInteger(limitsInput.maxEntities) ||
      limitsInput.maxEntities < 1 ||
      limitsInput.maxEntities > 1024
    ) {
      diagnostics.push(invalid("$.limits.maxEntities", "Must be an integer from 1 to 1024."));
    } else {
      maxEntities = limitsInput.maxEntities;
    }
    if (
      typeof limitsInput.maxProjectiles !== "number" ||
      !Number.isSafeInteger(limitsInput.maxProjectiles) ||
      limitsInput.maxProjectiles < 0 ||
      limitsInput.maxProjectiles > 1024
    ) {
      diagnostics.push(invalid("$.limits.maxProjectiles", "Must be an integer from 0 to 1024."));
    } else {
      maxProjectiles = limitsInput.maxProjectiles;
    }
  }

  const assets: CodeGameAssetV2[] = [];
  if (!Array.isArray(input.assets) || input.assets.length > 64) {
    diagnostics.push(invalid("$.assets", "Assets must be an array of at most 64 entries."));
  } else {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, item] of input.assets.entries()) {
      const field = `$.assets[${index}]`;
      if (!isRecord(item)) {
        diagnostics.push(invalid(field, "Asset must be an object."));
        continue;
      }
      checkExactKeys(item, ["id", "path", "type"], ["id", "path", "type"], field, diagnostics);
      let usable = true;
      if (typeof item.id !== "string" || !STABLE_ID.test(item.id)) {
        diagnostics.push(invalid(`${field}.id`, "Asset id must be a lower-case stable identifier (max 64 chars)."));
        usable = false;
      } else if (ids.has(item.id)) {
        diagnostics.push(invalid(`${field}.id`, "Duplicate asset id."));
        usable = false;
      } else {
        ids.add(item.id);
      }
      if (item.type !== "model/glb" && item.type !== "audio") {
        diagnostics.push(invalid(`${field}.type`, 'Asset type must be "model/glb" or "audio".'));
        usable = false;
      }
      if (checkRelativePath(item.path, `${field}.path`, diagnostics) && typeof item.path === "string") {
        if (paths.has(item.path)) {
          diagnostics.push(invalid(`${field}.path`, "Duplicate asset path."));
          usable = false;
        } else {
          paths.add(item.path);
        }
        if (item.type === "model/glb" && !MODEL_PATH.test(item.path)) {
          diagnostics.push(invalid(`${field}.path`, 'A "model/glb" asset must end with .glb.'));
          usable = false;
        }
        if (item.type === "audio" && !AUDIO_PATH.test(item.path)) {
          diagnostics.push(invalid(`${field}.path`, 'An "audio" asset must end with .mp3, .ogg, .wav or .m4a.'));
          usable = false;
        }
      } else {
        usable = false;
      }
      if (usable && typeof item.id === "string" && typeof item.path === "string" && (item.type === "model/glb" || item.type === "audio")) {
        assets.push({ id: item.id, path: item.path, type: item.type });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze(diagnostics) };
  const value: CodeGameManifestV2 = deepFreeze({
    schemaVersion: 2 as const,
    kind: CODE_GAME_KIND,
    gameId: input.gameId as string,
    displayName: input.displayName as string,
    version: input.version as string,
    entry: input.entry as string,
    sdk: { name: CITY_GAME_SDK_PACKAGE, apiMajor: 2 as const },
    citySdk: { name: CITY_SDK_PACKAGE, schemaMajor: 2 as const },
    world: {
      requiredCapabilities: [...capabilities],
      ...(compatibleBiomes !== undefined ? { compatibleBiomes } : {}),
      ...(minSnapshotSchema !== undefined ? { minSnapshotSchema } : {}),
      binding: "capability-based" as const,
    },
    render: {
      compatibleProfiles,
      ...(preferredProfile !== undefined ? { preferredProfile } : {}),
    },
    presentation: { supported, default: defaultPresentation },
    permissions: [...permissions],
    entries: entries.map((entry) => ({ ...entry, presentation: [...entry.presentation] })),
    limits: { maxEntities, maxProjectiles },
    assets: assets.map((asset) => ({ ...asset })),
  });
  return { ok: true, value, diagnostics: Object.freeze([]) };
}

export function validateCodeGameManifest(input: unknown): ResultV1<CodeGameManifest> {
  if (isRecord(input) && input.schemaVersion === 2) return validateCodeGameManifestV2(input);
  return validateCodeGameManifestV1(input);
}

/** V1 layout pins have no V2 capability-based equivalent and remain enforced by
 * the V1 host. This adapter maps only the shared capability/permission axes. */
export function adaptCodeGameManifestV1ToV2(manifest: CodeGameManifestV1): CodeGameManifestV2 {
  const capabilities = manifest.world.requiredCapabilities.map((capability) => V1_CAPABILITY_MAP_V2[capability]);
  return deepFreeze({
    schemaVersion: 2 as const,
    kind: CODE_GAME_KIND,
    gameId: manifest.gameId,
    displayName: manifest.displayName,
    version: manifest.version,
    entry: manifest.entry,
    sdk: { name: CITY_GAME_SDK_PACKAGE, apiMajor: 2 as const },
    citySdk: { name: CITY_SDK_PACKAGE, schemaMajor: 2 as const },
    world: { requiredCapabilities: capabilities, binding: "capability-based" as const },
    render: { compatibleProfiles: [] },
    presentation: { supported: ["exclusive" as const], default: "exclusive" as const },
    permissions: [...new Set(manifest.permissions)],
    entries: [{ id: "default", export: "default", presentation: ["exclusive" as const] }],
    limits: { ...manifest.limits },
    assets: manifest.assets.map((asset) => ({ ...asset })),
  });
}

export function resolveCodeGameEntryV2(
  manifest: CodeGameManifestV2,
  entryId = "default",
  presentation?: CodeGamePresentationV2,
): CodeGameEntryV2 {
  const entry = manifest.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    throw new GameSdkError("game_entry_invalid", `Game entry "${entryId}" is not registered.`, "prepare");
  }
  if (presentation !== undefined && !entry.presentation.includes(presentation)) {
    throw new GameSdkError(
      "game_entry_invalid",
      `Game entry "${entryId}" does not support "${presentation}" presentation.`,
      "prepare",
    );
  }
  return entry;
}
