/** Prepare the current model's new geography before invoking the engine's synchronous
 * seed change. A model may finish loading while preparation or persistence is in
 * flight, so only apply after rechecking both engine and model identity. */
export class SeedChangeError extends Error {
  readonly saved: boolean;
  readonly persistAttempted: boolean;
  constructor(saved: boolean, persistAttempted: boolean, cause: unknown) {
    super("city-seed-change-failed", { cause });
    this.saved = saved;
    this.persistAttempted = persistAttempted;
  }
}

type SeedEngine<Model> = { readonly currentModel: Model | null; setSeed(seed: number): void };
export async function prepareSeedChange<Model>(options: {
  seed: number;
  signal: AbortSignal;
  currentEngine: () => SeedEngine<Model> | null;
  prepare: (model: Model, seed: number, signal: AbortSignal) => Promise<void>;
  persist: (seed: number) => Promise<unknown>;
  beforeWork: () => Promise<void>;
}): Promise<"applied" | "cancelled"> {
  let saved = false;
  let persistAttempted = false;
  try {
    while (!options.signal.aborted) {
      const engine = options.currentEngine();
      const model = engine?.currentModel ?? null;
      if (model !== null) {
        await options.beforeWork();
        if (options.signal.aborted) return "cancelled";
        await options.prepare(model, options.seed, options.signal);
      }
      if (options.signal.aborted) return "cancelled";
      // Avoid saving a seed if the prepared model was already superseded.
      if (options.currentEngine() !== engine || (engine && engine.currentModel !== model)) continue;
      if (!saved) {
        persistAttempted = true;
        await options.persist(options.seed);
        saved = true;
      }
      if (options.signal.aborted) return "cancelled";
      await options.beforeWork();
      if (options.signal.aborted) return "cancelled";
      if (options.currentEngine() !== engine || (engine && engine.currentModel !== model)) continue;
      engine?.setSeed(options.seed);
      return "applied";
    }
    return "cancelled";
  } catch (error) {
    if (options.signal.aborted) return "cancelled";
    throw new SeedChangeError(saved, persistAttempted, error);
  }
}
