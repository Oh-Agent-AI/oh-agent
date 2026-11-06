import type { CityModel } from "../cityModel";
import type { CinematicCut } from "../engine/cityCinematic";
import type { BackdropMode } from "../engine/cityLayout";

/** Only scene statistics enter the job; no excerpts, log paths or host access. */
export type FilmJob = {
  model: CityModel; seed: number; cut: CinematicCut;
  /** 与屏幕上同一档背景楼（F4），否则导出的城和看到的城不一样。缺省 auto。 */
  backdrop?: BackdropMode;
  width: number; height: number; fps: number; bitrate: number;
  locale?: "en" | "zh-Hans";
};
export type FilmWorkerMessage =
  | { type: "ready" }
  | { type: "pulse" }
  | { type: "profile"; width: number; height: number; software: boolean }
  | { type: "progress"; frame: number; total: number }
  | { type: "preview"; bitmap: ImageBitmap; frame: number }
  | { type: "complete"; blob: Blob }
  | { type: "error"; code: string };

export function supportsBackgroundFilm(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}
