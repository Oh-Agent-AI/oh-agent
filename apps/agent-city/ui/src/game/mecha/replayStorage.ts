export type ReplayStorageErrorCode = "storage" | "full";
export class ReplayStorageError extends Error {
  readonly code: ReplayStorageErrorCode;
  constructor(code: ReplayStorageErrorCode) { super(code); this.code = code; }
}

export const SEQUENTIAL_REPLAY_LIBRARY_LIMIT = 20;
