# Hello City

第一条纵向切片的可玩样本：一个 run-owned 立方体沿 City 可信路线移动到终点，HUD
显示分段与里程，到达后 `finish("success")`，退出时实体清零。

- `game.manifest.json`：权限只要 `world.read` / `roads.read` / `entities.write.owned` / `ui.hud`。
- `src/index.ts`：`listRoutes()[0]` 取当前世界的可信路线（不硬编码 `city-main-road`），
  逐段推进；没有路线就 setup 失败，而不是静默结束。
- `assets/cube.glb`：796 字节的最小合法 GLB（24 顶点索引盒），供真实 City 渲染使用。

```bash
npm test    # 构建 + 无头跑完整条路线
npm run build
```

构建走 `packages/city-game-sdk/scripts/buildGame.ts`（P0 原型）：Manifest 校验 →
esbuild 打包 → `buildId = sha256(源文件树 + 工具链版本)`；产物写到 `dist/<buildId>/game.js`，
`build.json` 记录 buildId、SDK 版本与字节数。正式链路会换成 Studio 的受控构建服务。
