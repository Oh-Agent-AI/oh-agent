/** 窗口里没有会话时，城市怎么呈现。
 *
 * 2026-11-20 官方 Linux 包（dev 5e0a7d84，树与 f691d937 相同）空数据目录验收：
 * City 约 90 秒后只剩暗色视口和「当前时间范围没有会话」，没有 WebGL / 规划错误码。
 * provider 把 coverage.total === 0 标成 status "empty"。CityApp 把这句话当成整场景文案，
 * 画布 visibility:hidden，并且不等首帧、sceneReady 一直是 false。
 * 0 会话仍会规划第 1 档岛（路网、公共场地、地标），但用户看不到，相机工具也保持禁用。
 * 时间筛选结果为空走的是同一条 status。
 *
 * 空窗口只许在角落留一句诚实说明。画布、首帧等待和相机就绪跟有会话时一样。
 * 真正的 WebGL / 规划失败仍盖住画布并带错误码。这里不编造会话或用量。 */

export type CityWindowStatus = "ready" | "empty" | "stale" | "unavailable";

export type CitySceneCaption = "failure" | "data-unavailable" | "empty-note";

export type CityScenePresentation = {
  /** 只有真实场景失败或数据不可用才藏画布。空会话不藏。 */
  hideCanvas: boolean;
  /** 空窗口也要等到基础世界的首帧，不能把「没有会话」当成加载完成。 */
  awaitFirstFrame: boolean;
  /** 首帧之后相机和场景工具可用。空窗口同样算就绪。 */
  sceneReady: boolean;
  /** empty-note 不盖住城市。failure 与 data-unavailable 仍是居中错误。 */
  caption: CitySceneCaption | null;
};

export function cityScenePresentation(input: {
  boot: boolean;
  dataLoaded: boolean;
  status: CityWindowStatus | null;
  sceneUnavailable: boolean;
  firstModelFrame: boolean;
  gameActive: boolean;
}): CityScenePresentation {
  const dataAvailable = input.status !== null && input.status !== "unavailable";
  const hideCanvas = !input.gameActive && (input.sceneUnavailable
    || (!input.boot && input.dataLoaded && input.status === "unavailable"));
  const awaitFirstFrame = !input.sceneUnavailable && (input.boot
    ? !input.firstModelFrame
    : !input.dataLoaded || (dataAvailable && !input.firstModelFrame));
  const sceneReady = (input.boot || dataAvailable) && !input.sceneUnavailable && input.firstModelFrame;
  const caption: CitySceneCaption | null = input.sceneUnavailable ? "failure"
    : !input.boot && input.dataLoaded && input.status === "unavailable" ? "data-unavailable"
    : !input.boot && input.dataLoaded && input.status === "empty" && input.firstModelFrame ? "empty-note"
    : null;
  return { hideCanvas, awaitFirstFrame, sceneReady, caption };
}
