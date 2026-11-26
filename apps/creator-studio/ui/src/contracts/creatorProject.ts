export type CreatorWorkKind = "city" | "story" | "game";

export type CreatorProjectRef = Readonly<{
  projectId: string;
  revision: number;
}>;

export type CityInstanceRef = Readonly<{
  cityId: string;
  revision: number;
}>;

export type CandidateBuildRef = Readonly<{
  buildId: string;
}>;

export type ReleaseRef = Readonly<{
  releaseId: string;
}>;

export type InstallationRef = Readonly<{
  installationId: string;
  cityId: string;
  buildId: string;
}>;

export type RunRef = Readonly<{
  runId: string;
  releaseId: string;
}>;

export function creatorWorkKindForProject(kind: string): CreatorWorkKind | null {
  return kind === "city-minigame-project" ? "game" : null;
}
