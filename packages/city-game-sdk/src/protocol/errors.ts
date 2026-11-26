import type {
  GameDiagnosticCodeV1,
  GameDiagnosticStageV1,
  GameDiagnosticV1,
} from "./diagnostics";

const MAX_MESSAGE = 300;

/** Messages cross into MCP and a UI; keep them boring and bounded. */
export function boundMessage(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_MESSAGE ? `${single.slice(0, MAX_MESSAGE - 1)}…` : single;
}

/**
 * Every host rejection is a typed error, never a bare string or an Error with a
 * message. MCP maps `code` to an Agent-facing action, so a throw site that
 * invents a code is a contract break.
 */
export class GameSdkError extends Error {
  readonly code: GameDiagnosticCodeV1;
  readonly stage: GameDiagnosticStageV1;
  readonly suggestion?: string;

  constructor(
    code: GameDiagnosticCodeV1,
    message: string,
    stage: GameDiagnosticStageV1 = "runtime",
    suggestion?: string,
  ) {
    super(boundMessage(message));
    this.name = "GameSdkError";
    this.code = code;
    this.stage = stage;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }

  toDiagnostic(runId?: string): GameDiagnosticV1 {
    return Object.freeze({
      code: this.code,
      severity: "error" as const,
      stage: this.stage,
      message: boundMessage(this),
      ...(runId !== undefined ? { runId } : {}),
      ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
    });
  }
}

export function asGameSdkError(
  error: unknown,
  fallback: GameDiagnosticCodeV1 = "game_runtime_fault",
  stage: GameDiagnosticStageV1 = "runtime",
): GameSdkError {
  return error instanceof GameSdkError ? error : new GameSdkError(fallback, boundMessage(error), stage);
}
