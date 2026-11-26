import type { GameDiagnosticV1 } from "./diagnostics";
import { deepFreeze } from "./freeze";
import {
  GAME_PERMISSIONS_V1,
  WORLD_CAPABILITIES_V1,
  isGamePermission,
  isWorldCapability,
  type GamePermissionV1,
  type WorldCapabilityV1,
} from "./permissions";
import type { ResultV1 } from "./result";
import {
  CITY_GAME_SDK_API_MAJOR,
  CITY_GAME_SDK_PACKAGE,
  CODE_GAME_KIND,
  CODE_GAME_MANIFEST_SCHEMA_VERSION,
} from "./version";

export type CodeGameAssetV1 = Readonly<{
  id: string;
  path: string;
  type: "model/glb" | "audio";
}>;

export type CodeGameManifestV1 = Readonly<{
  schemaVersion: 1;
  kind: "code-game";
  gameId: string;
  displayName: string;
  version: string;
  entry: string;
  sdk: Readonly<{ name: typeof CITY_GAME_SDK_PACKAGE; apiMajor: 1 }>;
  world: Readonly<{
    requiredCapabilities: readonly WorldCapabilityV1[];
    layoutId?: string;
  }>;
  permissions: readonly GamePermissionV1[];
  limits: Readonly<{ maxEntities: number; maxProjectiles: number }>;
  assets: readonly CodeGameAssetV1[];
}>;

const GAME_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LAYOUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCRIPT_ENTRY = /\.(?:ts|tsx|js|mjs)$/;
const MODEL_PATH = /\.glb$/;
const AUDIO_PATH = /\.(?:mp3|ogg|wav|m4a)$/;

const TOP_KEYS = [
  "schemaVersion",
  "kind",
  "gameId",
  "displayName",
  "version",
  "entry",
  "sdk",
  "world",
  "permissions",
  "limits",
  "assets",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Workspace-relative paths only. This is the manifest-side half of the path
 * policy: the build service resolves files through the workspace root and must
 * never accept an absolute path, a drive letter, a backslash or `..` — the
 * previous Creator code already refuses absolute paths, and a Code Game build
 * would otherwise be the first place traversal could reach the host filesystem.
 */
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
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    diagnostics.push(invalid(field, "Path must not contain empty, '.' or '..' segments."));
    return false;
  }
  return true;
}

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

/**
 * Validates the *content contract*, not the game's behaviour: schema shape,
 * version pins, permission/capability consistency, budgets and asset paths.
 * A valid manifest proves nothing about the bundle — the host still validates
 * the exported definition and every runtime call.
 */
export function validateCodeGameManifestV1(input: unknown): ResultV1<CodeGameManifestV1> {
  const diagnostics: GameDiagnosticV1[] = [];
  if (!isRecord(input)) {
    diagnostics.push(invalid("$", "Manifest must be a JSON object."));
    return { ok: false, diagnostics: Object.freeze(diagnostics) };
  }

  checkExactKeys(input, TOP_KEYS, TOP_KEYS, "$", diagnostics);

  // Bind narrowed views once. Property narrowing on a Record<string, unknown>
  // does not survive every intervening call, and re-narrowing at each use is
  // how `any` casts creep into a validator.
  const sdkInput = isRecord(input.sdk) ? input.sdk : null;
  const worldInput = isRecord(input.world) ? input.world : null;
  const limitsInput = isRecord(input.limits) ? input.limits : null;
  const permissionsInput = Array.isArray(input.permissions) ? input.permissions : null;
  const assetsInput = Array.isArray(input.assets) ? input.assets : null;

  if (input.schemaVersion !== CODE_GAME_MANIFEST_SCHEMA_VERSION) {
    diagnostics.push(
      Object.freeze({
        code: "game_manifest_unsupported" as const,
        severity: "error" as const,
        stage: "static" as const,
        message: `$.schemaVersion: only schema version ${CODE_GAME_MANIFEST_SCHEMA_VERSION} is supported.`,
      }),
    );
  }
  if (input.kind !== CODE_GAME_KIND) {
    diagnostics.push(invalid("$.kind", `Manifest kind must be "${CODE_GAME_KIND}".`));
  }
  if (typeof input.gameId !== "string" || !GAME_ID.test(input.gameId)) {
    diagnostics.push(invalid("$.gameId", "Game id must be a lower-case stable identifier (3..128 chars)."));
  }
  if (
    typeof input.displayName !== "string" ||
    input.displayName.length === 0 ||
    input.displayName.length > 80
  ) {
    diagnostics.push(invalid("$.displayName", "Display name must be 1..80 characters."));
  }
  if (typeof input.version !== "string" || !SEMVER.test(input.version)) {
    diagnostics.push(invalid("$.version", "Version must be a semantic version such as 0.1.0."));
  }
  if (checkRelativePath(input.entry, "$.entry", diagnostics) && typeof input.entry === "string") {
    if (!SCRIPT_ENTRY.test(input.entry)) {
      diagnostics.push(invalid("$.entry", "Entry must be a .ts, .tsx, .js or .mjs file."));
    }
  }

  if (sdkInput === null) {
    diagnostics.push(invalid("$.sdk", "SDK pin must be an object."));
  } else {
    checkExactKeys(sdkInput, ["name", "apiMajor"], ["name", "apiMajor"], "$.sdk", diagnostics);
    if (sdkInput.name !== CITY_GAME_SDK_PACKAGE) {
      diagnostics.push(invalid("$.sdk.name", `SDK name must be "${CITY_GAME_SDK_PACKAGE}".`));
    }
    if (sdkInput.apiMajor !== CITY_GAME_SDK_API_MAJOR) {
      diagnostics.push(
        Object.freeze({
          code: "game_manifest_unsupported" as const,
          severity: "error" as const,
          stage: "static" as const,
          message: `$.sdk.apiMajor: only API major ${CITY_GAME_SDK_API_MAJOR} is supported.`,
        }),
      );
    }
  }

  const capabilities: WorldCapabilityV1[] = [];
  if (worldInput === null) {
    diagnostics.push(invalid("$.world", "World binding must be an object."));
  } else {
    checkExactKeys(
      worldInput,
      ["requiredCapabilities", "layoutId"],
      ["requiredCapabilities"],
      "$.world",
      diagnostics,
    );
    const raw = worldInput.requiredCapabilities;
    if (!Array.isArray(raw) || raw.length > 8) {
      diagnostics.push(invalid("$.world.requiredCapabilities", "Must be an array of at most 8 capabilities."));
    } else {
      for (const [index, item] of raw.entries()) {
        const field = `$.world.requiredCapabilities[${index}]`;
        if (!isWorldCapability(item)) {
          diagnostics.push(invalid(field, `Unknown capability; expected one of ${WORLD_CAPABILITIES_V1.join(", ")}.`));
        } else if (capabilities.includes(item)) {
          diagnostics.push(invalid(field, "Duplicate capability."));
        } else {
          capabilities.push(item);
        }
      }
    }
    if (worldInput.layoutId !== undefined) {
      if (typeof worldInput.layoutId !== "string" || !LAYOUT_ID.test(worldInput.layoutId)) {
        diagnostics.push(invalid("$.world.layoutId", "Layout id must be a stable identifier."));
      }
    }
  }

  const permissions: GamePermissionV1[] = [];
  if (permissionsInput === null || permissionsInput.length === 0 || permissionsInput.length > 16) {
    diagnostics.push(invalid("$.permissions", "Permissions must be an array of 1..16 grants."));
  } else {
    for (const [index, item] of permissionsInput.entries()) {
      const field = `$.permissions[${index}]`;
      if (!isGamePermission(item)) {
        diagnostics.push(invalid(field, `Unknown permission; expected one of ${GAME_PERMISSIONS_V1.join(", ")}.`));
      } else if (permissions.includes(item)) {
        diagnostics.push(invalid(field, "Duplicate permission."));
      } else {
        permissions.push(item);
      }
    }
  }
  for (const capability of capabilities) {
    if (!permissions.includes(capability)) {
      diagnostics.push(
        invalid(
          "$.permissions",
          `Required world capability "${capability}" is not granted. A capability the game needs must appear in permissions.`,
        ),
      );
    }
  }

  let maxEntities = 0;
  let maxProjectiles = 0;
  if (limitsInput === null) {
    diagnostics.push(invalid("$.limits", "Limits must be an object."));
  } else {
    checkExactKeys(
      limitsInput,
      ["maxEntities", "maxProjectiles"],
      ["maxEntities", "maxProjectiles"],
      "$.limits",
      diagnostics,
    );
    const entities = limitsInput.maxEntities;
    if (typeof entities !== "number" || !Number.isSafeInteger(entities) || entities < 1 || entities > 1024) {
      diagnostics.push(invalid("$.limits.maxEntities", "Must be an integer from 1 to 1024."));
    } else {
      maxEntities = entities;
    }
    const projectiles = limitsInput.maxProjectiles;
    if (
      typeof projectiles !== "number" ||
      !Number.isSafeInteger(projectiles) ||
      projectiles < 0 ||
      projectiles > 1024
    ) {
      diagnostics.push(invalid("$.limits.maxProjectiles", "Must be an integer from 0 to 1024."));
    } else {
      maxProjectiles = projectiles;
    }
  }

  const assets: CodeGameAssetV1[] = [];
  if (assetsInput === null || assetsInput.length > 64) {
    diagnostics.push(invalid("$.assets", "Assets must be an array of at most 64 entries."));
  } else {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, item] of assetsInput.entries()) {
      const field = `$.assets[${index}]`;
      if (!isRecord(item)) {
        diagnostics.push(invalid(field, "Asset must be an object."));
        continue;
      }
      checkExactKeys(item, ["id", "path", "type"], ["id", "path", "type"], field, diagnostics);
      const id = item.id;
      const assetPath = item.path;
      const type = item.type;
      let usable = true;
      if (typeof id !== "string" || !ASSET_ID.test(id)) {
        diagnostics.push(invalid(`${field}.id`, "Asset id must be a lower-case stable identifier (max 64 chars)."));
        usable = false;
      } else if (ids.has(id)) {
        diagnostics.push(invalid(`${field}.id`, "Duplicate asset id."));
        usable = false;
      } else {
        ids.add(id);
      }
      if (type !== "model/glb" && type !== "audio") {
        diagnostics.push(invalid(`${field}.type`, 'Asset type must be "model/glb" or "audio".'));
        usable = false;
      }
      if (checkRelativePath(assetPath, `${field}.path`, diagnostics) && typeof assetPath === "string") {
        if (paths.has(assetPath)) {
          diagnostics.push(invalid(`${field}.path`, "Duplicate asset path."));
          usable = false;
        } else {
          paths.add(assetPath);
        }
        if (type === "model/glb" && !MODEL_PATH.test(assetPath)) {
          diagnostics.push(invalid(`${field}.path`, 'A "model/glb" asset must end with .glb.'));
          usable = false;
        }
        if (type === "audio" && !AUDIO_PATH.test(assetPath)) {
          diagnostics.push(invalid(`${field}.path`, 'An "audio" asset must end with .mp3, .ogg, .wav or .m4a.'));
          usable = false;
        }
      } else {
        usable = false;
      }
      if (usable && typeof id === "string" && typeof assetPath === "string" && (type === "model/glb" || type === "audio")) {
        assets.push({ id, path: assetPath, type });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze(diagnostics) };

  const value: CodeGameManifestV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: CODE_GAME_KIND,
    gameId: input.gameId as string,
    displayName: input.displayName as string,
    version: input.version as string,
    entry: input.entry as string,
    sdk: { name: CITY_GAME_SDK_PACKAGE, apiMajor: 1 as const },
    world: {
      requiredCapabilities: [...capabilities],
      ...(worldInput !== null && typeof worldInput.layoutId === "string" ? { layoutId: worldInput.layoutId } : {}),
    },
    permissions: [...permissions],
    limits: { maxEntities, maxProjectiles },
    assets: assets.map((asset) => ({ ...asset })),
  });
  return { ok: true, value, diagnostics: Object.freeze([]) };
}
