/** Stable runtime-registry errors. Codes are part of the SDK contract. */
export type GameRuntimeErrorCodeV1 =
  | "game_type_invalid"
  | "game_type_duplicate"
  | "game_type_unknown"
  | "game_type_version_mismatch"
  | "game_runtime_invalid";

export class GameRuntimeError extends Error {
  constructor(readonly code: GameRuntimeErrorCodeV1, message: string) {
    super(message);
    this.name = "GameRuntimeError";
  }
}
