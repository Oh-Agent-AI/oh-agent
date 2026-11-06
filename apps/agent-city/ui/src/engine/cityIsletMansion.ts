/**
 * 豪宅岛庄园（islet-mansion）：湾心小岛上的海湾现代豪宅——白灰泥两层错位体量 + 前悬挑上层 + 薄出檐平屋顶 +
 * 通长深色玻璃带，前院石材台地、泳池、躺椅、棕榈，临水私家木码头与一艘飞桥游艇；半数 seed 附一栋红陶四坡顶客房。
 * 程序化原创几何：只取「迈阿密海湾豪宅」的通用类型学（白盒子 + 大玻璃 + 泳池 + 码头游艇，Vice City 的 Starfish Island
 * 是同一母题），不参照任何单体建筑或游戏模型。
 *
 * 和 villa-complex（地中海庄园，岸线地标）的分工：那是 65 长的纪念性单体；这里是「住宅尺度」——主楼 22 长、两层 ~8 高，
 * 一座岛南北各一栋，靠泳池/码头/游艇这些生活道具成立，而不是靠体量。
 *
 * 坐标约定：局部原点 = 主楼台地中心，y=0 为地面，正面（泳池/码头面）朝 +Z（朝外侧水面）；背面 -Z 是穿岛堤道。
 * reach = 原点到岸线的距离：码头从台地前沿铺到岸线外 6，岛大岛小码头都入水。
 * 配色固定（白灰泥 / 石材 / 深玻璃 / 陶瓦），不取执行环境粉彩——它是「地点」不是数据。
 */
import * as THREE from "three";
import { villaSeedStream } from "./models/villaGeometry";
import type { LandmarkBuild } from "./cityLandmarkVilla";

export function buildIsletMansion(seed: number, neon: boolean, reach = 30): LandmarkBuild {
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  const stream = (salt: number): number => villaSeedStream(seed, 100 + salt);
  const material = (color: string, emissive = 0): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive) });
    disposables.push(m);
    return m;
  };
  const geometry = <T extends THREE.BufferGeometry>(g: T): T => { disposables.push(g); return g; };
  const box = (w: number, h: number, d: number) => geometry(new THREE.BoxGeometry(w, h, d));
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Mesh => {
    const out = new THREE.Mesh(g, m);
    out.position.set(x, y, z);
    out.castShadow = true;
    out.receiveShadow = true;
    parent.add(out);
    return out;
  };

  const group = new THREE.Group();
  group.name = "city-landmark-islet-mansion";

  const stucco = material(new THREE.Color("#f6f3ec").multiplyScalar(0.97 + stream(1) * 0.04).getStyle());
  const stone = material("#e4d9c3");      // 台地/池岸：暖石灰华
  const glass = material("#35596a", neon ? 0.18 : 0.04); // 深青玻璃：白天读作反光的暗带
  const interior = material("#ffd9a0", neon ? 1.1 : 0.25); // 玻璃后的暖光条：夜里整条透光
  const pool = material("#3fd3dc", neon ? 0.55 : 0.12);    // 池水：夜里池灯
  const terra = material("#c46f4a");
  const wood = material("#9a7350");
  const hedge = material("#2f7a4d");
  const trunk = material("#a98462");
  const leaf = material("#2fbf77");
  const hull = material("#f7f7f2");
  const accent = material(stream(2) < 0.5 ? "#2c6f9e" : "#d0585f"); // 游艇腰线：深蓝或珊瑚，seed 选一

  // ── 台地：整组托在一块石材平台上（离地 0.5），前沿 +12 给泳池与躺椅 ──
  const plinthW = 34; const plinthD = 26; const plinthH = 0.5;
  mesh(box(plinthW, plinthH, plinthD), stone, group, 0, plinthH / 2, 0);
  const floor = plinthH;

  // ── 主楼：一层 22×12 白盒压在台地后半；二层 16×10 右移 3、前挑 2.5（悬挑在一层玻璃带上方投出深影）──
  const shift = (stream(3) - 0.5) * 4; // 二层左右错位 ±2：同一母题的两栋不完全一样
  const g1W = 22; const g1D = 12; const g1H = 3.6; const g1Z = -5;
  mesh(box(g1W, g1H, g1D), stucco, group, 0, floor + g1H / 2, g1Z);
  const g2W = 16; const g2D = 10; const g2H = 3.4; const g2X = 3 + shift; const g2Z = g1Z + 2.5;
  mesh(box(g2W, g2H, g2D), stucco, group, g2X, floor + g1H + g2H / 2, g2Z);
  // 平屋顶薄檐：比二层四周各出 1.1，是这类住宅在远处最清楚的那条水平线
  mesh(box(g2W + 2.2, 0.35, g2D + 2.2), stucco, group, g2X, floor + g1H + g2H + 0.175, g2Z);
  // 一层屋顶（二层没盖住的部分）做露台：一条白色栏板收边
  mesh(box(g1W, 0.9, 0.2), stucco, group, 0, floor + g1H + 0.45, g1Z + g1D / 2 - 0.1);

  // 玻璃带：一层正面通长、二层正面略短；玻璃后贴一条暖光条（夜里透光，白天几乎不显）
  const g1Glass = box(g1W - 3, 2.3, 0.15);
  mesh(g1Glass, glass, group, 0, floor + 1.45, g1Z + g1D / 2 + 0.08);
  mesh(box(g1W - 4, 0.25, 0.1), interior, group, 0, floor + 2.4, g1Z + g1D / 2 + 0.17);
  mesh(box(g2W - 2.5, 2.1, 0.15), glass, group, g2X, floor + g1H + 1.5, g2Z + g2D / 2 + 0.08);
  mesh(box(g2W - 3.5, 0.25, 0.1), interior, group, g2X, floor + g1H + 2.4, g2Z + g2D / 2 + 0.17);
  // 侧窗：二层两端各一竖条，侧看不是一块实心白盒
  for (const side of [-1, 1]) mesh(box(0.15, 2.1, 3.2), glass, group, g2X + side * (g2W / 2 + 0.08), floor + g1H + 1.5, g2Z + 1.5);

  // ── 客房（半数 seed）：红陶四坡顶小屋，放主楼左侧——同一座岛上现代与地中海并存 ──
  if (stream(4) < 0.5) {
    const gW = 8; const gD = 7; const gH = 3; const gX = -g1W / 2 - 1 - gW / 2 + 2; const gZ = -8;
    mesh(box(gW, gH, gD), stucco, group, gX, floor + gH / 2, gZ);
    const roofH = 1.8;
    mesh(geometry(new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4).scale((gW / 2 + 0.8) * Math.SQRT2, roofH, (gD / 2 + 0.8) * Math.SQRT2)),
      terra, group, gX, floor + gH + roofH / 2 - 0.05, gZ);
    mesh(box(1.4, 1.2, 0.12), glass, group, gX, floor + 1.7, gZ + gD / 2 + 0.07);
  }

  // ── 前院：泳池（嵌在台地上沿，水面略低于池岸）、躺椅一排 ──
  const poolW = 12; const poolD = 4.6; const poolX = -3 + stream(5) * 4; const poolZ = 6.5;
  mesh(box(poolW + 1.2, 0.12, poolD + 1.2), stone, group, poolX, floor + 0.06, poolZ);
  mesh(box(poolW, 0.14, poolD), pool, group, poolX, floor + 0.1, poolZ);
  const lounger = box(0.9, 0.35, 2.1);
  for (let i = 0; i < 4; i += 1) mesh(lounger, hull, group, poolX - poolW / 2 + 1.5 + i * 2.6, floor + 0.18, poolZ + poolD / 2 + 2.2);

  // 背面绿篱：贴台地后沿，把住宅和穿岛的堤道隔开
  mesh(box(plinthW - 2, 1.4, 1.2), hedge, group, 0, floor + 0.7, -plinthD / 2 + 0.8);

  // ── 棕榈三棵：台地两前角 + 泳池旁；树干微斜，叶冠 7 片下垂叶片 ──
  const palmTrunk = geometry(new THREE.CylinderGeometry(0.22, 0.32, 1, 6).translate(0, 0.5, 0));
  const frond = geometry(new THREE.BoxGeometry(0.5, 0.08, 3.4).translate(0, 0, 1.7));
  const palm = (x: number, z: number, height: number, lean: number) => {
    const tree = new THREE.Group();
    tree.position.set(x, floor, z);
    tree.rotation.y = lean * 7;
    group.add(tree);
    const stem = mesh(palmTrunk, trunk, tree, 0, 0, 0);
    stem.scale.set(1, height, 1);
    stem.rotation.x = 0.12;
    const top = new THREE.Vector3(0, height, 0).applyEuler(stem.rotation);
    for (let k = 0; k < 7; k += 1) {
      const f = mesh(frond, leaf, tree, top.x, top.y, top.z);
      f.rotation.set(0.45, (k / 7) * Math.PI * 2, 0, "YXZ");
    }
  };
  palm(-plinthW / 2 + 2, plinthD / 2 - 2, 7.5 + stream(6) * 2, stream(7));
  palm(plinthW / 2 - 2, plinthD / 2 - 3, 6.5 + stream(8) * 2, stream(9));
  palm(poolX + poolW / 2 + 2, poolZ - 1.5, 5.5 + stream(10) * 1.5, stream(11));

  // ── 私家码头：从台地前沿铺到岸线外 10，桩每 4 一对；码头面比岛面低 0.6（贴近水面）──
  const dockX = plinthW / 2 - 6;
  const dockStart = plinthD / 2;
  const dockEnd = Math.max(dockStart + 8, reach + 6);
  const dockLen = dockEnd - dockStart;
  const dockY = -0.6;
  mesh(box(3, 0.3, dockLen), wood, group, dockX, dockY, dockStart + dockLen / 2);
  const pile = box(0.35, 2.4, 0.35);
  for (let z = dockStart + 2; z <= dockEnd; z += 4) for (const side of [-1, 1]) mesh(pile, wood, group, dockX + side * 1.5, dockY - 1.1, z);
  // 码头端头平台：一块横向的 T 头，游艇靠在它旁边
  mesh(box(8, 0.3, 3), wood, group, dockX, dockY, dockEnd - 1.5);

  // ── 游艇：靠在码头外侧，船头朝外（+Z）；白船身 + 腰线 + 两层上建 + 深色舷窗带 ──
  const yacht = new THREE.Group();
  yacht.position.set(dockX + 5.5, -1.1, dockEnd - 6);
  group.add(yacht);
  const hullL = 11; const hullW = 3.2;
  mesh(box(hullW, 1.3, hullL), hull, yacht, 0, 0, 0);
  // 船头：四棱锥压扁成尖首，接在船身前端
  mesh(geometry(new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4).rotateX(Math.PI / 2).scale(hullW / Math.SQRT2, 1.3 / Math.SQRT2 * 0.95, 3.2)),
    hull, yacht, 0, 0, hullL / 2 + 1.55);
  mesh(box(hullW + 0.04, 0.22, hullL), accent, yacht, 0, 0.25, 0);
  mesh(box(hullW - 0.8, 1.1, 5.5), hull, yacht, 0, 1.2, -0.8);
  mesh(box(hullW - 0.76, 0.35, 5.2), glass, yacht, 0, 1.35, -0.8);
  mesh(box(hullW - 1.4, 0.8, 2.8), hull, yacht, 0, 2.15, -1.4);

  return { group, disposables, spinners: [] };
}
