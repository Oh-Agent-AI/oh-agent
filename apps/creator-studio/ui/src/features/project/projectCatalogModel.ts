import { CREATOR_TEMPLATES_V1 } from "@oh-agent/city-sdk";
import type { CityRow, ProjectRow } from "../../contracts/creatorStudio";
import type { StoryProjectRow } from "../library/cityGameLibraryModel";

export type CatalogKind = "all" | "game" | "story" | "city";

export type CatalogEntry = Readonly<{
  kind: Exclude<CatalogKind, "all">;
  id: string;
  name: string;
  revision: number;
  updatedAtMs?: number;
  version?: string;
  summary?: string;
  biome?: CityRow["biome"];
  templateId?: string;
  templateLabel?: string;
}>;

export const catalogLabels = { all: "全部作品", game: "Game 项目", story: "Story 项目", city: "City 实例" } as const;

const templateSummaries: Readonly<Record<string, string>> = {
  "checkpoint-race": "驾驶车辆，在时限内依次通过检查点。",
  "collect-one": "驾驶车辆，抵达目标区域并完成收集。",
  "flight-checkpoint": "驾驶飞行器，在时限内穿越空中检查点。",
  "ornithopter-flight": "操控扑翼飞行器，依次穿越空中检查点。",
};

const citySummaries = {
  tropical: "热带海岸与岛屿",
  arid: "沙漠与沙丘地形",
};

export function catalogEntries(projects: readonly ProjectRow[], stories: readonly StoryProjectRow[], cities: readonly CityRow[]): CatalogEntry[] {
  return [
    ...projects.map(({ projectId, title, revision, updatedAtMs, gameDefinitionId }) => {
      const template = CREATOR_TEMPLATES_V1.find(item => item.pack.id === gameDefinitionId);
      return { kind: "game" as const, id: projectId, name: title, revision, updatedAtMs,
        templateId: template?.id, templateLabel: template?.label, summary: template ? templateSummaries[template.id] : undefined };
    }),
    ...stories.map(({ storyId, title, revision, updatedAtMs, storyVersion, nodeCount }) => ({
      kind: "story" as const, id: storyId, name: title, revision, updatedAtMs: updatedAtMs ?? undefined, version: storyVersion,
      summary: nodeCount === null ? undefined : `${nodeCount} 个剧情节点`,
    })),
    ...cities.map(({ cityId, name, revision, biome }) => ({
      kind: "city" as const, id: cityId, name, revision, biome,
      summary: biome === "arid" || biome === "tropical" ? citySummaries[biome] : undefined,
    })),
  ];
}

export const catalogKey = (entry: CatalogEntry) => `${entry.kind}:${entry.id}`;

export function visibleCatalogEntries(entries: readonly CatalogEntry[], kind: CatalogKind, search: string, sort: "recent" | "name"): CatalogEntry[] {
  const query = search.trim().toLocaleLowerCase("zh-CN");
  return entries
    .filter(entry => (kind === "all" ? entry.kind !== "city" : entry.kind === kind) && entry.name.toLocaleLowerCase("zh-CN").includes(query))
    .sort((a, b) => (sort === "recent" ? (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0) : 0)
      || a.name.localeCompare(b.name, "zh-CN") || catalogKey(a).localeCompare(catalogKey(b)));
}
