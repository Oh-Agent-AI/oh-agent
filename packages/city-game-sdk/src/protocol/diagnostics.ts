/**
 * The stable diagnostic vocabulary. The first block is the contract from the
 * P0 spec (§9.2) and must keep its meaning; the second block was added while
 * implementing the host because the spec's list had no code for a malformed
 * manifest or a bad call argument, and inventing ad-hoc strings at throw sites
 * would make MCP error mapping guesswork.
 */
export const GAME_DIAGNOSTIC_CODES_V1 = [
  // Spec §9.2 — do not rename.
  "workspace_revision_conflict",
  "game_entry_invalid",
  "game_sdk_version_mismatch",
  "game_dependency_denied",
  "game_asset_invalid",
  "game_permission_denied",
  "game_world_revision_conflict",
  "game_activity_busy",
  "game_entity_budget_exceeded",
  "game_runtime_fault",
  "game_execution_timeout",
  "game_build_not_trusted",
  "game_package_integrity_failed",
  // P0 host additions.
  "game_manifest_invalid",
  "game_manifest_unsupported",
  "game_argument_invalid",
  "game_entity_unknown",
  "game_world_object_missing",
  "game_ui_budget_exceeded",
  "game_build_failed",
  "game_typecheck_failed",
  // V2 contract additions.
  "game_world_capability_missing",
  "game_run_cancelled",
  "game_storage_revision_conflict",
  "game_actor_remote_unavailable",
] as const;
export type GameDiagnosticCodeV1 = (typeof GAME_DIAGNOSTIC_CODES_V1)[number];

export type GameDiagnosticStageV1 =
  | "workspace"
  | "typecheck"
  | "build"
  | "static"
  | "prepare"
  | "runtime"
  | "test"
  | "publish";

export type GameDiagnosticSeverityV1 = "error" | "warning" | "info";

/**
 * `relativePath` is always workspace-relative and `message` is bounded and
 * user-readable: this DTO crosses into MCP, so an absolute path or a raw stack
 * would leak host machine state (data-serving policy, AGENTS.md).
 */
export type GameDiagnosticV1 = Readonly<{
  code: GameDiagnosticCodeV1;
  severity: GameDiagnosticSeverityV1;
  stage: GameDiagnosticStageV1;
  message: string;
  relativePath?: string;
  line?: number;
  column?: number;
  runId?: string;
  suggestion?: string;
}>;
