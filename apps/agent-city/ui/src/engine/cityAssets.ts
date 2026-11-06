/**
 * 城市贴图素材（CC0 / MIT，来源见 ../assets/LICENSES.md）。
 *
 * 全部随应用打包（Vite 解析为本地 URL），运行时不联网。加载是异步的：
 * 场景先用程序化纹理画出来，素材到齐后原地替换——素材缺失或解码失败时城市照常可用，
 * 只是退回程序化外观（不得因为一张图让整页白屏）。
 */

import * as THREE from "three";
import skyDayUrl from "../assets/sky-day.jpg";
import skyDuskUrl from "../assets/sky-dusk.jpg";
import asphaltColorUrl from "../assets/ground-asphalt-02-color.jpg";
import asphaltNormalUrl from "../assets/ground-asphalt-02-normal.jpg";
import concreteColorUrl from "../assets/ground-concrete-pavement-02-color.jpg";
import concreteNormalUrl from "../assets/ground-concrete-pavement-02-normal.jpg";
import sandColorUrl from "../assets/ground-coast-sand-01-color.jpg";
import sandNormalUrl from "../assets/ground-coast-sand-01-normal.jpg";
import mudColorUrl from "../assets/ground-brown-mud-02-color.jpg";
import mudNormalUrl from "../assets/ground-brown-mud-02-normal.jpg";
import grassColorUrl from "../assets/ground-aerial-grass-rock-color.jpg";
import grassNormalUrl from "../assets/ground-aerial-grass-rock-normal.jpg";
import facadeGlassUrl from "../assets/facade-glass.jpg";
import facadeCommercialUrl from "../assets/facade-commercial.jpg";
import facadeBandedUrl from "../assets/facade-banded.jpg";
import stuccoNormalUrl from "../assets/stucco-normal.jpg";
import waterNormalUrl from "../assets/water-normal.jpg";

export type GroundLayer = { color: THREE.Texture; normal: THREE.Texture };

export type CityAssets = {
  sky: { day: THREE.Texture; dusk: THREE.Texture };
  ground: { asphalt: GroundLayer; concrete: GroundLayer; sand: GroundLayer; mud: GroundLayer; grass: GroundLayer };
  /** 与 facadeFor 的变体序号对齐：0 居住横带 / 1 商业 / 2 市中心玻璃幕墙。 */
  facades: [THREE.Texture, THREE.Texture, THREE.Texture];
  stuccoNormal: THREE.Texture;
  waterNormal: THREE.Texture;
};

let pending: Promise<CityAssets | null> | null = null;

/** 进程内只加载一次；切换主题、分页重建 parts 都复用同一批纹理（它们不进 parts 的 dispose）。 */
export function loadCityAssets(): Promise<CityAssets | null> {
  if (pending) return pending;
  const worker = typeof document === "undefined";
  const bitmapLoader = worker ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY" }) : null;
  const loader = worker ? null : new THREE.TextureLoader();
  const load = (url: string, color: boolean, repeat = true) => (bitmapLoader
    ? bitmapLoader.loadAsync(url).then((image) => { const texture = new THREE.Texture(image); texture.flipY = false; texture.needsUpdate = true; return texture; })
    : loader!.loadAsync(url)).then((texture) => {
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    return texture;
  });
  const sky = (url: string) => load(url, true, false).then((texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.wrapS = THREE.RepeatWrapping;
    return texture;
  });
  const layer = (color: string, normal: string) => Promise.all([load(color, true), load(normal, false)]).then(([c, n]) => ({ color: c, normal: n }));
  pending = Promise.all([
    sky(skyDayUrl), sky(skyDuskUrl),
    layer(asphaltColorUrl, asphaltNormalUrl), layer(concreteColorUrl, concreteNormalUrl), layer(sandColorUrl, sandNormalUrl),
    layer(mudColorUrl, mudNormalUrl), layer(grassColorUrl, grassNormalUrl),
    load(facadeBandedUrl, true), load(facadeCommercialUrl, true), load(facadeGlassUrl, true),
    load(stuccoNormalUrl, false), load(waterNormalUrl, false),
  ]).then(([day, dusk, asphalt, concrete, sand, mud, grass, banded, commercial, glass, stucco, water]) => ({
    sky: { day, dusk },
    ground: { asphalt, concrete, sand, mud, grass },
    facades: [banded, commercial, glass] as [THREE.Texture, THREE.Texture, THREE.Texture],
    stuccoNormal: stucco,
    waterNormal: water,
  })).catch((error) => {
    console.warn("[city] texture assets unavailable, keeping procedural look", error);
    return null;
  });
  return pending;
}
