/**
 * L-3 地中海复兴庄园（villa-complex）：白灰泥长条主体 + 临水连续拱廊 + 红陶四坡顶 + 端头方形钟塔。
 * 程序化原创几何（CITY_PLANNING_SPEC §4.4 / CITY_LANDMARK_BACKLOG L-3）：只提取「地中海复兴」这一
 * 风格语言的通用类型学（白灰泥、低坡陶瓦四坡顶、半圆拱券柱廊、campanile），不参照任何单体建筑。
 *
 * 它是全城 9 种地标里唯一的低层纪念性建筑：靠 60+ 单位的横向体量（而不是 70 单位的塔尖）
 * 在海湾静水岸成立——临水一面用连续拱廊投出节奏阴影，钟塔作唯一的竖向对位。
 *
 * 配色刻意不随城市粉彩走：粉彩是「执行环境」的语义色，庄园是「地点」——
 * 固定在白灰泥 #f3efe4 系与陶瓦赭红 #c46f4a 系，seed 只做少量明度与比例微调。
 *
 * 坐标约定：局部原点 = 占地中心（含钟塔的整体包围盒居中），y=0 为地面，正面（拱廊面）朝 +Z；
 * position/yaw 由调用方（cityParts.buildLandmarks）设置。
 */
import * as THREE from "three";
import { villaGeometryParameters, villaSeedStream } from "./models/villaGeometry";

/** 选址半径（与 sail-opera 同档）：整体占地（含钟塔）x 向 ≈ 64.6–67.0 ≤ 2×半径，供 cityPlan 的 snap/clearance 用。 */
export { VILLA_SITE_RADIUS } from "./models/villaGeometry";

export type LandmarkBuild = {
  group: THREE.Group;
  disposables: Array<THREE.BufferGeometry | THREE.Material>;
  spinners: Array<{ object: THREE.Object3D; axis: "y" | "z"; speed: number }>;
};

/** 纯静态建筑，无旋转动画：spinners 恒为空数组，占位以满足 LandmarkBuild 契约。 */
export function buildVillaComplex(seed: number, neon: boolean): LandmarkBuild {
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

  // seed（约定为 hashSeed 派生的 [0,1)，但也兼容整数入参）经整数雪崩派生多条互不相关的恒定随机流：
  // 整数部分与小数部分分别折进 32 位状态——否则 42×2³² 的低 32 位是 0，所有整数 seed 会坍缩成同一座庄园。
  // 不用 Math.random，保证同 seed 逐字节复现。
  const stream = (salt: number): number => villaSeedStream(seed, salt);

  const material = (color: string, emissive = 0): THREE.MeshLambertMaterial => {
    // 与 cityParts.buildLandmarks 同一惯用法：Lambert + 自发光色 = 基色乘系数，进 bloom 即成霓虹/灯室。
    const m = new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(emissive) });
    disposables.push(m);
    return m;
  };
  const useGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    disposables.push(geometry);
    return geometry;
  };
  const mesh = (geometry: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // ── seed 派生的比例微调（幅度刻意小：庄园的身份靠类型学轮廓，不靠每次变形）──
  // 主体长取 backlog 规格下限 60 起步：占地必须压在 2×VILLA_SITE_RADIUS=68 内
  // （台基两端各出 0.6、钟塔再悬出 4.0，主体+塔共 ≈ 64.6–67.0），拉长只会挤掉钟塔；
  // 低层纪念性靠 60:13 的横竖比（≈4.6:1）成立，不需要更长。
  const params = villaGeometryParameters(seed);
  const { bodyL, bodyD, wallTop, deckTop, bays, margin, pitch, pierS, pierH, archR, bodyCx, towerX } = params;

  const group = new THREE.Group();
  group.name = "city-landmark-villa-complex";

  // ── 配色：庄园本色，不取主题粉彩 ──
  const stucco = material(new THREE.Color("#f3efe4").multiplyScalar(0.97 + stream(4) * 0.05).getStyle()); // 白灰泥，±5% 明度
  const terra = material(new THREE.Color("#c46f4a").multiplyScalar(0.94 + stream(5) * 0.09).getStyle()); // 陶瓦赭红
  const trim = material("#e9e0c9"); // 台基/线脚：比灰泥略深的暖石色，勾出水平分层
  const dark = material("#77664f"); // 窗洞/灯室开口：暖深褐（百叶的远处读法），不发光
  const glow = material("#ffd98c", neon ? 1.25 : 0.3); // 拱廊暖黄灯带：夜景增强，白天仍是微暖的内廊色
  const lamp = material("#ffedb8", neon ? 1.15 : 0.85); // 钟塔灯室：常亮（L-3 夜景要求），neon 只提亮度

  // ── 台基与踏步：把整组建筑从地形上「托」起来，前端（+Z，临水）给两步下行的台阶 ──
  const deck = useGeometry(new THREE.BoxGeometry(params.deckWidth, deckTop, params.deckDepth));
  mesh(deck, trim, group, bodyCx, deckTop / 2, 0);
  const step = useGeometry(new THREE.BoxGeometry(params.stepWidth, params.stepHeight, params.stepDepth));
  mesh(step, trim, group, bodyCx, params.firstStepY, params.firstStepZ);
  const step2 = useGeometry(new THREE.BoxGeometry(params.stepWidth, params.stepHeight, params.stepDepth));
  mesh(step2, trim, group, bodyCx, params.secondStepY, params.secondStepZ);

  // ── 主体：两层长条灰泥盒 ──
  const body = useGeometry(new THREE.BoxGeometry(bodyL, wallTop, bodyD));
  mesh(body, stucco, group, bodyCx, deckTop + wallTop / 2, 0);

  // 檐口：比墙身宽一圈的薄带，是灰泥立面在远处唯一的高光水平线（地中海立面的影子檐）
  const cornice = useGeometry(new THREE.BoxGeometry(bodyL + 1.6, 0.65, bodyD + 1.2));
  mesh(cornice, stucco, group, bodyCx, deckTop + wallTop + 0.325, 0);

  // ── 红陶四坡顶：低坡（坡高 2.5 : 覆盖宽 ~16 ≈ 1:3.2）是地中海复兴的关键比例，
  // 坡太陡就变成北欧大屋顶；出檐 1.4–1.5 让屋顶在墙上投出自己的影子带。
  // 4 棱锥转 45° 再压成矩形（pagoda 檐同一惯用法，这里拉到全高成真四坡顶）。
  const roofH = 2.5;
  const roofHX = params.roofWidth / 2;
  const roofHZ = params.roofDepth / 2;
  const roof = useGeometry(new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4).scale(roofHX * Math.SQRT2, roofH, roofHZ * Math.SQRT2).translate(0, deckTop + wallTop + 0.65 + roofH / 2 - 0.1, 0));
  mesh(roof, terra, group, bodyCx, 0, 0);

  // ── 临水连续拱廊（+Z 面）：外挑 2.8 的柱廊——纯内凹廊在远处没有影子，外挑才有节奏阴影。
  // 墩、券、窗全部共享几何（重复构件本来就该同一块 buffer）。
  const arcade = new THREE.Group();
  arcade.name = "villa-arcade";
  group.add(arcade);
  const arcadeRun = bodyL - margin * 2;
  const start = bodyCx - arcadeRun / 2;
  const archDepth = 3.4;
  const pier = useGeometry(new THREE.BoxGeometry(pierS, pierH, pierS));
  // 半圆柱券：thetaStart=π/2、长度 π 经 rotateX(π/2) 恰为「上半环」，两端自带半圆封板，无破面
  const arch = useGeometry(new THREE.CylinderGeometry(archR, archR, archDepth, 14, 1, false, Math.PI / 2, Math.PI).rotateX(Math.PI / 2));
  const archCx = deckTop + pierH; // 券心在墩顶：半圆拱脚落在方墩上（经典半圆拱的受力读法）
  for (let i = 0; i <= bays; i += 1) {
    mesh(pier, stucco, arcade, start + i * pitch, deckTop + pierH / 2, 7.6);
  }
  for (let i = 0; i < bays; i += 1) {
    // 券心 = 两墩中点：半径取净跨一半，券脚两端正落在相邻墩顶
    mesh(arch, stucco, arcade, start + (i + 0.5) * pitch, archCx, 7.6);
  }
  // 上横楣（廊顶）：把整排券收进一条水平带；顶上再压一条陶瓦压顶线勾出廊檐
  const crown = archCx + archR;
  const entablature = useGeometry(new THREE.BoxGeometry(arcadeRun + pierS, 0.85, archDepth + 0.4));
  mesh(entablature, stucco, arcade, bodyCx, crown + 0.425, 7.4);
  const coping = useGeometry(new THREE.BoxGeometry(arcadeRun + pierS + 0.8, 0.16, archDepth + 0.6));
  mesh(coping, terra, arcade, bodyCx, crown + 0.93, 7.4);

  // 暖黄灯带：贴在横楣前脸的一条发光细带（y 压在楣中，读作「廊内透光」而不是贴牌）
  const strip = useGeometry(new THREE.BoxGeometry(arcadeRun - 0.6, 0.26, 0.14));
  mesh(strip, glow, arcade, bodyCx, crown + 0.32, 7.4 + (archDepth + 0.4) / 2 + 0.03);

  // 上层窗带：每跨一窗、与拱廊轴线对位——立面的上下两层共用同一节奏，这是「窗带节奏」的来源。
  // 窗带压着檐口下沿（顶 8.9 < 檐口底 8.95），保证不被廊檐压顶线（最高 7.585）遮住任何高度。
  const win = useGeometry(new THREE.BoxGeometry(1.5, 1.3, 0.16));
  for (let i = 0; i < bays; i += 1) {
    mesh(win, dark, group, start + (i + 0.5) * pitch, 8.25, bodyD / 2 + 0.06);
  }

  // ── 端头方形钟塔（campanile）：全组唯一竖向体量 ≈ 屋脊的 2 倍，
  // 但 23.6 ≤ 30 仍属「低层纪念性」的配角高度——它标出庄园的一端，不和天际线塔群争高。
  const campanile = new THREE.Group();
  campanile.name = "villa-campanile";
  group.add(campanile);
  const plinth = useGeometry(new THREE.BoxGeometry(params.towerBaseWidth, params.towerBaseHeight, params.towerBaseWidth));
  mesh(plinth, trim, campanile, towerX, params.towerBaseY, 0);
  const shaftH = 15.1;
  const shaft = useGeometry(new THREE.BoxGeometry(4.4, shaftH, 4.4));
  mesh(shaft, stucco, campanile, towerX, 1.9 + shaftH / 2, 0);
  const string = useGeometry(new THREE.BoxGeometry(4.9, 0.5, 4.9));
  mesh(string, trim, campanile, towerX, 17.25, 0);
  // 灯室：整块自发光（lighthouse 灯室同一表达），四角灰泥柱与深色开口把它「框」成开敞钟室
  const lampH = 3;
  const lampRoom = useGeometry(new THREE.BoxGeometry(4.6, lampH, 4.6));
  mesh(lampRoom, lamp, campanile, towerX, 17.5 + lampH / 2, 0);
  const post = useGeometry(new THREE.BoxGeometry(0.55, lampH + 0.3, 0.55));
  const opening = useGeometry(new THREE.BoxGeometry(1.7, 1.7, 0.18));
  for (const px of [-1, 1]) {
    mesh(post, stucco, campanile, towerX + px * 2.18, 17.5 + lampH / 2, 2.18);
    mesh(post, stucco, campanile, towerX + px * 2.18, 17.5 + lampH / 2, -2.18);
    mesh(opening, dark, campanile, towerX + px * 2.31, 18.75, 0).rotation.y = Math.PI / 2;
    mesh(opening, dark, campanile, towerX, 18.75, px * 2.31);
  }
  // 穹盖：半球压扁 0.72——钟塔顶的小穹顶比全球矮胖，才像 campanile 而不像洋葱头；
  // 用整球下半截藏进灯室里，避免开口面被俯视穿帮
  const dome = useGeometry(new THREE.SphereGeometry(2.7, 14, 10).scale(1, 0.72, 1));
  mesh(dome, terra, campanile, towerX, 20.3, 0);
  const finialRod = useGeometry(new THREE.CylinderGeometry(0.14, 0.14, 1, 6).translate(0, 0.5, 0));
  mesh(finialRod, terra, campanile, towerX, 22.15, 0);
  const finialBall = useGeometry(new THREE.SphereGeometry(0.32, 8, 6));
  mesh(finialBall, terra, campanile, towerX, 23.3, 0);

  return { group, disposables, spinners: [] };
}
