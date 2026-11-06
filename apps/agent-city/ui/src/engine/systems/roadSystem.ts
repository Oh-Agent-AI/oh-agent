/**
 * 道路系统：基础设施（桥面/路缘）、区界高架、红色桁架桥。
 * 纯搬移自 CityParts（CITY_ENGINE_SPLIT_SPEC §4-6）：函数体逐字不变，`this.` -> `host.`。
 */

import * as THREE from "three";
import { m } from "../worldScale";
import { segmentDistance } from "../roadGeometry";
import type { CityLayout, RoadEdge, Vec2 } from "../cityLayout";
import { cornerArc, curbClearance, junctionIndex, pavementIndex, renderRoadEdges, roadJunctionPlan, STRAIGHT_GAP, taperOutline } from "../cityRoadJunctions";
import { channelizedTPlan, type ChannelizedArm } from "../cityRoadPaint";
import { BOX, EXPRESSWAY_DECK_THICKNESS, EXPRESSWAY_DECK_WIDTH, EXPRESSWAY_DECK_Y, expresswayDeckHeights } from "../render/shared";
import { bridgeDeckParts, channelizedGeometry, culDeSacDiscs, expresswayPieces, FLARE_LIFT, expresswayMeshes, highwayRampMeshes, highwayRampPieces, flareTriangles, trussBars, type DeckRibbonMesh } from "../surface/structureCompiler";
import { conformMesh, terrainFit } from "../surface/terrainClip";
export { culDeSacBulbRadius } from "../surface/structureCompiler";

/** 本系统读写的 CityParts 成员（精确清单；CityParts 以 `this as unknown as RoadHost` 传入）。 */
export interface RoadHost {
  readonly layout: CityLayout;
  readonly group: THREE.Group;
  readonly disposables: Array<{ dispose: () => void }>;
  readonly matrix: THREE.Matrix4;
  readonly quaternion: THREE.Quaternion;
  readonly euler: THREE.Euler;
  readonly scaleVector: THREE.Vector3;
  readonly positionVector: THREE.Vector3;
  readonly color: THREE.Color;
  makeInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh;
}

/** 桥头 / 滨水 / 尽端的路缘退让：沿用路口改造前的固定 5.5（旧「segment − 11」的一半）。 */
const LEGACY_CURB_TRIM = 5.5;

/** Batched city furniture and waterfront infrastructure, not selectable data. */
export function buildInfrastructure(host: RoadHost): void {
  type Part = { x: number; y: number; z: number; sx: number; sy: number; sz: number; color: string; tilt?: number; yaw?: number; pitch?: number; order?: "XYZ" | "YZX" | "YXZ" };
  const parts: Part[] = [];
  const add = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, tilt = 0, yaw = 0) => parts.push({ x, y, z, sx, sy, sz, color, tilt, yaw });
  // Curbs and street lights are real geometry; asphalt and markings share the atlas.
  // 画路一律用渲染路网（窄短桩按接续宽路画，与贴图 / 路面网格同一份）。
  const roadEdges = renderRoadEdges(host.layout.roadEdges);
  const junctions = roadJunctionPlan(roadEdges);
  const { byNode, armOf } = junctionIndex(junctions);
  /** 路缘在某端的退让距离。sideAtNode 是相对「从节点出发」方向的侧：+1 = 逆时针侧（+n）。 */
  const ownTrim = (edge: RoadEdge, node: string, sideAtNode: number): number => {
    const arm = armOf(edge, node);
    const junction = byNode.get(node);
    if (!arm || !junction || junction.touchesDeck || arm.legacy) return LEGACY_CURB_TRIM;
    const trim = sideAtNode > 0 ? arm.ccwTrim : arm.cwTrim;
    if (trim !== null) return trim;
    if (junction.taper && junction.taper.narrow === arm) return junction.taper.length;
    // 这一侧没有圆角：邻臂是桥面/滨水、或夹角 < 177° 却没能做出圆角（边太短 / 不等宽近直行），沿用旧的 5.5；
    // 直行侧（≥ 177°）邻臂不比自己宽就接到节点、与邻臂路缘连成一条。两种情况都再用 curbClearance 兜底：
    // 路缘必须走出路口里其它臂的路面带，不能落在别人的路面上。
    const neighbor = sideAtNode > 0 ? arm.ccwNeighbor : arm.cwNeighbor;
    const gap = sideAtNode > 0 ? arm.ccwGap : arm.cwGap;
    const base = !neighbor || neighbor.legacy || gap < STRAIGHT_GAP ? LEGACY_CURB_TRIM : 0;
    return Math.max(base, curbClearance(junction, arm, sideAtNode));
  };
  // 圆角切点 / 渐变段长度可能长过第一条短边：沿臂的直路链顺延，后续边在近端同侧接着退让。
  const spill = new Map<string, number>();
  const spillKey = (edge: RoadEdge, node: string, sideAtNode: number) => `${edge.id}|${node}|${sideAtNode}`;
  for (const junction of junctions) for (const arm of junction.arms) {
    const taper = junction.taper && junction.taper.narrow === arm ? junction.taper.length : null;
    for (const [sideAtNode, trim] of [[1, arm.ccwTrim ?? taper], [-1, arm.cwTrim ?? taper]] as const) {
      if (trim === null) continue;
      for (const link of arm.chain.slice(1)) {
        if (trim <= link.start) break;
        const key = spillKey(link.edge, link.near, sideAtNode);
        spill.set(key, Math.max(spill.get(key) ?? 0, trim - link.start));
      }
    }
  }
  const suspension = (host.layout.landmarks ?? []).find((l) => l.kind === "suspension-bridge");
  const nearSuspension = (a: Vec2, b: Vec2) => !!suspension?.to && [a, b].some((p) => Math.hypot(p.x - suspension.x, p.z - suspension.z) < 2 || Math.hypot(p.x - suspension.to!.x, p.z - suspension.to!.z) < 2);
  const pavement = pavementIndex(roadEdges);
  /** 一段路缘：减去它穿过的别的路面带后逐段落盒（< 0.5 的碎段丢弃），高度按每段中点取地形。 */
  const curb = (p: Vec2, q: Vec2, own: RoadEdge | undefined, overlap: number) => {
    const length = Math.hypot(q.x - p.x, q.z - p.z);
    if (length < 1e-3) return;
    const yaw = -Math.atan2(q.z - p.z, q.x - p.x);
    for (const [t0, t1] of pavement.outside(p, q, own)) {
      const piece = (t1 - t0) * length;
      if (piece < 0.5 && !(t0 === 0 && t1 === 1)) continue;
      const tm = (t0 + t1) / 2;
      const x = p.x + (q.x - p.x) * tm; const z = p.z + (q.z - p.z) * tm;
      add(x, Math.max(0, host.layout.terrain.height(x, z)) + 0.02, z, piece + (t0 === 0 && t1 === 1 ? overlap : 0), 0.18, 0.35, "#cbc6ba", 0, yaw);
    }
  };
  const curbTrim = (edge: RoadEdge, node: string, sideAtNode: number) =>
    Math.max(ownTrim(edge, node, sideAtNode), spill.get(spillKey(edge, node, sideAtNode)) ?? 0);
  for (const edge of roadEdges) {
    // Bridge spans need actual geometry; the terrain atlas is below the river surface.
    if (edge.bridge) {
      // 桥面/护栏/车道线/桥墩：描述符与驾驶路面共用（surface/structureCompiler），这里只组实例。
      // 桥面随引道起伏成斜板（YZX：先俯仰后转向，同高架），两端落在桥头路面上。
      for (const p of bridgeDeckParts(edge, host.layout)) parts.push({ x: p.x, y: p.y, z: p.z, sx: p.sx, sy: p.sy, sz: p.sz, color: p.color, tilt: p.rx, yaw: p.ry, pitch: p.rz, order: p.order });
      continue;
    }
    // 沿路段的实际方向摆放（G2 起各片区街网朝向不同；曾只认水平/竖直两种方向）。
    const [a, b] = edge.points;
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    if (segment < 1) continue;
    const ux = (b.x - a.x) / segment; const uz = (b.z - a.z) / segment;
    const nx = -uz; const nz = ux; // 路段法向（side = +1 即 +n 侧）
    for (const side of [-1, 1]) {
      // 每端按路口几何退让：有圆角的一侧退到切点（圆弧由下面的转角段接上），直行一侧接到节点
      // （与对面那臂的路缘连成一条），桥头 / 滨水 / 尽端沿用旧的固定 5.5。
      // 旧做法两端一律退 5.5、且整段 < 14 就不画：路缘要么直插进路口（宽路口 5.5 不够），
      // 要么在直行一侧断出 11 的口子；与贴图上的圆角路面对不上。
      const start = curbTrim(edge, edge.from, side);
      const end = curbTrim(edge, edge.to, -side);
      if (segment - start - end < 0.5) continue;
      const offset = side * (edge.width / 2 + 0.25);
      curb({ x: a.x + ux * start + nx * offset, z: a.z + uz * start + nz * offset },
        { x: a.x + ux * (segment - end) + nx * offset, z: a.z + uz * (segment - end) + nz * offset }, edge, 0);
    }
  }
  // 转角路缘：沿路面圆弧内收 0.25（路缘中心线与直段一致：路面边线外 0.25）的一串短盒，与贴图圆角同一份几何。
  for (const junction of junctions) for (const corner of junction.corners) {
    const arc = cornerArc(corner, 0.25);
    for (let k = 1; k < arc.length; k += 1) {
      const p = arc[k - 1]; const q = arc[k];
      const chord = Math.hypot(q.x - p.x, q.z - p.z);
      if (chord < 1e-3) continue;
      // 盒长多 0.12 让相邻弦段在折角外侧咬合，不露缝。
      curb(p, q, undefined, 0.12);
    }
  }
  // 渐变段两侧的斜路缘：从宽路路缘（节点处）斜接到窄路路缘（渐变段末端）。
  for (const junction of junctions) if (junction.taper) {
    const [wideLeft, narrowLeft, narrowRight, wideRight] = taperOutline(junction, 0.25);
    curb(wideLeft, narrowLeft, undefined, 0.12);
    curb(wideRight, narrowRight, undefined, 0.12);
  }
  // 城北高架与城南港口曾按常量坐标（urbanBounds.north − 12 / right − 80、south + 58）摆放、与地理无关：
  // G2 起高架是规划层的环线（buildDistrictExpressways 渲染），港口是 harbor 公共用地（buildPublicSites）。
  const mesh = host.makeInstanced(BOX, new THREE.MeshLambertMaterial({ color: "#ffffff" }), parts.length);
  parts.forEach((part, index) => {
    host.positionVector.set(part.x, part.y, part.z);
    host.euler.set(part.tilt ?? 0, part.yaw ?? 0, part.pitch ?? 0, part.order ?? "XYZ");
    host.quaternion.setFromEuler(host.euler);
    host.scaleVector.set(part.sx, part.sy, part.sz);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    mesh.setMatrixAt(index, host.matrix); mesh.setColorAt(index, host.color.set(part.color));
  });
  host.euler.set(0, 0, 0, "XYZ");
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.count = parts.length;
  mesh.name = "city-infrastructure-decorative";
}

/** 渠化 T 路口（渲染级，规划拓扑零改动）：acuteJunctions 守卫同一算法选出的 30–50°
 *  边缘带三岔（含 < 30° 普查残留违例；只挑宽 < 12 的窄路口，主干不渠化），把两个
 *  锐角侧的口部画成喇叭渐变（路面色贴地多边形，随地形取样），支路口中央摆一座
 *  低多边形水滴形分流岛（顶面植被色、侧壁路缘色）——视觉与车流语义都读成
 *  「渠化汇入」而不是「锐角硬接」。全部口合并成两个批（喇叭一盘、岛一盘），
 *  不是一口一 Mesh；喇叭抬 0.035（路漆 0.02–0.05 的既有 z-fighting 规避惯例，
 *  路缘盒基面 0.02 / 沙滩带 0.05 之间）。 */
export function buildChannelizedJunctions(host: RoadHost): void {
  const { flares, islands } = channelizedGeometry(host.layout);
  if (!islands.length) return;
  const terrain = host.layout.terrain;
  const flareTop = new THREE.Color();
  const islandTop = new THREE.Color("#87a86f");
  const islandSide = new THREE.Color("#cbc6ba");
  const flarePositions: number[] = [];
  const flareColors: number[] = [];
  const islandPositions: number[] = [];
  const islandColors: number[] = [];
  // 喇叭贴「渲染地形 + FLARE_LIFT」并按地形三角网保形（与路面同一判定）：曾按 terrain.height 真值取高，
  // 坡地上与贴渲染地形的路面错开，正是路面曾埋进地形的同一类缺陷。平地 / 线性坡与旧几何一致。
  const fit = terrainFit(host.layout, FLARE_LIFT);
  for (const flare of flares) {
    const color = flareTop.set(flare.color);
    for (const triangle of conformMesh(fit, FLARE_LIFT / 2, flareTriangles(flare)).triangles) {
      for (const p of triangle) { flarePositions.push(p.x, fit.heightAt(p.x, p.z), p.z); flareColors.push(color.r, color.g, color.b); }
    }
  }
  /** 水滴形分流岛（低多边形棱台）：顶面抬 0.22，侧壁插入地下 0.18。 */
  for (const { ring } of islands) {
    const top = ring.map((point) => [point.x, terrain.height(point.x, point.z) + 0.22, point.z]);
    const bottom = ring.map((point) => [point.x, terrain.height(point.x, point.z) - 0.18, point.z]);
    const centroid = [
      top.reduce((sum, vertex) => sum + vertex[0], 0) / top.length,
      top.reduce((sum, vertex) => sum + vertex[1], 0) / top.length,
      top.reduce((sum, vertex) => sum + vertex[2], 0) / top.length,
    ];
    for (let k = 0; k < ring.length; k += 1) {
      const next = (k + 1) % ring.length;
      for (const vertex of [top[k], top[next], centroid]) { islandPositions.push(...vertex); islandColors.push(islandTop.r, islandTop.g, islandTop.b); }
      for (const vertex of [top[k], top[next], bottom[next], top[k], bottom[next], bottom[k]]) { islandPositions.push(...vertex); islandColors.push(islandSide.r, islandSide.g, islandSide.b); }
    }
  }
  const build = (positions: number[], colors: number[], name: string, castShadow: boolean) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
    geometry.computeVertexNormals();
    // 双面渲染：绕序不挑（同沙滩带惯例），地形起伏下侧面朝向逐面有别。
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    host.group.add(mesh);
    host.disposables.push(geometry, material);
  };
  build(flarePositions, flareColors, "city-channel-flares", false);
  build(islandPositions, islandColors, "city-channel-islands", true);
}

/** 区界高架：与北环高架同视觉语言（桥面/车道线/护栏/桥墩），
 *  沿规划折线分段铺装 —— harness 城区之间可辨认的硬边界。 */
/** 连续桥面网格（deckRibbonMesh）按角色各合一张网格：key "deck" 是桥面板，其余是装饰角色（护栏/标线）。 */
function addRibbonMeshes(host: RoadHost, meshes: ReadonlyArray<DeckRibbonMesh>, roles: ReadonlyArray<readonly [string, string, string]>): void {
  for (const [role, color, name] of roles) {
    const tris = meshes.flatMap((m) => (role.endsWith("-deck") ? m.deck : m.decorations[role] ?? []));
    if (!tris.length) continue;
    const positions = new Float32Array(tris.length * 9);
    tris.forEach((tri, t) => tri.forEach((p, v) => { positions[t * 9 + v * 3] = p.x; positions[t * 9 + v * 3 + 1] = p.y; positions[t * 9 + v * 3 + 2] = p.z; }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = !role.endsWith("lane-line"); mesh.receiveShadow = true; mesh.name = name;
    host.group.add(mesh);
    host.disposables.push(geometry, material);
  }
}

export function buildDistrictExpressways(host: RoadHost): void {
  type Piece = { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; pitch?: number; color: string };
  // 桥面板 / 车道线 / 护栏：连续网格（expresswayMeshes，与驾驶面同一组斜接接缝；曾逐段画旋转盒子，弯道外侧张开楔形裂口）。
  addRibbonMeshes(host, expresswayMeshes(host.layout), [["expressway-deck", "#6a7071", "city-district-expressway-deck"], ["expressway-rail", "#b9bcb2", "city-district-expressway-rails"], ["expressway-lane-line", "#c6c6bb", "city-district-expressway-lines"]]);
  // 桥墩与盖梁：描述符与碰撞共用（surface/structureCompiler）。
  const pieces: Piece[] = expresswayPieces(host.layout).filter((p) => p.role !== "expressway-deck" && p.role !== "expressway-rail" && p.role !== "expressway-lane-line")
    .map((p) => ({ x: p.x, y: p.y, z: p.z, sx: p.sx, sy: p.sy, sz: p.sz, yaw: p.ry, pitch: p.rz, color: p.color }));
  if (!pieces.length) return;
  const geometry = BOX.clone();
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color: "#ffffff" }), pieces.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pieces.forEach((piece, index) => {
    host.positionVector.set(piece.x, piece.y, piece.z);
    // 先绕局部 z 俯仰（匝道坡度），再绕 y 转向：'YZX' 顺序。
    host.euler.set(0, piece.yaw, piece.pitch ?? 0, "YZX");
    host.quaternion.setFromEuler(host.euler);
    host.euler.set(0, 0, 0, "XYZ");
    host.scaleVector.set(piece.sx, piece.sy, piece.sz);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    mesh.setMatrixAt(index, host.matrix);
    mesh.setColorAt(index, host.color.set(piece.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = "city-district-expressway-supports";
  host.group.add(mesh);
  host.disposables.push(geometry, mesh.material);
}

/** 高架立交匝道（planner/highwayRamps.ts）：与区界高架同一视觉语言（桥面板 / 护栏 / 车道边线 / 墩柱）。
 *  几何来自 surface/structureCompiler.highwayRampPieces——与驾驶面、碰撞是同一份（2026-10-20 起匝道可驾驶）。
 *  匝道完全离开主桥幅后才沿剩余路程 smoothstep 降到路面，落在干道 T 口上；墩柱每 18 一根，离地 < 1.5 或压在
 *  地面车道上的不立。 */
export function buildHighwayRamps(host: RoadHost): void {
  // 桥面板 / 护栏 / 车道边线：连续网格（highwayRampMeshes，与驾驶面同一组斜接接缝）。曾逐段画旋转盒子，弯道外侧张开楔形裂口。
  addRibbonMeshes(host, highwayRampMeshes(host.layout), [["ramp-deck", "#6a7071", "city-highway-ramp-deck"], ["ramp-rail", "#b9bcb2", "city-highway-ramp-rails"], ["ramp-lane-line", "#e4dfc9", "city-highway-ramp-lines"]]);
  const parts = highwayRampPieces(host.layout).filter((p) => p.role === "ramp-pier");
  if (!parts.length) return;
  const pieces = parts.map((p) => ({ x: p.x, y: p.y, z: p.z, sx: p.sx, sy: p.sy, sz: p.sz, yaw: p.ry, pitch: p.rz, color: p.color }));
  const mesh = new THREE.InstancedMesh(BOX.clone(), new THREE.MeshLambertMaterial({ color: "#ffffff" }), pieces.length);
  mesh.castShadow = true; mesh.receiveShadow = true;
  pieces.forEach((piece, index) => {
    host.positionVector.set(piece.x, piece.y, piece.z);
    host.euler.set(0, piece.yaw, piece.pitch, "YZX");
    host.quaternion.setFromEuler(host.euler);
    host.euler.set(0, 0, 0, "XYZ");
    host.scaleVector.set(piece.sx, piece.sy, piece.sz);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    mesh.setMatrixAt(index, host.matrix);
    mesh.setColorAt(index, host.color.set(piece.color));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.name = "city-highway-ramp-piers";
  host.group.add(mesh);
  host.disposables.push(mesh.geometry, mesh.material);
}

/** 尽端回车圈（backlog 形态批 §5-3，docs/CITY_PLANNER_V2_FINDINGS.md §5）：合法尽端
 *  （layout.culDeSacEnds，EndpointRole cul-de-sac）几何上是路戛然而止——在路尽头铺一块
 *  平贴地面的回车圆盘 + 路缘色描边。纯渲染装饰，不改路网拓扑；一个 InstancedMesh 装全部
 *  圆盘、一个装全部描边（同 buildTrussBridges 的合并批模式，不逐端点建 Mesh）。
 *  高度按地形中心取样、法向贴合坡度（中心差分梯度），颜色用桥面/路缘同款涂装。 */
export function buildCulDeSacBulbs(host: RoadHost): void {
  const ends = culDeSacDiscs(host.layout);
  if (!ends.length) return;
  const discs = host.makeInstanced(new THREE.CylinderGeometry(1, 1, 1, 20).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#6a7071" }), ends.length);
  const rims = host.makeInstanced(new THREE.RingGeometry(0.86, 1, 28).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#cbc6ba" }), ends.length);
  discs.name = "city-culdesac-bulb-disc";
  rims.name = "city-culdesac-bulb-rim";
  discs.receiveShadow = true;
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  // 半径、基准高与坡度梯度来自描述符（与驾驶路面的回车圈顶面同一份）。
  ends.forEach(({ x, z, radius, base, gx, gz }, index: number) => {
    const end = { x, z };
    normal.set(-gx, 1, -gz).normalize();
    host.quaternion.setFromUnitVectors(up, normal);
    host.positionVector.set(end.x, base + 0.02, end.z);
    host.scaleVector.set(radius, 0.12, radius);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    discs.setMatrixAt(index, host.matrix);
    // 描边圆环贴在圆盘顶面上（盘厚 0.12 + 0.01，防 z-fighting）。
    host.positionVector.set(end.x, base + 0.15, end.z);
    host.scaleVector.set(radius, 1, radius);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    rims.setMatrixAt(index, host.matrix);
  });
  for (const mesh of [discs, rims]) { mesh.count = ends.length; mesh.instanceMatrix.needsUpdate = true; mesh.frustumCulled = false; }
}

/** 路口环岛的中心岛（planner/junctionRings.ts）：草坪圆盘 + 浅色路缘；主干环岛中间三棵棕榈 + 一圈花坛，支路小环一棵棕榈。
 *  环道本身是普通路段，由路面系统照常铺；这里只画环道内缘以内的岛。编辑器删掉环道后（岛周围剩不到 3 条路段）不画。 */
export function buildJunctionIslands(host: RoadHost): void {
  const rings = (host.layout.junctionRings ?? []).filter((ring) => host.layout.roadEdges.filter((edge) => {
    const a = edge.points[0], b = edge.points[edge.points.length - 1];
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    return Math.abs(Math.hypot(m.x - ring.x, m.z - ring.z) - ring.radius) < 1.5;
  }).length >= 3);
  if (!rings.length) return;
  const disc = new THREE.CylinderGeometry(1, 1, 1, 28).translate(0, 0.5, 0);
  const curbs = host.makeInstanced(disc, new THREE.MeshLambertMaterial({ color: "#cbc6ba" }), rings.length);
  const lawns = host.makeInstanced(disc.clone(), new THREE.MeshLambertMaterial({ color: "#6f9f58" }), rings.length);
  const beds = host.makeInstanced(new THREE.TorusGeometry(1, 0.12, 6, 28).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#d9577a" }), rings.length);
  curbs.name = "city-junction-island-curb"; lawns.name = "city-junction-island-lawn"; beds.name = "city-junction-island-bed";
  const palms: Array<{ x: number; y: number; z: number; h: number }> = [];
  let bedCount = 0;
  rings.forEach((ring, index) => {
    const y = Math.max(0, host.layout.terrain.height(ring.x, ring.z));
    const island = Math.max(1, ring.radius - ring.width / 2 - 0.6);
    host.positionVector.set(ring.x, y, ring.z); host.quaternion.identity();
    host.scaleVector.set(island + 0.35, 0.28, island + 0.35); host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector); curbs.setMatrixAt(index, host.matrix);
    host.positionVector.set(ring.x, y + 0.05, ring.z);
    host.scaleVector.set(island, 0.28, island); host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector); lawns.setMatrixAt(index, host.matrix);
    if (ring.kind === "major") {
      host.positionVector.set(ring.x, y + 0.36, ring.z); host.scaleVector.set(island * 0.62, 1, island * 0.62);
      host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector); beds.setMatrixAt(bedCount, host.matrix); bedCount += 1;
      for (let k = 0; k < 3; k += 1) { const a = (k / 3) * Math.PI * 2 + ring.x * 0.01; palms.push({ x: ring.x + Math.cos(a) * island * 0.3, y: y + 0.33, z: ring.z + Math.sin(a) * island * 0.3, h: m(9 + k * 1.5) }); }
    } else palms.push({ x: ring.x, y: y + 0.33, z: ring.z, h: m(8) });
  });
  for (const mesh of [curbs, lawns]) { mesh.count = rings.length; mesh.instanceMatrix.needsUpdate = true; mesh.receiveShadow = true; }
  beds.count = bedCount; beds.instanceMatrix.needsUpdate = true;
  const trunks = host.makeInstanced(new THREE.CylinderGeometry(0.1, 0.16, 1, 6).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: "#8a6a4a" }), palms.length);
  const crowns = host.makeInstanced(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshLambertMaterial({ color: "#3fa86b" }), palms.length);
  trunks.name = "city-junction-island-palm-trunk"; crowns.name = "city-junction-island-palm-crown";
  palms.forEach((palm, index) => {
    host.quaternion.identity();
    host.positionVector.set(palm.x, palm.y, palm.z); host.scaleVector.set(1, palm.h, 1); host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector); trunks.setMatrixAt(index, host.matrix);
    const r = palm.h * 0.32;
    host.positionVector.set(palm.x, palm.y + palm.h, palm.z); host.scaleVector.set(r, r * 0.28, r); host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector); crowns.setMatrixAt(index, host.matrix);
  });
  for (const mesh of [trunks, crowns]) { mesh.count = palms.length; mesh.instanceMatrix.needsUpdate = true; mesh.castShadow = true; }
}

type AddPart = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, tilt?: number, yaw?: number) => void;

/** 长跨混凝土高架（见调用处注释）：deckTop 是两端地面高度，桥面在两端与它齐平，中段抬升 rise。 */
function drawViaduct(add: AddPart, terrain: { height: (x: number, z: number) => number }, a: Vec2, b: Vec2, deckTop: number, width: number): void {
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / length; const uz = (b.z - a.z) / length;
  const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
  const rise = Math.min(8, length * 0.03);
  const ramp = Math.min(length / 2, rise / 0.06);
  const lift = (d: number) => { const t = Math.min(1, d / ramp, (length - d) / ramp); return deckTop + rise * t * t * (3 - 2 * t); };
  const at = (d: number) => ({ x: a.x + ux * d, z: a.z + uz * d });
  const step = 4;
  for (let d = 0; d < length; d += step) {
    const piece = Math.min(step, length - d); const mid = d + piece / 2; const p = at(mid); const y = lift(mid);
    add(p.x, y - 0.4, p.z, piece + 0.3, 0.4, width, "#6a7071", 0, yaw);           // 桥面
    add(p.x, y - 1.15, p.z, piece + 0.3, 1.1, width - 1.4, "#8e928c", 0, yaw);    // 箱梁梁侧
    for (const side of [-1, 1]) {
      const rail = side * (width / 2 - 0.15); const line = side * (width / 2 - 0.65);
      add(p.x + Math.sin(yaw) * rail, y, p.z + Math.cos(yaw) * rail, piece + 0.3, 0.65, 0.3, "#b9bcb2", 0, yaw);
      add(p.x + Math.sin(yaw) * line, y + 0.015, p.z + Math.cos(yaw) * line, piece + 0.3, 0.025, 0.12, "#e4dfc9", 0, yaw);
    }
  }
  for (let d = 2; d < length - 1; d += 6) { const p = at(d + 1); add(p.x, lift(d + 1) + 0.015, p.z, 2, 0.025, 0.14, "#dfd1a5", 0, yaw); }
  // 墩：每 22 一对圆柱感的方墩 + 盖梁；桥头 ramp 段太矮的不立（墩高 < 1 时只是一块压在地上的板）
  for (let d = 11; d < length - 8; d += 22) {
    const p = at(d); const y = lift(d); const top = y - 1.7;
    const bed = terrain.height(p.x, p.z);
    if (top - bed < 1) continue;
    add(p.x, top, p.z, 1.8, 0.55, width - 0.4, "#9c9f97", 0, yaw);               // 盖梁（顶面贴箱梁底 y-1.15）
    for (const side of [-1, 1]) {
      const o = side * (width / 2 - 2);
      add(p.x + Math.sin(yaw) * o, bed, p.z + Math.cos(yaw) * o, 1.5, top - bed, 1.5, "#a9aaa0", 0, yaw);
    }
  }
}

/** 红色穿式桁架桥（backlog L-7）：悬索桥之外、跨距 40–160 的过河桥加一套格构桁架——上下弦 + 竖杆 + 交替斜腹杆，
 *  深红涂装。只换造型不改路网（同悬索桥做法）；桥面高度与 buildInfrastructure 一致。 */
export function buildTrussBridges(host: RoadHost): void {
  const bars = trussBars(host.layout);
  if (!bars.length) return;
  const unit = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const red = new THREE.MeshLambertMaterial({ color: "#a8322a" });
  const mesh = new THREE.InstancedMesh(unit, red, bars.length);
  bars.forEach(([x, y, z, a, b, rotY, tilt, vertical], i) => {
    host.positionVector.set(x, y, z);
    // tilt: diagonal lean for vertical members, span pitch for chords (deck follows the approaches).
    host.euler.set(0, rotY, tilt, "YXZ");
    // 横向件：长度沿局部 x；竖向件：高度沿局部 y、绕局部 z 倾斜成斜腹杆。
    if (vertical) host.scaleVector.set(a, b, a); else host.scaleVector.set(a, b, b);
    if (!vertical) host.positionVector.y -= b / 2;
    host.quaternion.setFromEuler(host.euler);
    host.matrix.compose(host.positionVector, host.quaternion, host.scaleVector);
    mesh.setMatrixAt(i, host.matrix);
  });
  mesh.castShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = "city-landmark-truss-bridge";
  host.group.add(mesh);
  host.disposables.push(unit, red);
}
