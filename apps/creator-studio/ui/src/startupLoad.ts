/** Retry only the host's transient startup race; do not hide real storage failures. */
export async function loadStudioAtStartup(load: () => Promise<void>, options: {
  isCancelled: () => boolean;
  delay: (ms: number) => Promise<void>;
  attempts?: number;
}): Promise<void> {
  const attempts = options.attempts ?? 12;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.isCancelled()) return;
    try { await load(); return; }
    catch (error) {
      const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (options.isCancelled()) return;
      if (code !== "plugin_instance_mismatch" || attempt + 1 >= attempts) throw error;
      await options.delay(150);
    }
  }
}
