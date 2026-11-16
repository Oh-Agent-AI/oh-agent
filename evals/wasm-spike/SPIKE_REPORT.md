# SPIKE REPORT：city-sdk WASM 语义闸工具链验证（W1，spec §11.3）

日期：2026-11-16。worktree：`skill-vitals-wt/studio-p1`（分支 `feat/wasm-spike`，基线 dev `e97718af`）。

**一句话结论：有条件可行。** 同一份 city-sdk TS 校验器（`validateVehicleProfileV1`）的两条 WASM 承载路径——quickjs-emscripten（Node 内嵌 WASM QuickJS）与 Javy（JS→.wasm→wasmtime）——对全部 6 个验收向量都产出了与 Node 原生执行**逐字节相同**的诊断 JSON。唯一发现的不兼容点（QuickJS 系引擎在 `u` 模式下拒绝字符类内 `\-` 转义）用一次**语法等价**的打包期改写绕过，已如实记录并给出上游修复建议。

---

## 1. 实现路径与各自结果

### 路径 1（首选）：quickjs-emscripten —— 成功

- npm 包 `quickjs-emscripten@0.31.0`（默认 `getQuickJS()` = `@jitl/quickjs-wasmfile-release-sync`，即 Bellard quickjs 的 release-sync WASM 构建，wasm 二进制 518,880 B）。
- 消费的是 city-sdk `npm run build` 出的 **dist 字节**（`packages/agent-vitals-city-sdk/dist/index.js`，esbuild `platform: neutral` 产物），spike 侧用 esbuild 把 dist 再打包成 IIFE 脚本（`globalName: citySdk`），以普通脚本 eval 进 QuickJS——不改 city-sdk 的构建配置，不改任何既有源码。
- **dist 纯度核实**：`dist/index.js` 无 `process.*`、无 Node builtin、无 DOM 引用。`TextEncoder` 与 `globalThis.crypto?.subtle` 只出现在包摘要/内容包校验函数的**调用时**路径，`validateVehicleProfileV1` 全程不触及；顶层只有常量表与函数定义，QuickJS 加载成功。
- 结果：主 bundle（全量 dist）与 tree-shaken 后的 validator-only bundle 都在 QuickJS 里跑通，6/6 验收向量与 Node 原生逐字节一致（见 §3）。

### 路径 2（备选）：Javy —— 成功

- `javy-arm-macos-v9.1.0`（GitHub release v9.1.0，下载到 worktree 外 `/tmp/wasm-spike-javy/`，sha256 校验通过：`99e9ec6a…51e6294`），执行器 `wasmtime 50.0.1`（同样下载到 /tmp、按不可信数据处理）。
- 输入源 = 已打补丁的 validator-only IIFE bundle + stdin/stdout 入口（`Javy.IO.readSync/writeSync`，见 `scripts/build-javy-input.mjs`），单文件交给 `javy build`。
- 两种链接形态都验证了：
  - 静态（`-C dynamic=n`）：自包含 .wasm 1,400,028 B，`wasmtime run validate-vehicle.wasm < profile.json` 直接可跑；
  - 动态（`-C dynamic -C plugin=plugin.wasm`）：模块仅 42,317 B + 插件 1,341,751 B，`wasmtime run --preload javy-default-plugin-v4=plugin.wasm …` 可跑。**注意：官方文档写 `javy-default-plugin-v5`，v9.1.0 实际命名空间是 `javy-default-plugin-v4`**（按模块 import 里的命名空间实测纠正）。
- 结果：6/6 验收向量与 Node 原生逐字节一致（`scripts/run-javy.mjs`，每次 wasmtime 调用 ~13–16ms，含进程启动与 JIT；首个冷调用 330ms 含首次页加载）。

### 明确不做（按任务边界）

- 未做 wasmtime 进 Rust 宿主的集成（宿主侧后续单独立项）；未做 AssemblyScript 重写（破坏单一来源，禁止）；未改宿主（apps/desktop）、MCP crate、Studio UI、既有测试。

---

## 2. 发现的关键不兼容点（spike 最大价值所在）

**QuickJS（Bellard 与 quickjs-ng 两个引擎都）在 `u` 模式下拒绝字符类内的 `\-` 转义**：

```
/^[a\-z]$/u  →  SyntaxError: invalid escape sequence in regular expression   （QuickJS 两引擎）
/^[a\-z]$/u  →  V8 接受；ES 规范（ClassEscape :: -）允许
```

而 `vehicleProfile.ts` 的 LABEL 正则恰好含一个 `\-`：

```ts
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .·、（）()\-]{0,126}$/u;
```

处理：spike 打包脚本对 dist 产物做一次**断言唯一命中**的机械改写 `（）()\-]{0,126}` → `（）()-]{0,126}`（`scripts/build-spike.mjs`）。语义依据：字符类内 `\-` 与 `-` 表示同一个字面连字符（两引擎在非 `u` 模式、V8 在两种模式下行为一致），是语法等价改写，不触及校验语义；但它确实是「WASM 侧执行字节 ≠ Studio 执行字节」的一处有意识偏离，宿主集成时必须把它记进产物 digest 锁步的契约里。

**上游修复建议（本次不改 city-sdk）**：把 `\-` 写成 `-`（它就在 `]` 前，不需要转义），或至少在 city-sdk 的 JS API 支持清单（`docs-using-js-api-support.md` 类文档）里钉住这条 QuickJS 语法差异。改完后 spike 的补丁步骤会因找不到 marker 而显式失败——那时删掉补丁即可。

除此之外探测过的面均兼容：`\p{L}\p{N}` unicode 属性类（类内也支持）、`u` flag、dotAll、lookbehind、`??`、`?.`、`Object.values/freeze`、`String.includes`、`Number.isFinite`、`toFixed(3)`、数字格式化（含 1/3、66.66666666666667 等与 V8 逐位一致）、`JSON.parse` 重复键取后者（与 V8 一致）。

---

## 3. 验收向量逐条判定

对照组 = 同一输入在 Node 22 原生（V8，import dist/index.js）下的 `JSON.stringify(result)`；两面各用自家引擎 `JSON.parse` 同一份 JSON 文本再校验。逐字节 `Buffer` 比对。

命名说明：任务简报里的 `creator_vehicle_*` 是**宿主结构闸**的错误码（`apps/desktop/src-tauri/src/creator_projects.rs`）；TS 校验器本身发 `vehicle_profile_*` 码。本 spike 对比的正是 TS 校验器，故按其真实码判定，映射关系：`vehicle_profile_invalid ↔ creator_vehicle_invalid`、`vehicle_profile_out_of_bounds ↔ creator_vehicle_out_of_bounds`、`vehicle_profile_unphysical ↔ creator_vehicle_unphysical`。

| # | 向量 | 输入 | 期望 | 判定（路径1 QuickJS / 路径2 Javy） |
|---|------|------|------|------|
| 1 | 合法 preset | `ORNITHOPTER_VEHICLE_PRESET_V1` 契约 JSON（label 扑翼机） | ok:true，diagnostics 一致 | **一致 / 一致**（首个字节 diff：无；value 与 diagnostics 全字节同） |
| 2 | 越界 | `physics.maxSpeedMps = 999` | `vehicle_profile_out_of_bounds` @ `physics.maxSpeedMps` | **一致 / 一致**（同 code/path/message） |
| 3 | 非物理比值 | `physics.wingAreaM2 = 2.0`（翼载荷 170 > 120） | `vehicle_profile_unphysical` @ `physics.wingAreaM2` | **一致 / 一致**（message 含 `170.000 kg/m²`，`toFixed` 输出同） |
| 4 | 未知键 | 顶层多一个 `extra: 1` | `vehicle_profile_invalid` | **一致 / 一致** |
| 5 | 非对象输入 | JSON `42` | `vehicle_profile_invalid`（单条致命诊断） | **一致 / 一致** |
| 6 | 附加：schemaVersion=2 | `schemaVersion = 2` | `vehicle_profile_unsupported` | **一致 / 一致**（超出任务要求，顺带钉住） |

附加一致性断言（`wasm-spike.test.mjs`）：

- 两边 bundle 内的 `ORNITHOPTER_VEHICLE_PRESET_V1` **常量表**序列化后与契约 JSON 相同（跨 bundle 常量钉住）；
- 直接校验「各自 bundle 加载出的 preset 对象」（不经 JSON.parse）也逐字节一致；
- tree-shaken validator-only bundle（30,775 B）同样 6/6 一致；
- 退出码等价（`ok` 标志）逐向量一致。

**首处差异：无** —— 所有向量在两个 WASM 承载路径下都未出现任何字节差异（对比函数 `firstDiffOffset` 返回 null）。

---

## 4. 体积与耗时（Apple Silicon (arm64) macOS，Node 22.23.1，粗测）

体积：

| 产物 | 字节 |
|------|------|
| city-sdk dist/index.js（esbuild ESM） | 168,704 |
| spike 全量 IIFE bundle（dist 再打包） | 176,240 |
| **validator-only IIFE bundle（tree-shaken，宿主集成真正需要的形态）** | **30,775** |
| quickjs-emscripten release-sync .wasm（QuickJS 引擎本体） | 518,880 |
| Javy 静态模块（含内嵌引擎） | 1,400,028 |
| Javy 动态模块 + 插件 | 42,317 + 1,341,751 |

耗时（quickjs-emscripten 路径，release-sync 变体）：

| 阶段 | 数值 |
|------|------|
| WASM 实例化（getQuickJS 冷启动） | ~5–7 ms |
| 全量 dist bundle 加载 + 编译（QuickJS 内） | ~20 ms |
| entry shim 注入 | ~1 ms |
| 加载后首次校验 | ~0.5 ms |
| 稳态单次校验（纯解释器内） | ~66 µs |
| 稳态单次校验（含 evalCode 桥往返，宿主集成现实上界） | ~87–93 µs |
| 对照：Node 原生 V8 单次校验 | ~4 µs |

Javy 路径：`javy build` ~0.3–1 s；`wasmtime run` 每次进程级调用 ~13–16 ms（含 wasmtime 启动 + 模块 JIT；作为长驻宿主内的可调用模块时这个数字不适用，仅说明 CLI 级延迟）。语义闸是每次写操作一次校验，µs 级稳态耗时完全不构成瓶颈；V8→QuickJS 的 ~20 倍解释器开销只在批量场景才需要关注。

---

## 5. 全量铺开的可行性与风险清单

**结论：有条件可行。** 工具链与确定性已证明（两条独立路径、同一 dist 字节、6/6 逐位一致）；铺开前必须处理以下条件与风险。

覆盖面（其它校验器能否走同一路径）：

- **大概率同路径可用**：worlds（`validateWorldProfile`/`validateWorldParameters`/`validateWorldPlanPatch`）、gameTypes（`validateGameTypeDescriptorV1`）、session/内容包等校验器与 vehicleProfile 同属纯 JSON-in/JSON-out、无 Node builtin 依赖的纯函数；本 spike 的全量 dist bundle（含它们全部）在 QuickJS 里加载并校验通过，说明**打包层**没有隐藏的运行时依赖。
- **注意两点**：① 内容包/包摘要校验用到 `TextEncoder`（字节数上限）与 `globalThis.crypto.subtle`（SHA-256）——QuickJS 两者皆无，铺开时需在 QuickJS 全局里注入确定性等价物（TextEncoder 可纯 JS 实现；SHA-256 需宿主经宿主函数桥接或换成 WASM 原生实现并做逐位锁步测试）；② `hasDuplicateJsonKeys`/runtime 等更深的功能未单独验证。
- **正则面是系统性风险**：dist 里还有其它 `\p{...}`/unicode 正则（如 `/\p{Cc}/u`），本机探测均通过，但 QuickJS 系引擎的语法子集与 V8 的差异是这类迁移的主要坑源；铺开时应对**全部**校验器输入向量做同规格逐字节锁步（现有 tests/*.test.ts 的向量可直接复用为锁步集）。

风险清单（按严重度）：

1. **（已发现）QuickJS 正则语法子集差异**：`\-` 类内转义被拒。缓解 = 上游去掉该转义（首选）或打包期等价改写 + digest 锁步契约。任何 dist 正则的新增语法都要过 QuickJS 探针。
2. **执行字节与 Studio 字节偏离**：补丁 + 未来任何 tree-shake/压缩都会让「同一份 TS」变成「同源不同字节」。spec §11.2 的缓解（产物 digest 钉住 + 同输入逐位锁步）必须落成 CI 门槛：Node 原生 × WASM 两面的全量校验向量集在每次 city-sdk 构建时跑一遍，任何字节差异即 fail。
3. **数字格式化的边界**：诊断 message 里的 `toFixed(3)` 与 JSON 数字序列化在抽样值上与 V8 逐位一致，但 IEEE-754 双精度的极端值（denormal、超大数、-0）未穷举；锁步测试集应加入数值边界向量。
4. **生命周期纪律**：quickjs-emscripten 的 handle 泄漏会在 `JS_FreeRuntime` 触发断言 abort（spike 期间亲测）。宿主集成必须封装统一的 eval/dispose 生命周期（spike 的 `quickjs-host.mjs` 已示范），并在长驻运行时上配 `runtime.setMemoryLimit/setInterruptHandler`（本次未启用）。
5. **Javy 特有**：动态模块被钉死在 QuickJS 字节码 + 插件版本（升级需重编译）；文档与实际 plugin 命名空间不一致（v4 vs v5）；每次 `javy build` 的确定性可用 `-C deterministic=y` 保证（本次未启用，铺开时建议启用以便产物 digest 可复现）。
6. **体积**：宿主若走 Javy 静态形态要背 1.34 MB wasm；quickjs-emscripten 形态是 519 KB 引擎 + 30 KB 校验器 bundle；Javy 动态形态模块最小（42 KB）但要求运行时提供插件 import。桌面宿主（Rust）后续选型时按「长驻单例 + 一次实例化」的模型，三个数字都可接受。

## 6. 宿主侧集成建议（后续立项，本 spike 不做）

1. **载体选型**：建议宿主 Rust 进程内嵌 QuickJS 运行时（wasmtime + quickjs-emscripten 同款引擎的 wasm 构建，或 Javy 动态模块 + 插件），长驻单例、进程启动时一次实例化（~30 ms 冷启动一次付清），请求式 `JSON text in → diagnostics JSON out`，全程不跨桥传对象。
2. **产物契约**：把「WASM 承载的 validator bundle」升级为 city-sdk 的版本化构建产物（独立 digest），与 dist 一起钉进构建锁文件；CI 增加双面锁步（Node × WASM 全量向量逐字节比对），失败即拒绝发布。
3. **语义信封**：宿主自签发与 Studio 同源的语义信封时，把 bundle digest + 引擎标识（quickjs 变体与版本）写进信封，让「哪份产物、在哪个引擎里算的」可审计。
4. **双门独立性**：按 spec §11.2，结构闸（Rust `creator_projects.rs`）保留不动；WASM 语义闸只作为 Studio webview 不可用时的权威回退，同进程两校验器的独立性靠产物 digest 锁步维持。

## 7. spike 产物清单（全部新文件，均在 `evals/wasm-spike/`）

- `vectors.mjs` — 6 个验收向量（含命名映射注释）。
- `native-host.mjs` — Node 原生执行面（import dist）。
- `quickjs-host.mjs` — QuickJS 执行面（bundle 加载、向量执行、bench、探针）。
- `wasm-spike.test.mjs` — 逐字节比对测试（6 项断言全绿）。
- `bench.test.mjs` — 体积/耗时测量（node --test 输出数字）。
- `probe.mjs` — 环境探针（JS 特性支持、数字格式化、QuickJSVersion）。
- `variant-compare.mjs` / `regex-isolate.mjs` — `\-` 类内转义不兼容点的隔离与双引擎取证。
- `scripts/build-spike.mjs` — dist → IIFE 打包 + 唯一命中断言的 QuickJS 兼容补丁。
- `scripts/entry-validator.mjs` — tree-shaken validator-only 入口。
- `scripts/build-javy-input.mjs` / `scripts/run-javy.mjs` — Javy 腿的输入生成与 wasmtime 执行比对。
- 复现：
  - 路径 1：`cd evals/wasm-spike && npm install && npm run build && npm test`（前置：`cd packages/agent-vitals-city-sdk && npm run build`）。
  - 路径 2：`npm run javy:input`，然后在 /tmp 下 `javy build -C dynamic=n -o validate-vehicle.wasm build/javy-entry.js`，`npm run javy:run`（二进制路径见脚本头注释）。
