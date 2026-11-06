/** Camera framing and click classification are independent of WebGL/DOM. */
export function buildingFrame(height: number, footprint: number, fov: number, aspect: number) {
  const vertical = fov * Math.PI / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(0.1, aspect));
  const radius = Math.hypot(Math.max(1, height) / 2, Math.max(1, footprint) / Math.SQRT2);
  return { distance: radius / Math.sin(Math.min(vertical, horizontal)) * 1.25,
    minDistance: Math.max(3, Math.max(1, footprint) / Math.SQRT2 + 3) };
}

export function isSelectionGesture(button: number, primary: boolean, moved: number, elapsed: number): boolean {
  return button === 0 && primary && moved <= 7 && elapsed <= 500;
}
