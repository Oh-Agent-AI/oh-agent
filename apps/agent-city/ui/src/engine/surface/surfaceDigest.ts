/** Local Web Crypto only. No fetch, host IPC, telemetry or weak-hash fallback. */
export async function sha256SurfaceBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("local-sha256-unavailable");
  const captured = new Uint8Array(bytes.byteLength); captured.set(bytes);
  const digest = await subtle.digest("SHA-256", captured);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}
