/** Stable runtime-registry errors. Codes are part of the SDK contract. */
export type GameRuntimeErrorCodeV1 =
  | "game_type_invalid"
  | "game_type_duplicate"
  | "game_type_unknown"
  | "game_type_version_mismatch"
  | "game_type_template_mismatch"
  | "game_runtime_invalid"
  | "game_installation_invalid"
  | "game_installation_not_found"
  | "game_installation_unavailable"
  | "game_package_integrity_failed"
  | "game_entry_invalid"
  | "game_presentation_unsupported"
  | "game_permission_denied"
  | "game_launch_conflict"
  | "game_world_revision_conflict";

export class GameRuntimeError extends Error {
  constructor(readonly code: GameRuntimeErrorCodeV1, message: string) {
    super(message);
    this.name = "GameRuntimeError";
  }
}
