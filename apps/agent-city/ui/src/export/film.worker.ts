import { CityEngine } from "../engine/CityEngine";
import { cinematicCopy } from "../engine/cinematicCopy";
import type { FilmJob, FilmWorkerMessage } from "./filmProtocol";

const send = (message: FilmWorkerMessage) => self.postMessage(message);
send({ type: "ready" });
let started = false;
let previewPending = false;
self.onmessage = async (event: MessageEvent<{ type: "start"; job: FilmJob } | { type: "preview-ack" }>) => {
  if (event.data?.type === "preview-ack") { previewPending = false; return; }
  if (started || event.data?.type !== "start") return;
  started = true;
  let engine: CityEngine | null = null;
  const pulse = setInterval(() => send({ type: "pulse" }), 500);
  try {
    const job = event.data.job;
    if (!Number.isInteger(job.seed) || job.seed < 1 || job.seed > 4294967295
      || !Number.isInteger(job.width) || job.width < 1 || job.width > 1920
      || !Number.isInteger(job.height) || job.height < 1 || job.height > 1080
      || !Number.isInteger(job.fps) || job.fps < 1 || job.fps > 30
      || !Number.isFinite(job.bitrate) || job.bitrate < 1 || job.bitrate > 12_000_000
      || !["short", "full"].includes(job.cut)
      || (job.backdrop !== undefined && !["auto", "off", "full"].includes(job.backdrop))) throw new Error("invalid_export_job");
    if (typeof OffscreenCanvas === "undefined" || typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") throw new Error("background_export_unavailable");
    const canvas = new OffscreenCanvas(job.width, job.height);
    const context = canvas.getContext("webgl2", { powerPreference: "low-power", antialias: true });
    if (!context) throw new Error("background_webgl_unavailable");
    const info = context.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    const software = /swiftshader|llvmpipe|software|softpipe/i.test(renderer);
    // A software GPU is shared CPU work, not a background hardware queue. Limit
    // actual output dimensions (no misleading 1080p upscaling) to keep UI viable.
    if (software && (job.width > 640 || job.height > 360)) { job.width = 640; job.height = 360; canvas.width = 640; canvas.height = 360; }
    send({ type: "profile", width: job.width, height: job.height, software });
    engine = new CityEngine({ canvas, headless: true });
    engine.setBackdrop(job.backdrop ?? "off");
    engine.setSeed(job.seed);
    // Independent eco renderer limits shared-GPU pressure. UI quality/camera changes
    // never alter the frozen export and the UI canvas is never transferred away.
    engine.setQualityMode("eco");
    engine.applyModel(job.model, false);
    await engine.prepareExportAssets();
    let reported = -1;
    let lastPreview = -Infinity;
    const preview = new OffscreenCanvas(Math.min(640, job.width), Math.min(360, job.height));
    const previewContext = preview.getContext("2d");
    const blob = await engine.renderFilm({ ...job, letterbox: 2.39, watermark: "agent-vitals",
      maxEncodedBytes: 256 * 1024 * 1024,
      onFrame: (film, frame) => {
        // One bitmap in flight, at most 2 previews/sec. This is the actual
        // composited export frame, not a second camera/scene simulation.
        if (!previewContext || previewPending || performance.now() - lastPreview < 500) return;
        previewContext.drawImage(film, 0, 0, preview.width, preview.height);
        const bitmap = preview.transferToImageBitmap();
        previewPending = true; lastPreview = performance.now();
        self.postMessage({ type: "preview", bitmap, frame }, { transfer: [bitmap] });
      },
      describe: (card) => cinematicCopy(job.model, card, job.locale === "en" ? "en" : "zh-Hans"),
      onProgress: (frame, total) => {
        const percent = Math.floor(frame / total * 100);
        if (percent !== reported || frame === total) { reported = percent; send({ type: "progress", frame, total }); }
      },
    });
    send({ type: "complete", blob });
  } catch (error) {
    const known = ["invalid_export_job", "background_export_unavailable", "background_webgl_unavailable", "export_memory_limit", "video_encoder_unavailable"];
    send({ type: "error", code: error instanceof Error && known.includes(error.message) ? error.message : "background_export_failed" });
  } finally { clearInterval(pulse); engine?.dispose(); }
};
