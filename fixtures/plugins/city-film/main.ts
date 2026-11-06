// Test-only second entry: exercise the real export pipeline at small dimensions,
// without exposing renderer internals or test hooks in the production plugin.
import { CityEngine } from "../../../apps/agent-city/ui/src/engine/CityEngine";
import { buildCityModel } from "../../../apps/agent-city/ui/src/cityModel";
import { runFilmJob } from "../../../apps/agent-city/ui/src/export/filmJob";
import type { Scene, Mesh } from "three";

declare global { interface Window {
  runCityFilmTest: () => Promise<Record<string, unknown>>;
  filmWorkerUrl: string; filmProgress: number;
} }
window.runCityFilmTest = async () => {
  const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
  const engine = new CityEngine({ canvas });
  engine.setSeed(12345);
  engine.setQualityMode("eco");
  const start = Date.parse("2026-10-02T09:00:00Z");
  const model = buildCityModel({
    rows: [{ session_ref: "synthetic-film-session", harness: "codex", first_event_at: new Date(start).toISOString(),
      last_event_at: new Date(start + 60_000).toISOString(), peak_tokens: 100, event_count: 2, model_ids: [],
      tokens: { uncached_input_tokens: 80, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 20, total: 100 },
      cost_minor: null, cost_status: { state: "unavailable", has_unresolved: true, reason: "fixture" } }],
    findings: [], windowStartMs: start, windowEndMs: start + 3_600_000, windowLabel: "合成测试",
    totalSessions: 1, truncated: false, generatedAt: start + 3_600_000,
  });
  engine.applyModel(model);
  let renderErrors = 0;
  const reported = new Set<string>();
  (engine as unknown as { scene: Scene }).scene.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const mesh = object as Mesh;
    const previous = mesh.onAfterRender;
    mesh.onAfterRender = function (...args) {
      previous.apply(this, args);
      const gl = args[0].getContext();
      const error = gl.getError();
      if (error === gl.NO_ERROR) return;
      renderErrors++;
      const key = mesh.name || mesh.uuid;
      if (!reported.has(key)) {
        reported.add(key);
        console.error("Film draw error", JSON.stringify({ name: key, error, count: (mesh as Mesh & { count?: number }).count,
          attributes: Object.fromEntries(Object.entries(mesh.geometry.attributes).map(([name, attr]) => [name, attr.count])) }));
      }
    };
  });
  let uiFrames = 0;
  const button = document.querySelector<HTMLButtonElement>("button")!;
  button.onclick = () => { button.textContent = "UI responsive"; engine.resetView(); engine.setLabelsVisible(false); };
  let frames = 0;
  let previews = 0;
  let previewVisible = false;
  const preview = document.createElement("canvas"); preview.width = 320; preview.height = 180;
  document.body.append(preview);
  const previewContext = preview.getContext("2d")!;
  let pulses = 0;
  const timer = window.setInterval(() => pulses++, 20);
  try {
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => originalRaf((time) => { uiFrames++; callback(time); });
    const controller = new AbortController();
    const blob = await runFilmJob({ model: structuredClone(model), seed: 12345, cut: "short", width: 320, height: 180, fps: 1, bitrate: 120_000 }, {
      signal: controller.signal,
      onProgress: (frame) => { frames = frame; window.filmProgress = frame; },
      onPreview: (bitmap) => {
        previews++; previewContext.drawImage(bitmap, 0, 0, 320, 180);
        const pixels = previewContext.getImageData(0, 0, 320, 180).data;
        previewVisible ||= pixels.some((value, index) => index % 4 !== 3 && value > 20);
      },
      workerFactory: () => new Worker(window.filmWorkerUrl, { type: "module" }),
    }).finally(() => { window.requestAnimationFrame = originalRaf; });
    const signature = new TextDecoder().decode(await blob.slice(4, 8).arrayBuffer());
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("export cannot be decoded"));
        video.src = url; video.load();
      });
      if (!previews || !previewVisible) throw new Error("actual export preview missing or blank");
      return { frames, previews, previewVisible, pulses, uiFrames, renderErrors, uiResponsive: button.textContent === "UI responsive", signature, bytes: blob.size, type: blob.type,
        width: video.videoWidth, height: video.videoHeight, duration: video.duration };
    } finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
  } finally { window.clearInterval(timer); engine.dispose(); preview.remove(); }
};
