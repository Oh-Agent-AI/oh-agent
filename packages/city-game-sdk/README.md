# @oh-agent/city-game-sdk

Agent 写的 TypeScript 游戏（Code Game）的公共 API、协议与受信任宿主。设计依据：
`docs` 中的 City Game SDK PRD（P0 纵向切片：TS 源码 → 构建 → City 预览 → 清理）。

## 入口

| 入口 | 用途 | 谁能 import |
|---|---|---|
| `.` | `defineGame()`、World/Entity/Input/UI/Clock/Random 类型 | 游戏工程 |
| `./protocol` | `CodeGameManifestV1` 校验、权限词表、稳定诊断码 | 构建服务 / Host / MCP |
| `./host` | `CodeGameHostV1`、`WorldSourceV1`、`RenderPortV1` | City 适配层（可信代码） |
| `./testing` | `createGameTestWorld()` 无头测试床 | 测试与 Agent 自检 |

**exports 子路径不是安全边界。** 沙箱里的社区包必须根本不能 import `./host`；
P0 只运行用户明确授权的本地源码，`./host` 的可达性由部署形态决定，而不是由
`exports` 的字符串决定。

## 最小游戏

```ts
import { defineGame } from "@oh-agent/city-game-sdk";

export default defineGame({
  id: "community.hello-city",
  setup(ctx) {
    const id = ctx.entities.spawn("cube", { position: [0, 0, 0] });
    ctx.onFixedUpdate((dt) => {
      ctx.ui.setHud({ tick: ctx.clock.nowMs() });
      ctx.entities.update(id, { position: [dt * 100, 0, 0] });
    });
  },
});
```

## 宿主契约

- 一个 Host 只拥有一个 run；`prepare()` 之后 `start()`，`step()` 是**一次**权威固定步。
  固定步时钟属于 City，Host 不自带 `requestAnimationFrame`，也不读墙钟。
- 状态机：`created → preparing → ready → running ⇄ paused → finished | failed`。
  `dispose()` 幂等；`finished` 只表示结果已定，清理在同一个终止路径里完成。
- 清理顺序：`onDispose` 回调 LIFO → `setup` 返回的 disposer 最后 → Host 销毁所有
  仍在场的实体（每个实体恰好一次 `render.destroy`）。
- 权限在**每次调用**时复查；`manifest.permissions` 缺失即 `game_permission_denied`，
  不依赖 TypeScript 类型。
- 实体所有权是结构性的：实体表属于单个 Host，别的 run 的 id 在这里不存在。
- `world.*` 的返回值按 run 缓存并深冻结；City revision 变化时适配层必须 `stop()`，
  Host 不轮询世界版本（那是租约的职责）。
- 确定性随机是 mulberry32（整数运算），同一 seed 在 City WebView 与 Node 中产生同一序列；
  `clock.nowMs()` 只用于诊断，不能参与胜负判定。

## 状态

已实现（P0 切片）：Manifest 校验、公共 API 类型、Host 生命周期、固定步、
实体预算与所有权、权限门、HUD、确定性随机、幂等清理、无头测试床；原型构建服务
（`scripts/buildGame.ts`：Manifest 校验 → esbuild → 内容摘要 buildId）；`games/hello-city`
模板与端到端无头运行；City v3 layout → `WorldSourceV1` 投影
（`apps/agent-city/ui/src/game/codeGameHost/cityWorldSource.ts`）。

City 侧已实现：v3 快照与实时 layout（arterial road edges + terrain field）两种
`WorldSourceV1` 投影、`CodeGameRunV1` 会话（
`CityActivityCoordinator` 租约 → `HostGameScenePort` 场景租约 → Host，City 帧驱动
`FixedStepClock`，世界换版/大帧差/失败统一回收）、`createThreeCodeGameRender`
（共享几何/材质、实体→Mesh、相机跟随、一次性 detach）、`useCodeGamePreview`
（dev-only `?codeGame=` 入口；与未来 Studio/MCP 预览共用同一条 production 路径）。

浏览器验收：`npm run preview:code-game` → `npm run dev` →
`node tests/code-game-city.browser.mjs http://127.0.0.1:5199`。它会在真实 City 里跑完
hello-city：实体存在 → tick 前进 → `route_complete` → 实体归零。

未实现（后续切片）：真实 GLB 资源加载（当前是共享立方体占位）、Studio 受控构建作业
（Vite/类型检查/产物索引）、Studio MCP 的 `creator_code_*` 工具、Experience V2 打包。

## 命令

```bash
cd packages/city-game-sdk
npm ci
npm test          # 34 个契约测试，Node 直接跑 TS（无需先 build）
npm run typecheck # tsc --noEmit，lib 只有 ES2022（无 DOM）
npm run build     # 声明 + esbuild 四入口
```

`tests/boundary.test.ts` 是可执行边界守卫：源码不得 import Three/React/Tauri/Node 内建、
不得读 `Date.now()`/`performance.now()`，公开 API 层不得依赖 host/testing 内部。
