import { supportsBackgroundFilm, type FilmJob, type FilmWorkerMessage } from "./filmProtocol";
export { supportsBackgroundFilm } from "./filmProtocol";

/** One worker per task. Termination cancels even a wedged renderer/encoder/muxer. */
export function runFilmJob(job: FilmJob, options: {
  signal: AbortSignal; onProgress: (frame: number, total: number) => void;
  onProfile?: (width: number, height: number, software: boolean) => void;
  /** Callback borrows the bitmap synchronously; the client always closes it. */
  onPreview?: (bitmap: ImageBitmap, frame: number) => void;
  workerFactory?: () => Worker;
}): Promise<Blob> {
  if (!supportsBackgroundFilm()) return Promise.reject(new Error("background_export_unavailable"));
  if (options.signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = options.workerFactory?.() ?? new Worker(new URL("./film.worker.ts", import.meta.url), { type: "module" }); }
    catch { reject(new Error("background_export_unavailable")); return; }
    let settled = false;
    let ready = false;
    let lastPulse = performance.now();
    const started = lastPulse;
    const finish = (error?: Error, blob?: Blob) => {
      if (settled) return;
      settled = true; clearInterval(watchdog); options.signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error); else resolve(blob!);
    };
    const cancel = () => finish(new DOMException("aborted", "AbortError"));
    const watchdog = setInterval(() => {
      const now = performance.now();
      if ((!ready && now - started > 15_000) || now - lastPulse > 30_000 || now - started > 30 * 60_000) finish(new Error("background_export_timeout"));
    }, 1000);
    options.signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error("background_export_failed")); };
    worker.onmessageerror = () => finish(new Error("background_export_failed"));
    worker.onmessage = (event: MessageEvent<FilmWorkerMessage>) => {
      const message = event.data;
      if (message?.type === "preview") {
        try {
          if (!settled && typeof ImageBitmap !== "undefined" && message.bitmap instanceof ImageBitmap
            && Number.isInteger(message.frame) && message.frame >= 0) options.onPreview?.(message.bitmap, message.frame);
        } catch { finish(new Error("background_export_failed")); }
        finally {
          try { message.bitmap?.close?.(); if (!settled) worker.postMessage({ type: "preview-ack" }); }
          catch { finish(new Error("background_export_failed")); }
        }
        return;
      }
      if (settled) return;
      if (!message || typeof message !== "object" || typeof message.type !== "string") { finish(new Error("background_export_failed")); return; }
      lastPulse = performance.now();
      if (message.type === "ready" && !ready) {
        ready = true;
        try { worker.postMessage({ type: "start", job }); } catch { finish(new Error("invalid_export_job")); }
      } else if (message.type === "profile" && Number.isInteger(message.width) && Number.isInteger(message.height)
        && message.width > 0 && message.height > 0 && message.width <= job.width && message.height <= job.height && typeof message.software === "boolean") {
        try { options.onProfile?.(message.width, message.height, message.software); } catch { finish(new Error("background_export_failed")); }
      } else if (message.type === "progress" && Number.isInteger(message.frame) && Number.isInteger(message.total) && message.total > 0 && message.frame >= 0 && message.frame <= message.total) {
        try { options.onProgress(message.frame, message.total); } catch { finish(new Error("background_export_failed")); }
      } else if (message.type === "complete") {
        if (!(message.blob instanceof Blob) || (message.blob.type !== "video/mp4" && message.blob.type !== "video/webm") || message.blob.size === 0) finish(new Error("background_export_failed"));
        else finish(undefined, message.blob);
      } else if (message.type === "error") finish(new Error(message.code));
    };
  });
}
