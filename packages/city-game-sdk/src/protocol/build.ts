import type { BuildId, DigestV1 } from "./ids";

export type CodeGameBuildV2 = Readonly<{
  schemaVersion: 2;
  kind: "code-game-build";
  buildId: BuildId;
  gameId: string;
  gameVersion: string;
  manifestSchemaVersion: 1 | 2;
  sdk: Readonly<{ name: string; apiMajor: number }>;
  entry: string;
  bundle: "game.js";
  byteLength: number;
  bundleDigest: DigestV1;
  sourceMapDigest: DigestV1;
  manifestDigest: DigestV1;
  assetDigests: Readonly<Record<string, DigestV1>>;
  contentDigest: DigestV1;
  sourceRevision: string;
  sdkVersion: string;
  toolchainVersion: string;
  bundler: string;
}>;
