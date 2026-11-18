import type {
  Bounds3V1,
  BoundedAssetReaderV1,
  CityAppearanceRefV1,
  CityEnvironmentV1,
  CityPageV1,
  CityWorldSnapshotV4,
  DigestV1,
  StableIdV1,
  TerrainSampleV1,
  Vec3V1,
  WorldCapabilityV2,
  WorldVolumeDtoV1,
} from "@oh-agent/city-sdk/contracts";
import { sha256Bytes } from "@oh-agent/city-sdk";
import type { WorldAPIV2 } from "../api/v2";
import { GameSdkError } from "../protocol/errors";
import { deepFreeze } from "../protocol/freeze";

export type SnapshotAssetSourceV1 = Uint8Array | (() => Uint8Array | Promise<Uint8Array>);

export type SnapshotWorldOptionsV1 = Readonly<{
  terrain?: (x: number, z: number) => TerrainSampleV1 | null;
  environment?: () => CityEnvironmentV1;
  appearance?: () => CityAppearanceRefV1;
  terrainTiles?: Readonly<Record<string, SnapshotAssetSourceV1>>;
  models?: Readonly<Record<string, SnapshotAssetSourceV1>>;
  maxPageSize?: number;
}>;

const DEFAULT_PAGE_SIZE = 64;

export function createSnapshotWorldAPIV2(
  snapshot: CityWorldSnapshotV4,
  options: SnapshotWorldOptionsV1 = {},
): WorldAPIV2 {
  const maximum = clampPageSize(options.maxPageSize ?? DEFAULT_PAGE_SIZE);
  const page = <T extends { id: string }>(items: readonly T[], limit: number | undefined, cursor: string | undefined): CityPageV1<T> => {
    const size = clampPageSize(limit ?? maximum, maximum);
    const offset = readCursor(cursor, snapshot.header.snapshotDigest);
    const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const values = sorted.slice(offset, offset + size);
    const nextOffset = offset + values.length;
    return deepFreeze({
      items: values,
      ...(nextOffset < sorted.length ? { nextCursor: writeCursor(snapshot.header.snapshotDigest, nextOffset) } : {}),
    }) as CityPageV1<T>;
  };
  const limitError = (): never => {
    throw new GameSdkError("game_world_object_missing", "The requested world object is not present in this snapshot.", "prepare");
  };
  const query = <T extends { id: string }>(
    items: readonly T[],
    input: { limit: number; cursor?: string },
  ): CityPageV1<T> => page(items, input.limit, input.cursor);

  return Object.freeze({
    header: () => snapshot.header,
    capabilities: () => snapshot.header.capabilities,
    supports: (capability: WorldCapabilityV2) => snapshot.header.capabilities.includes(capability),
    roads: (input: Parameters<WorldAPIV2["roads"]>[0]) => query(snapshot.roads.filter((road) => !input.bounds || centerlineIntersects(road.centerline, input.bounds)), input),
    getRoute: (routeId: string) => {
      const route = snapshot.roads.find((candidate) => candidate.id === routeId);
      if (!route) return limitError();
      return route;
    },
    objects: (input: Parameters<WorldAPIV2["objects"]>[0]) => query(snapshot.objects.filter((object) =>
      (!input.kinds || input.kinds.includes(object.kind)) && (!input.bounds || boundsIntersect(object.bounds, input.bounds))), input),
    anchors: (input: Parameters<WorldAPIV2["anchors"]>[0]) => query(snapshot.anchors.filter((anchor) => !input.kinds || input.kinds.includes(anchor.kind)), input),
    volumes: (input: Parameters<WorldAPIV2["volumes"]>[0]) => query(snapshot.volumes.filter((volume) =>
      (!input.kinds || input.kinds.includes(volume.kind)) && (!input.bounds || boundsIntersect(volumeBounds(volume), input.bounds))), input),
    listSites: (input: Parameters<WorldAPIV2["listSites"]>[0] = {}) => page(snapshot.sites.filter((site) => !input.kind || site.kind === input.kind), input.limit, input.cursor),
    listResidents: (input: Parameters<WorldAPIV2["listResidents"]>[0] = {}) => page(snapshot.residents, input.limit, input.cursor),
    getResident: (id: string) => {
      const resident = snapshot.residents.find((candidate) => candidate.id === id);
      if (!resident) return limitError();
      return resident;
    },
    listPlaces: (input: Parameters<WorldAPIV2["listPlaces"]>[0] = {}) => page(snapshot.places.filter((place) => !input.kind || place.kind === input.kind), input.limit, input.cursor),
    terrainSample: (x: number, z: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new GameSdkError("game_argument_invalid", "Terrain coordinates must be finite.", "prepare");
      const sample = options.terrain?.(x, z);
      if (!sample) return limitError();
      return sample;
    },
    environment: () => {
      if (!options.environment) throw new GameSdkError("game_world_capability_missing", "This snapshot has no live environment provider.", "prepare");
      return options.environment();
    },
    appearance: () => {
      if (!options.appearance) throw new GameSdkError("game_world_capability_missing", "This snapshot has no appearance provider.", "prepare");
      return options.appearance();
    },
    openTerrainTile: (id: StableIdV1, expectedDigest: DigestV1) => {
      const tile = snapshot.terrain.tiles.find((candidate) => candidate.id === id);
      if (!tile || tile.assetDigest !== expectedDigest) {
        throw new GameSdkError("game_asset_invalid", "Terrain tile identity or digest does not match the snapshot.", "prepare");
      }
      const source = options.terrainTiles?.[id];
      if (!source) throw new GameSdkError("game_asset_invalid", "The terrain tile asset is unavailable.", "prepare");
      return openVerifiedAsset(expectedDigest, source);
    },
    openModel: (digest: DigestV1) => {
      const source = options.models?.[digest];
      if (!source) throw new GameSdkError("game_asset_invalid", "The model asset is unavailable for this digest.", "prepare");
      return openVerifiedAsset(digest, source);
    },
  }) as WorldAPIV2;
}

async function openVerifiedAsset(expectedDigest: DigestV1, source: SnapshotAssetSourceV1): Promise<BoundedAssetReaderV1> {
  const initial = await readSource(source);
  verifyAsset(expectedDigest, initial);
  return Object.freeze({
    digest: expectedDigest,
    byteLength: initial.byteLength,
    read: async () => {
      const current = await readSource(source);
      verifyAsset(expectedDigest, current);
      return current.slice();
    },
  });
}

async function readSource(source: SnapshotAssetSourceV1): Promise<Uint8Array> {
  const value = typeof source === "function" ? await source() : source;
  if (!(value instanceof Uint8Array)) throw new GameSdkError("game_asset_invalid", "Asset sources must return bytes.", "prepare");
  return value;
}

function verifyAsset(expected: DigestV1, bytes: Uint8Array): void {
  if (digestBytes(bytes) !== expected) throw new GameSdkError("game_package_integrity_failed", "Asset bytes changed after the digest was bound.", "prepare");
}

function digestBytes(bytes: Uint8Array): DigestV1 {
  return `sha256:${Array.from(sha256Bytes(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function clampPageSize(value: number, maximum = DEFAULT_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new GameSdkError("game_argument_invalid", "Query limit must be a positive integer.", "prepare");
  return Math.min(value, maximum);
}

function writeCursor(digest: DigestV1, offset: number): string {
  return `v1:${digest}:${offset}`;
}

function readCursor(cursor: string | undefined, digest: DigestV1): number {
  if (cursor === undefined) return 0;
  const prefix = `v1:${digest}:`;
  if (!cursor.startsWith(prefix)) throw new GameSdkError("game_argument_invalid", "The query cursor is stale or malformed.", "prepare");
  const offset = Number(cursor.slice(prefix.length));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new GameSdkError("game_argument_invalid", "The query cursor is stale or malformed.", "prepare");
  return offset;
}

function centerlineIntersects(points: readonly Vec3V1[], bounds: Bounds3V1): boolean {
  return points.some((point) => pointInside(point, bounds));
}

function pointInside(point: Vec3V1, bounds: Bounds3V1): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((point[axis] as number) < (bounds.min[axis] as number)) return false;
    if ((point[axis] as number) > (bounds.max[axis] as number)) return false;
  }
  return true;
}

function boundsIntersect(left: Bounds3V1, right: Bounds3V1): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((left.max[axis] as number) < (right.min[axis] as number)) return false;
    if ((left.min[axis] as number) > (right.max[axis] as number)) return false;
  }
  return true;
}

function volumeBounds(volume: WorldVolumeDtoV1): Bounds3V1 {
  const geometry = volume.geometry;
  switch (geometry.kind) {
    case "box": return geometry.bounds;
    case "sphere": {
      const radius = geometry.radiusMeters;
      return {
        min: [geometry.center[0] - radius, geometry.center[1] - radius, geometry.center[2] - radius],
        max: [geometry.center[0] + radius, geometry.center[1] + radius, geometry.center[2] + radius],
      };
    }
    case "convex-prism": {
      const xs = geometry.polygonXZ.map((point) => point[0]);
      const zs = geometry.polygonXZ.map((point) => point[1]);
      return {
        min: [Math.min(...xs), geometry.minY, Math.min(...zs)],
        max: [Math.max(...xs), geometry.maxY, Math.max(...zs)],
      };
    }
    case "ring": {
      const radius = geometry.outerRadiusMeters;
      const thickness = geometry.thicknessMeters / 2;
      return {
        min: geometry.center.map((value, index) => value - (geometry.normal[index] === 0 ? radius : thickness)) as unknown as Vec3V1,
        max: geometry.center.map((value, index) => value + (geometry.normal[index] === 0 ? radius : thickness)) as unknown as Vec3V1,
      };
    }
  }
}
