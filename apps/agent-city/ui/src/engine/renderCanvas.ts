/** DOM-free canvas creation shared by interactive and worker renderers. */
export type RenderCanvas = HTMLCanvasElement | OffscreenCanvas;
export type RenderContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createRenderCanvas(width = 1, height = 1): RenderCanvas {
  if (typeof document === "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

export function renderContext2D(canvas: RenderCanvas): RenderContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  return context as RenderContext2D;
}
