import { canonicalDigest, compileWorld, stableIdV1 } from "@oh-agent/city-sdk";
import type { CityPlaceV1, CityResidentV1, CityWorldSnapshotV4, WorldPlanV1, WorldVolumeDtoV1 } from "@oh-agent/city-sdk/contracts";
import type { CityLayout, RoadEdge } from "../../engine/cityLayout";
import type { CityLayoutSdkViewV1 } from "../../engine/sdk/cityLayoutAdapter";
import { toMeters } from "../../engine/worldScale";
import { CITY_GENERATOR_CODE_DIGEST, CITY_GENERATOR_CONTRACT_VERSION, CITY_GENERATOR_ID } from "../../engine/generatorIdentity.generated";

export type CitySnapshotOptionsV1 = Readonly<{
  cityId: string;
  cityRevision: number;
  layout: CityLayout;
  view: CityLayoutSdkViewV1;
  environment?: Readonly<{ medium: "air" | "water" | "vacuum" | "mixed"; biome: string }>;
  interactionRevision?: string;
  weatherRevision?: string;
  appearanceRevision?: string;
  renderRevision?: string;
  clockRevision?: string;
  content?: Readonly<{ places?: readonly CityPlaceV1[]; residents?: readonly CityResidentV1[] }>;
}>;

export function createCitySnapshotV4(options: CitySnapshotOptionsV1): CityWorldSnapshotV4 {
  const { layout, view } = options;
  const ground = (x: number, z: number) => toMeters(layout.terrain.height(x, z));
  const anchors = layout.roadNodes.map((node) => ({
    id: stableIdV1("anchor", node.id),
    kind: "route" as const,
    position: [toMeters(node.x), ground(node.x, node.z), toMeters(node.z)] as const,
    travelModes: ["drive" as const],
  }));
  const routes = layout.roadEdges.filter(isGroundRoad).map((edge) => ({
    id: stableIdV1("road", edge.id),
    kind: "road" as const,
    fromAnchorId: stableIdV1("anchor", edge.from),
    toAnchorId: stableIdV1("anchor", edge.to),
    bidirectional: true,
    travelModes: ["drive" as const],
    centerline: edge.points.map((point) => [toMeters(point.x), ground(point.x, point.z), toMeters(point.z)] as const),
  }));
  const layoutAnchors = view.layout.anchors ?? [];
  const zoneVolumes = createCityZoneVolumesV1(view);
  const zoneAnchors = layoutAnchors.filter((anchor) => anchor.kind === "zone").map((anchor) => {
    const geometry = view.geometry.get(anchor.geometryRef);
    const position = geometry?.positionMeters;
    if (!position) throw new Error(`Zone anchor ${anchor.id} has no geometry.`);
    return {
      id: stableIdV1("anchor", anchor.id),
      kind: "checkpoint" as const,
      position: [position.x, position.y, position.z] as const,
      ...(geometry.activationRadiusMeters === undefined ? {} : { radiusMeters: geometry.activationRadiusMeters }),
      travelModes: anchor.capabilities,
    };
  });
  const objects = (layout.blocks ?? []).map((block) => {
    const y = ground(block.x, block.z);
    const halfWidth = toMeters(block.width / 2);
    const halfDepth = toMeters(block.depth / 2);
    return {
      id: stableIdV1("object", block.id),
      kind: "block",
      transform: {
        position: [toMeters(block.x), y, toMeters(block.z)] as const,
        rotation: [0, 0, 0, 1] as const,
        scale: [1, 1, 1] as const,
      },
      bounds: {
        min: [toMeters(block.x) - halfWidth, y - 1, toMeters(block.z) - halfDepth] as const,
        max: [toMeters(block.x) + halfWidth, y + 8, toMeters(block.z) + halfDepth] as const,
      },
      collision: { kind: "box" as const },
    };
  });
  const plan: WorldPlanV1 = {
    schemaVersion: 1,
    terrain: { format: "heightfield-tiles-v1", tiles: [] },
    environment: options.environment ?? { medium: "air", biome: "miami" },
    sites: [],
    routes,
    objects,
    anchors: [...anchors, ...zoneAnchors],
    volumes: zoneVolumes,
    places: options.content?.places ?? [],
    residents: options.content?.residents ?? [],
  };
  const snapshot = compileWorld(plan, {
    cityId: options.cityId,
    cityRevision: options.cityRevision,
    seed: layout.seed,
    generator: {
      id: CITY_GENERATOR_ID,
      contractVersion: CITY_GENERATOR_CONTRACT_VERSION,
      version: String(layout.derivedNetworkVersion ?? 0),
      codeDigest: CITY_GENERATOR_CODE_DIGEST,
    },
    assetsDigest: canonicalDigest({ roadRevision: view.worldRevision, objects: objects.map((object) => object.id), terrain: "live-field" }),
    capabilities: ["world.snapshot", "roads.graph", "objects.indexed", "volumes.indexed", "places.registry", "residents.registry"],
  });
  return Object.freeze({
    ...snapshot,
    header: {
      ...snapshot.header,
      revisions: {
        ...snapshot.header.revisions,
        ...(options.interactionRevision ? { interactionRevision: options.interactionRevision } : {}),
        ...(options.weatherRevision ? { weatherRevision: options.weatherRevision } : {}),
        ...(options.appearanceRevision ? { appearanceRevision: options.appearanceRevision } : {}),
        ...(options.renderRevision ? { renderRevision: options.renderRevision } : {}),
        ...(options.clockRevision ? { clockRevision: options.clockRevision } : {}),
      },
    },
  });
}

export function createCityZoneVolumesV1(view: CityLayoutSdkViewV1): readonly WorldVolumeDtoV1[] {
  return (view.layout.anchors ?? []).filter((anchor) => anchor.kind === "zone").map((anchor) => {
    const geometry = view.geometry.get(anchor.geometryRef);
    const position = geometry?.positionMeters;
    const radius = geometry?.activationRadiusMeters;
    if (!position || radius === undefined) throw new Error(`Zone anchor ${anchor.id} has no complete geometry.`);
    const center = [position.x, position.y, position.z] as const;
    return {
      id: stableIdV1("volume", anchor.id),
      kind: "checkpoint" as const,
      geometry: geometry.facingRadians === undefined
        ? { kind: "sphere" as const, center, radiusMeters: radius }
        : {
          kind: "ring" as const,
          center,
          normal: [Math.sin(geometry.facingRadians), 0, Math.cos(geometry.facingRadians)] as const,
          innerRadiusMeters: radius,
          outerRadiusMeters: radius * 1.1,
          thicknessMeters: 1,
        },
      travelModes: anchor.capabilities,
    };
  });
}

function isGroundRoad(edge: RoadEdge): boolean {
  return edge.bridge !== true &&
    (edge.structure === undefined || edge.structure === "ground-road" || edge.structure === "ground-approach") &&
    edge.kind === "arterial" && edge.points.length >= 2;
}
