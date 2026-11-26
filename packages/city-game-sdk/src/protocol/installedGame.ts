import type { CodeGameBuildV2 } from "./build";
import { deepFreeze } from "./freeze";
import type { BuildId, DigestV1 } from "./ids";
import type { CodeGameManifest } from "./manifestV2";
import type { CodeGamePresentationV2 } from "./manifestV2";

export type InstalledGameEntryV1 = Readonly<{
  id: string;
  presentations: readonly CodeGamePresentationV2[];
}>;

export type InstalledGameV1 = Readonly<{
  installationId: string;
  gameId: string;
  gameVersion: string;
  kind: "declarative" | "legacy-runtime" | "code";
  buildId?: BuildId;
  contentDigest: DigestV1;
  manifestDigest?: DigestV1;
  trustLevel: "legacy" | "local-trusted" | "signed-community";
  status: "installed" | "disabled" | "revoked";
  entries: readonly InstalledGameEntryV1[];
}>;

export function createInstalledGameFromCodeBuild(
  installationId: string,
  build: CodeGameBuildV2,
  manifest: CodeGameManifest,
  trustLevel: InstalledGameV1["trustLevel"] = "local-trusted",
): InstalledGameV1 {
  const entries: InstalledGameEntryV1[] =
    manifest.schemaVersion === 1
      ? [{ id: "default", presentations: ["exclusive"] }]
      : manifest.entries.map((entry) => ({ id: entry.id, presentations: [...entry.presentation] }));
  return deepFreeze({
    installationId,
    gameId: manifest.gameId,
    gameVersion: manifest.version,
    kind: "code" as const,
    buildId: build.buildId,
    contentDigest: build.contentDigest,
    manifestDigest: build.manifestDigest,
    trustLevel,
    status: "installed" as const,
    entries,
  });
}
