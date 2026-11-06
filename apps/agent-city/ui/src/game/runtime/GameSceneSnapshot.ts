import type { ReadyCitySurfaceCapture } from "../../engine/surface/citySurfacePort";
import type { ReadyCityStaticWorldCapture } from "../../engine/surface/cityStaticWorldPort";

/** One reservation carries a road-neutral static world plus roads only when requested. */
export type GameSceneSnapshot = Readonly<{
  staticWorld: ReadyCityStaticWorldCapture;
  drivingWorld?: ReadyCitySurfaceCapture;
}>;
