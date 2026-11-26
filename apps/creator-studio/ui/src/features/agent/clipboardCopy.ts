export async function copyTextWithTimeout(writeText: () => Promise<void>, timeoutMs = 4000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("clipboard_copy_timeout")), timeoutMs);
    });
    await Promise.race([writeText(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
