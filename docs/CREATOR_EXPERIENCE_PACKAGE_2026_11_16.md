# 体验包（city-experience）：可交付、可安装、可重建的作品（2026-11-16）

P0 的目标是「把 World、Game、Mount、Assets 组合成可版本化、可安装、可重建的作品，
并在干净客户端上完成安装和启动」。本文记录这一版的**已实现部分**与**诚信边界**。

## 1. 现状（先给结论）

| 能力 | 状态 |
|---|---|
| 打包：已发布 release → 自包含体验包 | ✅ `scripts/build-experience-package.mjs` |
| 安装：把包放进客户端的内容目录 | ✅ 目录式安装（`state/creator/content/experience/<id>/<version>/`），无需 Creator 库 |
| 启动：干净客户端无头跑完发布的门 | ✅ MCP `game_open { experience }`（`apps/agent-city/mcp/experienceStore.mjs`） |
| 自校验：改字节 / 改 metadata / 缺几何 | ✅ 逐字节拒绝（`experience_file_digest_mismatch` / `experience_digest_mismatch` / `experience_layout_incomplete`） |
| 干净客户端验收 | ✅ `scripts/verify-experience-package.mjs`（7 项检查，空 data home） |
| 宿主集成（Studio 按钮 / `creator.experience.*` MCP 工具 / 共享内容库） | ⬜ 仍是脚本级；见 §5 |
| 分发信任（签名 / 来源 / 许可 / 兼容区间） | ⬜ 包是 unsigned，签名不在本切片 |

## 2. 包格式（v1）

```
<package>/
  manifest.json          体验元数据 + 文件清单 + contentDigest
  release.json           冻结发布快照（逐字来自 creator_releases.snapshot_json）
  layout.json            v3 布局快照（anchors + links + 锚点 geometry）
  assets/<sha256>.glb    发布引用到的资产字节（逐字复制，再校验）
```

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "kind": "city-experience",
  "experienceId": "experience-<16 hex>",
  "version": "1.0.0",
  "world": { "cityId": "...", "cityRevision": 4, "seed": 42, "profile": "...",
             "worldRevision": "city-road-v2:42:...", "layoutId": "city-layout-v1:...", "layoutRevision": "..." },
  "release": { "releaseId": "...", "projectId": "...", "revision": 2, "gameType": "flight", "vehicleId": "vehicle-e2e" },
  "assets": [ { "assetId": "...", "relativePath": "...", "sha256": "...", "byteLength": 123,
                "format": "glb-v2", "packagePath": "assets/<sha256>.glb" } ],
  "files": [ { "path": "release.json", "digest": "sha256:...", "byteLength": 1234 } ],
  "contentDigest": "sha256:..."
}
```

校验规则（`apps/agent-city/mcp/experienceStore.mjs`）：

- `contentDigest` = sha256(canonicalJson(manifest 去掉 contentDigest))——任何 metadata 改动都会被发现；
- `files[]` 覆盖每个文件：路径必须在包目录内（拒绝绝对路径与 `..`）、`byteLength` 与 `digest` 都要对；
- `release.json` 与 manifest 的 release 身份一致；`mount.game.digest` 必须等于 `sha256(canonicalJson(game))`；
- `layout.json` 必须是 **v3 且带 geometry**：没有锚点几何的包在干净客户端上无法定位门，
  直接以 `experience_layout_incomplete` 拒绝，而不是跑一局没有门的游戏；
- `manifest.world` 与 `layout.json` 的 `cityId/cityRevision/worldRevision` 必须一致。

`release.json`/`layout.json` 是**逐字**保存的（不重新序列化），这样发布的 digest 语义仍然成立；
重新序列化会把键序、空格的变化带进摘要。

## 3. 打包

```bash
node --experimental-transform-types --import ./scripts/mecha-ts-register.mjs \
  scripts/build-experience-package.mjs \
  --release release-2ff764c228f49b54e0d39ee8d90dcce7 --out /tmp/exp-pkg
```

- 读 `<data_home>/state/creator/projects.sqlite`（只读）与项目资产目录；
- 资产按 `assets.entries[].sha256` 定位 `<data_home>/state/creator/projects/<projectId>/assets/<sha256>.glb`，
  逐字节校验后复制；摘要不符就中止（`experience_asset_digest_mismatch`）；
- `experienceId` 由 `(projectId, revision)` 派生，同一发布重复打包得到同一个 id；`version` 由调用方给。

## 4. 干净客户端安装与启动

安装 = 把包目录放进客户端的内容目录，客户端只需要这一个目录：

```
<client-home>/state/creator/content/experience/<experienceId>/<version>/
```

启动（无头，不需要 Creator 库、不需要 Studio）：

```jsonc
// tools/call game_open
{ "experience": "<client-home>/state/creator/content/experience/<id>/<version>" }
```

返回与 `releaseId` 模式相同的形状（`gates` 来自包里的 layout geometry，`gateSource: "layout-geometry"`），
后续 `game_script` / `game_state` / `game_trace` 不变。

实测（真实发布 `release-2ff764c2…`，3 道空域门，半径 20 m，x=150/300/450）：

```
ok  clean client has no Creator store
ok  installed package is self-contained
ok  launch from package (no store) — gates 3
ok  published gates are flown from the package — passed 3/3, outcome success, tick 270, digest 401bdf3f02e035ee
ok  gate geometry came from the package layout — []
ok  tampered bytes is rejected — experience_file_digest_mismatch
ok  tampered metadata is rejected — experience_digest_mismatch
verify-experience-package: ok (7 checks)
```

`tick 270 / digest 401bdf3f02e035ee` 与发布库直读模式**逐位一致**——同一份冻结快照、同一套判定，
包没有引入第二套玩法语义。

（带 `--package <已有包>` 时是 7 项；上面的验收命令会先打包，因此多一项 build，共 8 项。）

验收命令：

```bash
node --experimental-transform-types --import ./scripts/mecha-ts-register.mjs scripts/verify-experience-package.mjs
node --experimental-transform-types --import ./scripts/mecha-ts-register.mjs \
  --test apps/agent-city/ui/tests/city-game-mcp.test.mjs   # 含包模式与三类坏包的 CI 级断言
```

## 5. 仍未做（诚实边界）

1. **宿主集成**：目前打包/安装/启动是脚本 + 无头 MCP；还没有
   `creator.experience.build/install/launch` 这类 MCP 工具、没有 Studio 的「导出体验包」按钮、
   也没有把包注册进 `creator_content_packages` 的共享内容库（现有 `creator.content.install`
   只处理 `city-world` 包）。干净客户端因此是「脚本可复现」而不是「装完点一下就能玩」。
2. **驾驶体验**：包里带 `seed/profile/worldRevision`，City 世界可由它们确定性重建（2026-11-16
   已验证重生成的 `worldRevision` 与发布一致），但本版无头启动只走「布局快照里的门」，
   驾驶需要路网/出生轨迹的那条路径尚未接到包模式。
3. **分发与信任**：没有签名、没有来源/许可校验、没有 SDK 兼容区间（`minCityRuntimeVersion` 未进包），
   包只应在本机/可信来源之间流转。
4. **资产覆盖**：格式按项目资产存储（`glb-v2`）逐字节打包；资产去重、GC、配额都没有。
5. **版本升级语义**：同 `experienceId` 不同 `version` 可并存，但没有「升级/回滚」操作面。

## 6. 与既有文档的关系

- 发布物（release）本身仍不是独立分发包：它只引用 `(cityId, cityRevision, worldRevision, layoutId)`，
  资产字节在项目内容寻址存储里 —— 见 `docs/CREATOR_CONTENT_INSTALL_2026_11_14.md` §1。
  体验包就是在发布物之上把「布局快照 + 资产字节」补齐成可拷走的一份。
- 无头启动的输入词汇见 `docs/CITY_GAME_MCP.md`。
