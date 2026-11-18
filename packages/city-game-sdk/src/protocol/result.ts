import type { GameDiagnosticV1 } from "./diagnostics";

/** Same shape as the City SDK's Result so callers do not juggle two dialects. */
export type ResultV1<T> =
  | Readonly<{ ok: true; value: T; diagnostics: readonly GameDiagnosticV1[] }>
  | Readonly<{ ok: false; diagnostics: readonly GameDiagnosticV1[] }>;
