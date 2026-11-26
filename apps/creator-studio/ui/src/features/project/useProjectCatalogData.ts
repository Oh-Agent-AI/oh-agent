import { useEffect, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import type { Project } from "../../contracts/creatorStudio";
import { parseCodeBuilds } from "../../codeGamePreview";
import { loadStudioValueAtStartup } from "../../startupLoad";
import { parseInstallationPage, parseInstalledStories, parseStoryProjects, type InstallationRow, type StoryInstallationRow, type StoryProjectRow } from "../library/cityGameLibraryModel";
import { parseStoryDocument } from "../story/storyEditorModel";
import type { CatalogEntry } from "./projectCatalogModel";

type CatalogContent =
  | { kind: "game"; cityId: string | undefined; hasLayout: boolean; anchorCount: number | undefined; mounts: number | undefined }
  | { kind: "story"; opening: string | undefined; introduction: string | undefined; scenes: number; links: number | undefined; characters: number | undefined };

export function useCatalogContent(request: CreatorRequest, entry: CatalogEntry | undefined) {
  const { kind, id, revision } = entry ?? {};
  const [result, setResult] = useState<{ id: string; kind: "game" | "story"; revision: number; content: CatalogContent | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id || revision === undefined || (kind !== "game" && kind !== "story")) return;
    let active = true;
    const load = async (): Promise<CatalogContent> => {
      if (kind === "game") {
        const project = await request<Project>("creator.project.read", { projectId: id });
        if (project.projectId !== id || project.revision !== revision) throw new Error("catalog_project_changed");
        const anchors = project.cityLayout?.layout.anchors;
        return { kind, cityId: project.cityId, hasLayout: !!project.cityLayout, anchorCount: Array.isArray(anchors) ? anchors.length : undefined,
          mounts: Array.isArray(project.mounts) ? project.mounts.length : undefined };
      }
      const { storyId, revision: storyRevision, graph, canon } = parseStoryDocument(await request("creator.story.project.read", { storyId: id }));
      if (storyId !== id || storyRevision !== revision || !Array.isArray(graph.nodes)) throw new Error("catalog_story_changed");
      const opening = graph.nodes.find(node => node?.id === graph.start);
      const introduction = opening?.meta?.description;
      return { kind, opening: typeof opening?.title === "string" ? opening.title : undefined,
        introduction: typeof introduction === "string" ? introduction.trim().slice(0, 240) : undefined,
        scenes: graph.nodes.length, links: Array.isArray(graph.edges) ? graph.edges.length : undefined,
        characters: Array.isArray(canon.characters) ? canon.characters.length : undefined };
    };
    void load().then(content => {
      if (active) setResult({ id, kind, revision, content });
    }).catch(() => {
      if (active) setResult({ id, kind, revision, content: null });
    });
    return () => { active = false; };
  }, [request, kind, id, revision, attempt]);
  const current = result?.id === id && result?.kind === kind && result?.revision === revision ? result : null;
  return { current, retry: () => { setResult(null); setAttempt(value => value + 1); } };
}

export function useCatalogStories(request: CreatorRequest) {
  const [stories, setStories] = useState<readonly StoryProjectRow[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus("loading");
    void loadStudioValueAtStartup(() => request("creator.story.projects.list", { limit: 100 }), {
      isCancelled: () => !active,
      delay: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
    }).then(value => {
      if (!active) return;
      setStories(parseStoryProjects(value));
      setStatus("ready");
    }).catch(() => { if (active) setStatus("failed"); });
    return () => { active = false; };
  }, [request, attempt]);
  return { stories, status, retry: () => setAttempt(value => value + 1) };
}

export function useCityGameInstallations(request: CreatorRequest, cityId: string | null, revision: number | null) {
  const [result, setResult] = useState<{
    cityId: string; revision: number | null;
    rows: readonly (InstallationRow & { gameVersion: string | null; displayName: string | null })[] | null;
    installedCount: number | null;
    stories: readonly StoryInstallationRow[] | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cityId) return;
    let active = true;
    void Promise.all([
      request("creator.code.install.list", { cityId, limit: 50 }).then(parseInstallationPage).catch(() => null),
      request("creator.code.builds.list", { limit: 50 }).then(parseCodeBuilds).catch(() => []),
      request("creator.story.install.list", { cityId, limit: 50 }).then(parseInstalledStories).catch(() => null),
    ]).then(([games, builds, stories]) => {
      if (!active) return;
      const buildById = new Map(builds.map(build => [build.buildId, build]));
      setResult({ cityId, revision, installedCount: games?.installedCount ?? null, stories: stories?.filter(row => row.cityId === cityId) ?? null,
        rows: games?.installations.filter(row => row.cityId === cityId).map(row => {
          const build = buildById.get(row.buildId);
          const matchingBuild = build?.gameId === row.gameId ? build : undefined;
          return { ...row, gameVersion: matchingBuild?.gameVersion ?? null, displayName: matchingBuild?.displayName ?? null };
        }) ?? null });
    });
    return () => { active = false; };
  }, [request, cityId, revision, attempt]);
  const current = result?.cityId === cityId && result.revision === revision ? result : null;
  return { current, retry: () => { setResult(null); setAttempt(value => value + 1); } };
}
