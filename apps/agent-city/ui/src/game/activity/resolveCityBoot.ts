import type { PendingCreatorPlaytestV1 } from "./creatorPlaytestPending";

/** Resolve the host's authoritative pending state before constructing a City engine. */
export async function resolveCityBoot(
  read: () => Promise<PendingCreatorPlaytestV1>,
  wait: () => Promise<void>,
  isCancelled: () => boolean,
  maxRetries = 60,
): Promise<PendingCreatorPlaytestV1 | null> {
  for (let attempt = 0; ; attempt += 1) {
    if (isCancelled()) return null;
    try {
      const result = await read();
      return isCancelled() ? null : result;
    } catch (error) {
      if (isCancelled()) return null;
      if (attempt >= maxRetries) throw error;
      await wait();
    }
  }
}
