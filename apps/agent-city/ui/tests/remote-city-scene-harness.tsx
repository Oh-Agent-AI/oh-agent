import { createRoot } from "react-dom/client";
import { RemoteDreamCityScene } from "../src/remote/city/RemoteCityScene";
import type { RemoteCitySnapshot, RemoteCityVisualPalette } from "../src/remote/city/cityDisplayProjection";

export function createHarness(element: HTMLElement) {
  const root = createRoot(element);
  return {
    render: (snapshot: RemoteCitySnapshot | null, palettes?: RemoteCityVisualPalette[], heroBuildingId?: string | null) => root.render(<RemoteDreamCityScene snapshot={snapshot} palettes={palettes} heroBuildingId={heroBuildingId} />),
    dispose: () => root.unmount(),
  };
}
