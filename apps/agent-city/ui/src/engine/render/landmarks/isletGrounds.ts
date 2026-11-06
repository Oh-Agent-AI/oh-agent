import { m, REAL } from "../../worldScale";
import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { hashSeed } from "../../../cityModel";
import { isletEstate, isletGolf, isletStudio } from "../../cityIsletEstate";
import { groundRoadClearance } from "../../surface/roadClearance";

/** Scenery must stay off the REAL road network (the islet's causeway road reaches onto the island):
 * a palm trunk or the decorative spur slab standing on it blocked every car (road obstruction guard). */
const PALM_ROAD_CLEARANCE = 1.0; const SPUR_ROAD_GAP = 0.3;
type Place = (lx: number, lz: number) => number;
/** Local → world road clearance for this landmark group (position x,z; rotation.y = yaw). */
function clearanceOf(ctx: LandmarkCtx): Place {
  const { landmark, host } = ctx; const c = Math.cos(landmark.yaw ?? 0), s = Math.sin(landmark.yaw ?? 0);
  return (lx, lz) => groundRoadClearance(host.layout.roadEdges, landmark.x + lx * c + lz * s, landmark.z - lx * s + lz * c);
}

/**
 * 地标「islet-grounds」：豪宅岛的场地层——椭圆内部环路、接堤道的支路、满岛棕榈。原点 = 小岛中心，
 * landmark.reach = 小岛半径。布局与 cityLayout 摆住宅用的是同一个 isletEstate(radius, seed)，棕榈天然避开住宅与路。
 * 只是装饰：环路不在路网里、不走车。路面贴地 0.06（岛面是平的 1.2，不随地形起伏）。
 */
export function drawIsletGrounds(ctx: LandmarkCtx): void {
  if (ctx.landmark.variant === "golf") return drawGolf(ctx);
  if (ctx.landmark.variant === "studio") return drawStudio(ctx);
  const { group, landmark, host } = ctx;
  const estate = isletEstate(landmark.reach ?? 0, Math.floor(hashSeed(landmark.id) * 0x7fffffff));
  const keep = <T extends THREE.BufferGeometry | THREE.Material>(item: T): T => { host.disposables.push(item); return item; };
  // 路面抬离地面 0.3 + polygonOffset：贴 0.06 时被地形网格盖住，只露出一圈断续暗点（截图）。
  const asphalt = keep(new THREE.MeshLambertMaterial({ color: "#5c6264", polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const curb = keep(new THREE.MeshLambertMaterial({ color: "#d8d2c4", polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));

  // 环路：两条同心椭圆之间的带，外侧再压一圈浅色路缘
  const ring = (inset: number, width: number, y: number, material: THREE.Material) => {
    const { cx, cz, ax, az } = estate.loop;
    const segments = 72; const positions: number[] = []; const indices: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      for (const d of [inset - width / 2, inset + width / 2]) positions.push(cx + (ax + d) * Math.cos(a), y, cz + (az + d) * Math.sin(a));
      // 绕序：内→下一内→外，法线朝上（反过来法线朝下，俯视被背面剔除，环路整圈不见——截图）
      if (i < segments) { const k = i * 2; indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  ring(0, estate.loop.width, 0.3, asphalt);
  for (const side of [-1, 1]) ring(side * (estate.loop.width / 2 + 0.3), 0.6, 0.36, curb);
  // The spur runs from the ring toward the causeway; it stops short of the real road it meets.
  const clear = clearanceOf(ctx); const { x: sx, z0, z1, width: sw } = estate.spur; const dir = Math.sign(z1 - z0) || 1;
  let end = z1;
  for (let z = z0; dir * (z1 - z) > 0; z += dir * 0.25) {
    if ([-sw / 2, 0, sw / 2].some((dx) => clear(sx + dx, z + dir * 0.25) < SPUR_ROAD_GAP)) { end = z; break; }
  }
  // Unclipped spurs are drawn exactly as before; a spur clipped down to a stub is dropped.
  if (end === z1 || Math.abs(end - z0) > 0.5) {
    const spur = new THREE.Mesh(keep(new THREE.BoxGeometry(sw, 0.08, Math.abs(end - z0))), asphalt);
    spur.position.set(sx, 0.28, (z0 + end) / 2);
    spur.receiveShadow = true;
    group.add(spur);
  }

  addPalms(group, keep, estate.palms.filter((p) => clear(p.x, p.z) >= PALM_ROAD_CLEARANCE));
}

type Keep = <T extends THREE.BufferGeometry | THREE.Material>(item: T) => T;
const keeper = (host: LandmarkCtx["host"]): Keep => (item) => { host.disposables.push(item); return item; };

/** 棕榈：树干 + 7 片下垂叶片，两只 InstancedMesh（三种岛共用）。 */
function addPalms(group: THREE.Group, keep: Keep, palms: Array<{ x: number; z: number; height: number; turn: number }>): void {
  if (!palms.length) return;
  const trunkGeometry = keep(new THREE.CylinderGeometry(0.22, 0.32, 1, 6).translate(0, 0.5, 0));
  const frondGeometry = keep(new THREE.BoxGeometry(m(0.8), m(0.1), m(4)).translate(0, 0, m(2))); // 棕榈叶长 ~4 m
  const trunks = new THREE.InstancedMesh(trunkGeometry, keep(new THREE.MeshLambertMaterial({ color: "#a98462" })), palms.length);
  const fronds = new THREE.InstancedMesh(frondGeometry, keep(new THREE.MeshLambertMaterial({ color: "#2fbf77" })), palms.length * 7);
  const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const euler = new THREE.Euler();
  palms.forEach((palm, i) => {
    matrix.compose(new THREE.Vector3(palm.x, 0, palm.z), quaternion.setFromEuler(euler.set(0, palm.turn, 0)), new THREE.Vector3(1, palm.height, 1));
    trunks.setMatrixAt(i, matrix);
    for (let k = 0; k < 7; k += 1) {
      matrix.compose(new THREE.Vector3(palm.x, palm.height, palm.z), quaternion.setFromEuler(euler.set(0.45, palm.turn + (k / 7) * Math.PI * 2, 0, "YXZ")), new THREE.Vector3(1, 1, 1));
      fronds.setMatrixAt(i * 7 + k, matrix);
    }
  });
  trunks.castShadow = true; fronds.castShadow = true;
  group.add(trunks, fronds);
}

/** 贴地平面件（球道/果岭/沙坑/停车场）：抬 0.3 + polygonOffset，避免被地形盖住（同环路）。 */
function flat(keep: Keep, color: string, order: number): THREE.MeshLambertMaterial {
  return keep(new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: -2 - order, polygonOffsetUnits: -2 - order }));
}

/** Leaf Links：球道（浅绿长条，两端圆头）、果岭 + 旗杆、沙坑、会所（白墙红陶四坡顶 + 遮阳廊）、阔叶树与棕榈。 */
function drawGolf(ctx: LandmarkCtx): void {
  const { group, landmark, host } = ctx;
  const keep = keeper(host); const clear = clearanceOf(ctx);
  const golf = isletGolf(landmark.reach ?? 0, Math.floor(hashSeed(landmark.id) * 0x7fffffff), landmark.roadZ ?? 0);
  const fairway = flat(keep, "#86d36f", 0); const green = flat(keep, "#a7e78a", 1); const sand = flat(keep, "#f1e2b8", 2);
  for (const f of golf.fairways) {
    const length = Math.hypot(f.bx - f.ax, f.bz - f.az);
    const strip = new THREE.Mesh(keep(new THREE.BoxGeometry(length, 0.05, f.width)), fairway);
    strip.position.set((f.ax + f.bx) / 2, 0.3, (f.az + f.bz) / 2); strip.rotation.y = -Math.atan2(f.bz - f.az, f.bx - f.ax);
    strip.receiveShadow = true; group.add(strip);
    for (const [x, z] of [[f.ax, f.az], [f.bx, f.bz]]) {
      const cap = new THREE.Mesh(keep(new THREE.CylinderGeometry(f.width / 2, f.width / 2, 0.05, 20)), fairway);
      cap.position.set(x, 0.3, z); group.add(cap);
    }
  }
  const pole = keep(new THREE.CylinderGeometry(m(0.04), m(0.04), m(2.5), 5).translate(0, m(1.25), 0)); // 旗杆 2.5 m
  const flag = keep(new THREE.BoxGeometry(m(0.6), m(0.4), m(0.03)).translate(m(0.3), m(2.25), 0));
  const white = keep(new THREE.MeshLambertMaterial({ color: "#f4f4ef" })); const red = keep(new THREE.MeshLambertMaterial({ color: "#e0474c" }));
  for (const g of golf.greens) {
    const disc = new THREE.Mesh(keep(new THREE.CylinderGeometry(g.radius, g.radius, 0.05, 24)), green);
    disc.position.set(g.x, 0.33, g.z); group.add(disc);
    const p = new THREE.Mesh(pole, white); p.position.set(g.x, 0.3, g.z); group.add(p);
    const fl = new THREE.Mesh(flag, red); fl.position.set(g.x, 0.3, g.z); group.add(fl);
  }
  for (const b of golf.bunkers) {
    const disc = new THREE.Mesh(keep(new THREE.CylinderGeometry(1, 1, 0.05, 18).scale(b.rx, 1, b.rz)), sand);
    disc.position.set(b.x, 0.36, b.z); group.add(disc);
  }
  if (golf.clubhouse) {
    const c = golf.clubhouse; const club = new THREE.Group(); club.position.set(c.x, 0, c.z); club.rotation.y = c.yaw; group.add(club);
    const wall = keep(new THREE.MeshLambertMaterial({ color: "#f5efe2" })); const terra = keep(new THREE.MeshLambertMaterial({ color: "#c46f4a" }));
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(18, 4, 9)), wall); body.position.y = 2; club.add(body);
    const roof = new THREE.Mesh(keep(new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4).scale(10.2 * Math.SQRT2, 2.2, 5.6 * Math.SQRT2)), terra);
    roof.position.y = 5.05; club.add(roof);
    const porch = new THREE.Mesh(keep(new THREE.BoxGeometry(14, 0.3, 3)), wall); porch.position.set(0, 3.2, 6); club.add(porch);
    for (const x of [-6.5, -2.2, 2.2, 6.5]) { const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.4, 3.2, 0.4)), wall); post.position.set(x, 1.6, 7.2); club.add(post); }
    club.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }
  // 阔叶树：树干 + 压扁的二十面体树冠（实例化）；少量棕榈
  const onLand = golf.trees.filter((t) => clear(t.x, t.z) >= PALM_ROAD_CLEARANCE);
  const broad = onLand.filter((t) => !t.palm);
  if (broad.length) {
    const trunk = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(0.25, 0.35, 1, 6).translate(0, 0.5, 0)), keep(new THREE.MeshLambertMaterial({ color: "#8a6a4c" })), broad.length);
    const crown = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(1, 0)), keep(new THREE.MeshLambertMaterial({ color: "#3f9a55" })), broad.length);
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion();
    broad.forEach((t, i) => {
      trunk.setMatrixAt(i, m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(1, t.size * 1.2, 1)));
      crown.setMatrixAt(i, m.compose(new THREE.Vector3(t.x, t.size * 1.2 + t.size * 0.7, t.z), q, new THREE.Vector3(t.size * 1.1, t.size * 0.85, t.size * 1.1)));
    });
    trunk.castShadow = true; crown.castShadow = true; group.add(trunk, crown);
  }
  addPalms(group, keep, onLand.filter((t) => t.palm).map((t) => ({ x: t.x, z: t.z, height: m(REAL.palm.min) + t.size, turn: t.x * 0.37 + t.z })));
}

/** Prawn Island：拱顶摄影棚（墙 + 半圆筒屋面 + 卷帘门）、停车场（条纹 + 几辆车）、四脚水塔、沿岸棕榈。 */
function drawStudio(ctx: LandmarkCtx): void {
  const { group, landmark, host } = ctx;
  const keep = keeper(host); const clear = clearanceOf(ctx);
  const studio = isletStudio(landmark.reach ?? 0, Math.floor(hashSeed(landmark.id) * 0x7fffffff));
  const wall = keep(new THREE.MeshLambertMaterial({ color: "#e2dccd" })); const roof = keep(new THREE.MeshLambertMaterial({ color: "#b7b0a0" }));
  const door = keep(new THREE.MeshLambertMaterial({ color: "#6f7a80" })); const steel = keep(new THREE.MeshLambertMaterial({ color: "#9aa3a8" }));
  const solid = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(keep(geometry), material); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
  };
  for (const s of studio.stages) {
    solid(new THREE.BoxGeometry(s.w, s.h, s.d), wall, s.x, s.h / 2, s.z);
    // 拱顶：沿 z 方向的半圆筒（thetaStart π/2、长 π 经 rotateX 得上半环）
    solid(new THREE.CylinderGeometry(s.w / 2, s.w / 2, s.d, 16, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).scale(1, 0.45, 1), roof, s.x, s.h, s.z);
    solid(new THREE.BoxGeometry(s.w * 0.5, s.h * 0.6, 0.15), door, s.x, s.h * 0.3, s.z + s.d / 2 + 0.08);
  }
  if (studio.lot) {
    const l = studio.lot;
    const asphalt = flat(keep, "#5c6264", 0); const stripe = flat(keep, "#e8e4d6", 1);
    const pad = new THREE.Mesh(keep(new THREE.BoxGeometry(l.w, 0.05, l.d)), asphalt); pad.position.set(l.x, 0.3, l.z); group.add(pad);
    const line = keep(new THREE.BoxGeometry(0.15, 0.05, l.d * 0.38));
    const car = keep(new THREE.BoxGeometry(m(REAL.car.width), m(REAL.car.height), m(REAL.car.length)));
    const colors = ["#f3f1ea", "#d0585f", "#2c6f9e", "#e6c14a"].map((c) => keep(new THREE.MeshLambertMaterial({ color: c })));
    for (let x = -l.w / 2 + 1.5; x <= l.w / 2 - 1.5; x += 2.6) for (const side of [-1, 1]) {
      const m = new THREE.Mesh(line, stripe); m.position.set(l.x + x, 0.34, l.z + side * l.d * 0.28); group.add(m);
      const k = Math.floor((Math.abs(x * 7 + side * 3) % 1) * 0 + Math.abs(Math.round(x * 3 + side)) % 5);
      if (k < colors.length) { const c = new THREE.Mesh(car, colors[k]); c.position.set(l.x + x + 1.3, 0.85, l.z + side * l.d * 0.28); c.castShadow = true; group.add(c); }
    }
  }
  if (studio.tower) {
    const t = studio.tower;
    for (const [dx, dz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) solid(new THREE.BoxGeometry(0.3, t.h, 0.3), steel, t.x + dx, t.h / 2, t.z + dz);
    solid(new THREE.CylinderGeometry(2.4, 2.4, 3.2, 14), steel, t.x, t.h + 1.6, t.z);
    solid(new THREE.ConeGeometry(2.6, 1.4, 14), roof, t.x, t.h + 3.9, t.z);
  }
  addPalms(group, keep, studio.palms.filter((p) => clear(p.x, p.z) >= PALM_ROAD_CLEARANCE));
}
