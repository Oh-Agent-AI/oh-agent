/**
 * 程序化纹理与配色：城市所有视觉素材都在 canvas 里生成，不携带任何外部资源。
 *
 * 视觉基调：Modern Miniature City × Architectural Model——低饱和暖白楼身、
 * 自然地形（沙滩/草坡/岩石由高度场着色）、淡青水面，与工作台的浅色 UI 同语言；
 * harness 决定各区建筑配色，地貌配色全城统一。
 */

import * as THREE from "three";
import type { CityLayout } from "./cityLayout";
import { hashSeed } from "../cityModel";
import { activeTheme, groundFor } from "./cityTheme";
import { roadPaintPlan } from "./cityRoadPaint";
import { cornerArc, renderRoadEdges, roadJunctionPlan, SIDEWALK_BAND, taperOutline } from "./cityRoadJunctions";
import { polygonDistance } from "./cityPlan";
import { subtractBlockSurfaceExclusions, traceBlockSurface } from "./blockSurface";
import { createRenderCanvas, renderContext2D, type RenderCanvas, type RenderContext2D } from "./renderCanvas";

export type DistrictPalette = {
  /** 楼身 tint（乘在近白色立面纹理上）。 */
  wall: string;
  roof: string;
  accent: string;
  park: string;
};

export function paletteFor(harnessId: string): DistrictPalette {
  const theme = activeTheme();
  // 迁移期兼容：旧事实/旧缓存里的 `plugin:` 前缀折算到现行 `harness:` 命名空间再查表。
  const key = harnessId.startsWith("plugin:") ? `harness:${harnessId.slice("plugin:".length)}` : harnessId;
  return theme.harnesses[key] ?? theme.fallback;
}

function canvas2d(width: number, height: number): { canvas: RenderCanvas; ctx: RenderContext2D } {
  const canvas = createRenderCanvas(width, Math.max(1, height));
  const ctx = renderContext2D(canvas);
  return { canvas, ctx };
}

/** 立面纹理：近中性底 + 窗格图案，harness 楼色作为实例 tint 相乘。
 *  纹理一格 = 4 层楼，实例属性 aFloors 在着色器里拉伸 v 轴，高层不糊。 */
/** 海滨装饰艺术立面：近白灰泥底（乘执行环境粉彩色）、水平「眉檐」饰带、横向带状窗、
 *  中轴竖向肋。一块平铺 = 2 层楼（材质 uRows=2）。灰泥颗粒感来自 stucco 法线贴图。 */
export function makeDecoFacadeTexture(): THREE.Texture {
  const size = 256;
  const { canvas, ctx } = canvas2d(size, size);
  ctx.fillStyle = "#fbf8f2";
  ctx.fillRect(0, 0, size, size);
  for (let floor = 0; floor < 2; floor += 1) {
    const top = floor * 128;
    // 带状窗：圆角长条，两端留墙；窗下一条深色投影线像窗台。
    ctx.fillStyle = "#5f8d96";
    ctx.beginPath();
    ctx.roundRect(22, top + 44, size - 44, 40, 14);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    ctx.fillRect(30, top + 50, size - 60, 6);
    for (let mullion = 1; mullion < 6; mullion += 1) {
      ctx.fillStyle = "#e9e3d8";
      ctx.fillRect(22 + mullion * ((size - 44) / 6) - 2, top + 44, 4, 40);
    }
    // 眉檐饰带：浅色凸带 + 下方阴影，三道一组是装饰艺术的标志。
    for (let line = 0; line < 3; line += 1) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, top + 98 + line * 7, size, 3);
      ctx.fillStyle = "rgba(90, 80, 70, 0.22)";
      ctx.fillRect(0, top + 101 + line * 7, size, 2);
    }
  }
  // 中轴竖向肋：遮住带状窗中段，形成对称立面。
  ctx.fillStyle = "#f3eee6";
  ctx.fillRect(size / 2 - 12, 0, 24, size);
  ctx.fillStyle = "rgba(90, 80, 70, 0.18)";
  ctx.fillRect(size / 2 + 12, 0, 3, size);
  const texture = new THREE.Texture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

export function makeFacadeTexture(variant: number, seed: number): THREE.Texture {
  const { canvas, ctx } = canvas2d(128, 128);
  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, 128, 128);

  // 窗与墙的明暗对比同时是玻璃反射的遮罩（材质里按亮度判定：暗 = 玻璃）。
  // 曾经三种立面都是「墙上开小窗」，反射只落在零碎小格里，玻璃楼看不出映着天空（用户实测反馈）。
  if (variant === 0) {
    // 住宅：开窗，比原来大一圈；亮窗（有人在家）不进反射遮罩。
    for (let floor = 0; floor < 4; floor += 1) {
      for (let column = 0; column < 5; column += 1) {
        const lit = hashSeed(`w${seed}:${floor}:${column}`) > 0.86;
        ctx.fillStyle = lit ? "#f7e3ae" : "#4f5d6a";
        ctx.fillRect(4 + column * 24, 5 + floor * 32, 20, 24);
      }
    }
    ctx.fillStyle = "rgba(120, 108, 92, 0.14)";
    for (let floor = 0; floor < 4; floor += 1) ctx.fillRect(0, floor * 32 + 28, 128, 2);
  } else if (variant === 1) {
    // 商业：连续带状窗，层间是实墙横带。
    for (let floor = 0; floor < 4; floor += 1) {
      ctx.fillStyle = "#4d5c68";
      ctx.fillRect(0, floor * 32 + 3, 128, 25);
      ctx.fillStyle = "#e9e5d8";
      for (let mullion = 0; mullion < 4; mullion += 1) ctx.fillRect(mullion * 32, floor * 32 + 3, 2, 25);
      if (hashSeed(`b${seed}:${floor}`) > 0.8) {
        ctx.fillStyle = "#f3dfa6";
        ctx.fillRect(34 + (floor % 2) * 32, floor * 32 + 3, 30, 25);
      }
    }
  } else {
    // 市中心：玻璃幕墙——整面玻璃，只留细竖梃与层间窄横带。
    ctx.fillStyle = "#45586a";
    ctx.fillRect(0, 0, 128, 128);
    for (let floor = 0; floor < 4; floor += 1) {
      for (let column = 0; column < 4; column += 1) {
        const pane = hashSeed(`g${seed}:${floor}:${column}`);
        if (pane > 0.93) {
          ctx.fillStyle = "#f2dfae";
          ctx.fillRect(column * 32 + 1, floor * 32 + 2, 31, 29);
        } else {
          // 玻璃间轻微色差：每块玻璃的反射率略不同，远看不是一张平板。
          ctx.fillStyle = `rgba(${pane > 0.5 ? "70,92,110" : "58,76,94"}, 1)`;
          ctx.fillRect(column * 32 + 1, floor * 32 + 2, 31, 29);
        }
      }
    }
    ctx.fillStyle = "#c9d0d3";
    for (let floor = 0; floor < 4; floor += 1) ctx.fillRect(0, floor * 32, 128, 2);
    for (let column = 0; column < 4; column += 1) ctx.fillRect(column * 32, 0, 1, 128);
  }

  const texture = new THREE.Texture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function strokePolyline(ctx: RenderContext2D, points: Array<{ x: number; z: number }>, toPixel: (x: number, z: number) => [number, number], close: boolean): void {
  if (!points.length) return;
  ctx.beginPath();
  points.forEach((point, index) => {
    const [px, py] = toPixel(point.x, point.z);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  if (close) ctx.closePath();
  ctx.stroke();
}

/** One city-wide ground atlas: continuous land, hardscape blocks and connected streets. */
export function makeCityTexture(layout: CityLayout): THREE.Texture {
  // 2048 铺 1600 单位 ~1.3px/单位，街道偏窄但可辨；4096 的 RGBA 原图 64MiB，
  // 反复重建时内存峰值过高（WebView 实测峰值 2.6GB）。静态缓存落地后只在
  // 换 seed 时付一次生成成本，2048 是内存/清晰度的折衷。
  const size = 2048;
  const { canvas, ctx } = canvas2d(size, size);
  const scale = size / layout.extent;
  const toPixel = (x: number, z: number): [number, number] => [(x + layout.extent / 2) * scale, (z + layout.extent / 2) * scale];
  const ground = canvas2d(384, 384);
  const pixels = ground.ctx.createImageData(384, 384);
  const groundColors = groundFor(activeTheme(), layout.biome);
  // 街区铺装与空街区草坪也跟着生态带走：它们占了地图的大半，只改沙滩/草地色时生态带几乎看不出（截图实测）。
  const toHex = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
  const mixRgb = (a0: number[], b0: number[], t: number) => a0.map((v, i) => v + (b0[i] - v) * t);
  const paving = toHex(mixRgb([197, 192, 179], groundColors.sand, 0.45));
  const lawnTint = toHex(mixRgb([145, 165, 127], groundColors.lawn, 0.6));
  const viceMiami = layout.coastalConfig?.profile === "miami-coastal";
  const viceBlockPaving: Record<string, string> = {
    downtown: "#d8c0b5",
    commercial: "#c8d3cc",
    waterfront: "#e8c4be",
    residential: "#cbd8ce",
  };
  const viceLotPaving: Record<string, string> = {
    downtown: "#c3b9b0",
    commercial: "#b9c4bd",
    waterfront: "#d8b8b2",
    residential: "#becbc3",
  };
  const urbanGround = mixRgb(groundColors.sand, groundColors.lawn, 0.42);
  const coastDistanceOf = (x: number, z: number) => polygonDistance({ x, z }, layout.coast);
  for (let iz = 0; iz < 384; iz += 1) for (let ix = 0; ix < 384; ix += 1) {
    const x = (ix / 383 - 0.5) * layout.extent;
    const z = (iz / 383 - 0.5) * layout.extent;
    const h = layout.terrain.height(x, z);
    const noise = hashSeed(`ground:${ix}:${iz}`) * 7;
    const g = groundColors;
    // G2：海岸 30 内才是沙；内陆低平原（高 1.2，同样 < 2.5）曾一律按沙色画，整座城看起来像沙漠。
    // 内陆改成偏草坪的浅色地面（迈阿密是「绿 + 白 + 粉彩」，不是黄沙）。
    const inland = h >= 0 && h < 2.5 && coastDistanceOf(x, z) > 30;
    const color = h < 0 ? g.sea : inland ? urbanGround : h < 2.5 ? g.sand : h < 9 ? g.lawn : h < 35 ? g.grass : g.rock;
    const index = (iz * 384 + ix) * 4;
    pixels.data[index] = color[0] + noise; pixels.data[index+1] = color[1] + noise; pixels.data[index+2] = color[2] + noise; pixels.data[index+3] = 255;
  }
  ground.ctx.putImageData(pixels, 0, 0);
  ctx.drawImage(ground.canvas, 0, 0, size, size);
  const polygon = (points: Array<{x:number;z:number}>, color:string, target = ctx) => {
    target.beginPath(); points.forEach((p,i)=> { const [x,y]=toPixel(p.x,p.z); if(i===0)target.moveTo(x,y);else target.lineTo(x,y); });
    target.closePath(); target.fillStyle=color; target.fill();
  };
  const orientedRect = (x:number,z:number,width:number,depth:number,yaw:number,color:string,target = ctx) => {
    const [px,py]=toPixel(x,z); target.save(); target.translate(px,py); target.rotate(-yaw);
    target.fillStyle=color;target.fillRect(-width*scale/2,-depth*scale/2,width*scale,depth*scale);target.restore();
  };
  // 空置街区（G1）：不铺地块，画成带深浅斑驳的自然绿地——城市只铺到建成区与预留圈。
  const wildGreen = toHex(mixRgb([150, 176, 118], groundColors.lawn, 0.35));
  // Subtract reserved envelopes on a disposable transparent layer, not from
  // terrain. One atlas-sized temporary buffer; its memory cost needs profiling.
  const blockLayer = layout.blocks.some((block) => block.surfaceCoverage) ? canvas2d(size, size) : null;
  const blockCtx = blockLayer?.ctx ?? ctx;
  for (const block of layout.blocks) {
    blockCtx.save();
    if (block.surfaceCoverage) { traceBlockSurface(blockCtx, block, toPixel); blockCtx.clip("evenodd"); }
    if (block.vacant) {
      polygon(block.polygon.map((p)=>({x:block.x+(p.x-block.x)*1.02,z:block.z+(p.z-block.z)*1.02})), wildGreen, blockCtx);
      blockCtx.restore();
      continue;
    }
    const hardscape = viceMiami ? viceBlockPaving[block.zone] : paving;
    polygon(block.polygon.map((p)=>({x:block.x+(p.x-block.x)*0.88,z:block.z+(p.z-block.z)*0.88})),block.parcels.length?hardscape:lawnTint, blockCtx);
    for (const parcel of block.parcels) orientedRect(parcel.x,parcel.z,parcel.width-0.3,parcel.depth-0.3,parcel.yaw,viceMiami ? viceLotPaving[parcel.zone] : "#bcb8ac", blockCtx);
    blockCtx.restore();
  }
  if (blockLayer) { subtractBlockSurfaceExclusions(blockCtx, layout.blocks, toPixel, scale); ctx.drawImage(blockLayer.canvas, 0, 0); }
  // 沙滩不画进这张贴图：2048px 铺满全岛只有 ~1.3px/单位，沙带与水线边缘糊成一片（真机近景）。
  // 沙滩改成贴地网格（cityParts.buildBeachRibbon），色带边缘由几何决定、与贴图分辨率无关。
  // 画路用渲染路网：窄短桩按接续宽路画（cityRoadJunctions.renderRoadEdges），与路面网格 / 路缘同一份。
  const roadEdges = renderRoadEdges(layout.roadEdges);
  const { runs, junctions } = roadPaintPlan(roadEdges);
  // 人行道与沥青都只画成路面网格（roadSurfaceSystem）下面的「垫底」：每侧内缩 UNDERLAY_INSET（> 半个贴图像素 ≈ 0.4），
  // 图集双线性插值的模糊边就藏在清晰的网格边缘里面，不在边缘外留一圈暗晕 / 白晕。
  // 垫底不能省：地面细节 shader 按图集颜色分类材质，网格万一漏一条缝，露出来的仍是同色的路，而不是草。
  const UNDERLAY_INSET = 0.8;
  // 路口几何（圆角/等级/渐变）一次算好，路面、人行道、标线与 roadSystem 的路缘共用同一份（cityRoadJunctions.ts）。
  const junctionPlan = roadJunctionPlan(roadEdges);
  const asphaltOf = (kind: string) => (kind === "arterial" ? "#505b60" : "#646c6b");
  const fillPath = (points: Array<{ x: number; z: number }>, color: string) => {
    if (points.length < 3) return;
    ctx.beginPath(); points.forEach((p, i) => { const [x, y] = toPixel(p.x, p.z); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  };
  const taperQuad = (j: (typeof junctionPlan)[number], extra: number) => taperOutline(j, extra);
  ctx.lineCap="butt"; ctx.lineJoin="round";
  // Paint ALL sidewalks before ANY asphalt: neighboring caps cannot cut white seams into roads.
  for (const road of runs) {
    ctx.strokeStyle="#d4cfc2";ctx.lineWidth=(road.width+2.4-2*UNDERLAY_INSET)*scale;strokePolyline(ctx,road.points,toPixel,false);
  }
  // 转角人行道：沿路面圆弧的同心弧（半径 r−1.2）。直接画人行道描边的直角会在路口留下方角——
  // 圆角铺装随后盖掉弧内的部分，只剩弧外 1.2 宽的人行道带跟着圆弧走。
  for (const j of junctionPlan) {
    for (const corner of j.corners) fillPath([{ x: j.x, z: j.z }, ...cornerArc(corner, SIDEWALK_BAND - UNDERLAY_INSET)], "#d4cfc2");
    if (j.taper) fillPath(taperQuad(j, SIDEWALK_BAND - UNDERLAY_INSET), "#d4cfc2");
  }
  // 换宽度/换等级的两路交界点（主干 12 → 次干 8 → 支路 5）：roadPaintPlan 在这里把一条路断成两段，平头线帽在拐弯处留
  // 楔形缺口、宽度跳变像「路断了」（用户截图：断断续续的路）。只有 ≥3 路的路口才补过圆——这里补上，人行道与沥青各一盘。
  const seams: Array<{ x: number; z: number; width: number; arterial: boolean }> = [];
  {
    const incident = new Map<string, typeof layout.roadEdges>();
    for (const edge of roadEdges) if (!edge.bridge) for (const id of [edge.from, edge.to]) (incident.get(id) ?? incident.set(id, []).get(id)!).push(edge);
    const nodeById = new Map(layout.roadNodes.map((node) => [node.id, node]));
    for (const [id, list] of incident) {
      if (list.length !== 2 || junctions.has(id)) continue;
      const [first, second] = list;
      if (first.width === second.width && first.kind === second.kind) continue;
      const node = nodeById.get(id);
      if (node) seams.push({ x: node.x, z: node.z, width: Math.min(first.width, second.width), // 取窄的那条：取宽的会在 12→5 处鼓出一个黑疙瘩
         arterial: first.kind === "arterial" || second.kind === "arterial" });
    }
  }
  for (const seam of seams) {
    const [x,y]=toPixel(seam.x,seam.z);
    ctx.fillStyle="#d4cfc2";ctx.beginPath();ctx.arc(x,y,((seam.width+2.4)/2-UNDERLAY_INSET)*scale,0,Math.PI*2);ctx.fill();
  }
  // 路口铺装先于路段：圆角（窄路色）→ 路口中心圆盘（最宽臂色）→ 路段按宽度升序。宽路最后画，
  // 它的铺装就直穿路口、盖住窄路伸进来的那截——「小路在大路边缘收口」是绘制顺序的结果，不用逐口裁剪。
  // 旧做法圆盘画在路段之后、颜色取「任一臂是主干就用主干色」，窄路口也被涂成主干色的圆疙瘩。
  for (const j of junctionPlan) for (const corner of j.corners) fillPath([{ x: j.x, z: j.z }, ...cornerArc(corner, -UNDERLAY_INSET)], asphaltOf(corner.kind));
  for (const node of layout.roadNodes) if (junctions.has(node.id)) {
    const incident = roadEdges.filter((edge) => edge.from === node.id || edge.to === node.id);
    const width = Math.max(...incident.map((edge) => edge.width));
    const widest = incident.find((edge) => edge.width === width)!;
    const [x,y] = toPixel(node.x,node.z);
    ctx.fillStyle=asphaltOf(widest.kind);
    ctx.beginPath();ctx.arc(x,y,Math.max(0,width/2-UNDERLAY_INSET)*scale,0,Math.PI*2);ctx.fill();
  }
  for (const road of [...runs].sort((p, q) => p.width - q.width)) {
    ctx.strokeStyle=asphaltOf(road.kind);ctx.lineWidth=Math.max(0.5,road.width-2*UNDERLAY_INSET)*scale;strokePolyline(ctx,road.points,toPixel,false);
  }
  for (const seam of seams) {
    const [x,y]=toPixel(seam.x,seam.z);
    ctx.fillStyle=seam.arterial?"#505b60":"#646c6b";ctx.beginPath();ctx.arc(x,y,Math.max(0,seam.width/2-UNDERLAY_INSET)*scale,0,Math.PI*2);ctx.fill();
  }
  // 渐变段（度 2 换宽）：宽路色梯形从宽路半宽线性收到窄路半宽，长 ≈ 2×宽度差——替代「宽度台阶」。
  for (const j of junctionPlan) if (j.taper) fillPath(taperQuad(j, -UNDERLAY_INSET), asphaltOf(j.taper.narrow.edge.kind));
  // 路面标线（中线 / 车道线 / 边线 / 斑马线 / 停止线）不再画进这张图：≈1.3 px/单位下 0.22 宽的线是 0.3 个像素，
  // 由路面网格（systems/roadSurfaceSystem.ts）在片元里按世界坐标解析绘制。
  for(const site of layout.publicSites){
    const [x,y]=toPixel(site.x,site.z);
    if(site.kind==="park"){
      ctx.fillStyle="#799b71";ctx.beginPath();ctx.ellipse(x,y,site.radius*scale,site.radius*0.75*scale,-0.2,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle="#d2c4a0";ctx.lineWidth=2.2*scale;ctx.beginPath();ctx.ellipse(x,y,site.radius*0.75*scale,site.radius*0.55*scale,-0.2,0,Math.PI*2);ctx.stroke();
    }else{
      orientedRect(site.x,site.z,site.radius*1.6,site.radius*1.3,site.yaw,site.kind==="harbor"?"#999f98":"#d0c7b3");
      if(site.kind==="civic"){
        ctx.fillStyle="#609ca3";ctx.beginPath();ctx.arc(x,y+18*scale,6*scale,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle="#efdfbd";ctx.lineWidth=2*scale;ctx.stroke();
      }
      if(site.kind==="station")for(let track=0;track<4;track+=1)orientedRect(site.x-18+track*8,site.z,1.2,site.radius*1.15,site.yaw,"#737c76");
      if(site.kind==="stadium"){
        ctx.fillStyle="#647f62";ctx.beginPath();ctx.ellipse(x,y,28*scale,19*scale,-site.yaw,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle="#dad9c0";ctx.lineWidth=0.7*scale;ctx.strokeRect(x-18*scale,y-10*scale,36*scale,20*scale);
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return texture;
}

/** 区名标签 sprite。 */
export function makeLabelSprite(label: string, detail: string, color: string): { texture: THREE.Texture; aspect: number } {
  const padding = 18;
  const fontSize = 46;
  const probe = canvas2d(4, 4);
  probe.ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  const labelWidth = probe.ctx.measureText(label).width;
  probe.ctx.font = `400 ${fontSize * 0.62}px system-ui, -apple-system, sans-serif`;
  const detailWidth = probe.ctx.measureText(detail).width;
  const width = Math.ceil(Math.max(labelWidth, detailWidth)) + padding * 2;
  const height = Math.ceil(fontSize * 2.1);
  const { canvas, ctx } = canvas2d(width, height);
  const radius = 18;
  ctx.beginPath();
  ctx.roundRect(1, 1, width - 2, height - 2, radius);
  ctx.fillStyle = "rgba(250, 250, 248, 0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(90, 84, 74, 0.28)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#292d34";
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(label, padding, fontSize + 8);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(padding + 7, fontSize * 1.62, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#63748a";
  ctx.font = `400 ${fontSize * 0.62}px system-ui, -apple-system, sans-serif`;
  ctx.fillText(detail, padding + 22, fontSize * 1.62 + fontSize * 0.24);
  const texture = new THREE.Texture(canvas);
  texture.needsUpdate = true;
  return { texture, aspect: width / height };
}
