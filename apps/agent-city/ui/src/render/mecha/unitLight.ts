/**
 * 机甲的夜间补光：只注入机甲自己的材质，不往场景里加灯。
 *
 * 为什么不加场景灯：three 的灯照亮整个场景，棋盘上加一盏补光，整座夜城跟着变亮，城市的夜景预算（曝光压低
 * 约 0.35 EV、亮的只有窗和路灯）就被打穿了。
 *
 * 为什么机甲夜里会变成黑块：GLB 的调色板里骨架 / 炮钢 / 镀铬三档金属度 0.55 / 0.8 / 0.9，城市没有环境贴图，
 * 金属面只剩太阳和路灯的高光；入夜太阳降到 0.32、曝光再压低，这三档几乎全黑，只剩蓝色装甲板浮在暗处，
 * 腿、关节、炮的形状读不出来。所以补两项，都按「夜」量渐入，白天为 0（白天外观不变）：
 *  - 半球补光：按法线朝上 / 朝下在天色与地色之间取色，乘 diffuseColor——金属面也拿到，相当于一张极简的环境光；
 *  - 边缘光：Fresnel，把剪影从暗背景里勾出来（与 FlightVisuals 的 addRimLight 同一做法）。
 * 片元里只多几条指令，零额外 draw call、零额外灯光。
 */
import * as THREE from "three";

/** 所有机甲材质共用一组 uniform：棋盘每帧写一次，没写过的页面（模型预览、测试）保持 0，外观不变。 */
export const MECHA_UNIT_LIGHT = {
  mechaFill: { value: 0 },
  mechaRim: { value: 0 },
  mechaSky: { value: new THREE.Color("#a9c2e2") },
  mechaGround: { value: new THREE.Color("#3d342b") },
  mechaRimColor: { value: new THREE.Color("#d4e8ff") },
};

/** 夜量 [0,1] → 补光强度。数值在 ?demo=1 机甲战棋的夜景里对照截图定的。 */
export const MECHA_NIGHT_FILL = 0.55;
export const MECHA_NIGHT_RIM = 0.45;

export function setMechaUnitLight(night: number): void {
  const n = Math.min(1, Math.max(0, night));
  MECHA_UNIT_LIGHT.mechaFill.value = MECHA_NIGHT_FILL * n;
  MECHA_UNIT_LIGHT.mechaRim.value = MECHA_NIGHT_RIM * n;
}

const patched = new WeakSet<THREE.Material>();

function patch(material: THREE.Material): void {
  if (patched.has(material) || !(material instanceof THREE.MeshStandardMaterial)) return;
  patched.add(material);
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, MECHA_UNIT_LIGHT);
    shader.fragmentShader = shader.fragmentShader
      .replace("uniform vec3 emissive;", `uniform vec3 emissive;
uniform float mechaFill;
uniform float mechaRim;
uniform vec3 mechaSky;
uniform vec3 mechaGround;
uniform vec3 mechaRimColor;`)
      // 加在 outgoingLight 上（色调映射之前），和场景灯走同一条曝光
      .replace("#include <opaque_fragment>", `{
  float mechaUp = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
  outgoingLight += diffuseColor.rgb * mechaFill * mix(mechaGround, mechaSky, 0.5 + 0.5 * mechaUp);
  float mechaFresnel = 1.0 - abs(dot(normalize(vViewPosition), normal));
  outgoingLight += mechaRimColor * mechaRim * pow(mechaFresnel, 3.0);
}
#include <opaque_fragment>`);
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => key() + "|mecha-unit-light";
  material.needsUpdate = true;
}

/** 给一个机甲根节点下的所有材质装上补光（重复调用安全：同一材质只装一次）。 */
export function applyMechaUnitLight(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) patch(material);
  });
}
