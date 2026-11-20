export type CitySceneFailure = {
  surface: "webgl" | "layout";
  code: string;
  summarySafe: true;
};

export const WEBGL_SCENE_FAILURE: CitySceneFailure = {
  surface: "webgl", code: "webgl_context_unavailable", summarySafe: true,
};

const LAYOUT_PREFIX = "layout-preparation:";

function layoutCode(reason: string): string {
  const cleaned = reason.replace(/[^a-z0-9_.:-]/gi, "").slice(0, 40);
  return cleaned || "layout_preparation_failed";
}

/** Constructor/WebGL failures keep the existing 3D-unavailable sentence.
 * A layout or planning failure must not be described as a missing GL context. */
export function classifyCitySceneFailure(error: unknown): CitySceneFailure {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (raw === "layout-preparation-cancelled") return { surface: "layout", code: "layout_preparation_cancelled", summarySafe: true };
  if (raw.startsWith(LAYOUT_PREFIX)) return { surface: "layout", code: layoutCode(raw.slice(LAYOUT_PREFIX.length)), summarySafe: true };
  if (raw === "city-world-biome-generator-mismatch") return { surface: "layout", code: "city_world_biome_generator_mismatch", summarySafe: true };
  return WEBGL_SCENE_FAILURE;
}

export function citySceneFailureMessage(failure: CitySceneFailure): string {
  if (failure.surface === "webgl") return "当前环境无法显示三维城市，仍可查看会话摘要。";
  return "城市布局未能生成，三维场景暂未装配；会话摘要仍可查看。";
}

export function citySceneFailureLog(failure: CitySceneFailure): { stage: "rendering" | "planning"; reason: string; outcome: "failed" } {
  return {
    stage: failure.surface === "webgl" ? "rendering" : "planning",
    reason: failure.code.slice(0, 40),
    outcome: "failed",
  };
}
