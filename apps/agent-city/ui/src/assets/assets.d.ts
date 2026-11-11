// Vite 把 import 的 .jpg 解析为打包后的 URL（随应用离线分发，运行时不联网）。
declare module "*.jpg" {
  const url: string;
  export default url;
}
// .glb 用 ?url 导入：Vite 默认不把 .glb 当静态资源，直接 import 会被当成 JS 解析而报错。
declare module "*.glb?url" {
  const url: string;
  export default url;
}
// 游戏背景音乐 .m4a 走 ?url 导入（本地资产随应用离线分发，运行时不联网）。
declare module "*.m4a?url" {
  const url: string;
  export default url;
}
// 机甲 GLB 的清单（JSON）也走 ?url：运行时 fetch，资产随应用离线分发。
declare module "*.json?url" {
  const url: string;
  export default url;
}
