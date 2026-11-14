/** Only retry transient startup/revision races; permissions and invalid data fail closed. */
const RETRYABLE = new Set(["plugin_instance_unavailable", "plugin_instance_mismatch", "revision_changed"]);
export function cityProjectionErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : "typed_city_projection_unavailable";
}

export async function retryCityProjection<T>(load: () => Promise<T>, options: {
  signal?: AbortSignal;
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  onAttempt?: (count: number, code?: string) => void;
  maxAttempts?: number;
}): Promise<T> {
  const limit = options.maxAttempts ?? 5;
  for (let attempt = 1; attempt <= limit; attempt++) {
    if (options.signal?.aborted) throw new Error("city_request_cancelled");
    options.onAttempt?.(attempt);
    try { return await load(); }
    catch (error) {
      if (options.signal?.aborted) throw new Error("city_request_cancelled");
      const code = cityProjectionErrorCode(error);
      options.onAttempt?.(attempt, code);
      if (!RETRYABLE.has(code) || attempt === limit) throw new Error(code);
      await options.delay(Math.min(1200, 150 * 2 ** (attempt - 1)), options.signal);
    }
  }
  throw new Error("typed_city_projection_unavailable");
}

export function cityProjectionDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("city_request_cancelled")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("city_request_cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
