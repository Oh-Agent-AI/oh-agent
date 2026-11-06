/** Presentation-only subtraction; proxy circles are not model physics proof. */
import type { BlockSurfaceExclusion, CityBlock, Vec2 } from "./cityLayout";
import type { RenderContext2D } from "./renderCanvas";

export function traceBlockSurface(ctx: RenderContext2D, block: CityBlock,
  toPixel: (x: number, z: number) => [number, number]): void {
  ctx.beginPath();
  for (const ring of [block.polygon, ...(block.holes ?? [])]) {
    if (ring.length < 3) continue;
    ring.forEach((point, index) => {
      const [x, z] = toPixel(point.x, point.z);
      if (index === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    });
    ctx.closePath();
  }
}

/** Erase only an isolated transparent paving layer, never the terrain atlas. */
export function subtractBlockSurfaceExclusions(ctx: RenderContext2D, blocks: readonly CityBlock[],
  toPixel: (x: number, z: number) => [number, number], scale: number): void {
  const exclusions = new Map<string, BlockSurfaceExclusion>();
  for (const block of blocks) for (const exclusion of block.surfaceExclusions ?? []) {
    exclusions.set(`${exclusion.kind}:${exclusion.id}`, exclusion);
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "#000"; ctx.strokeStyle = "#000";
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const circle = (point: Vec2, radius: number) => {
    const [x, z] = toPixel(point.x, point.z);
    ctx.beginPath(); ctx.arc(x, z, radius * scale, 0, Math.PI * 2); ctx.fill();
  };
  for (const exclusion of exclusions.values()) {
    if (exclusion.kind === "site-circle") { circle(exclusion, exclusion.radius); continue; }
    ctx.lineWidth = exclusion.width * scale;
    ctx.beginPath();
    exclusion.points.forEach((point, index) => {
      const [x, z] = toPixel(point.x, point.z);
      if (index === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
    });
    ctx.stroke();
    // Include both closed caps even for zero-length/bent source segments.
    for (const point of exclusion.points) circle(point, exclusion.width / 2);
  }
  ctx.restore();
}
