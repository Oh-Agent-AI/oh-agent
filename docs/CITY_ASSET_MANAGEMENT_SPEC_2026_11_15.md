# City 资产管理规格（CAS、引用账本、GC）

状态：提案，待实施与验收；2026-11-15。本文是设计提案，不表示列出的能力已经实现。

关联：[City 项目目录与内容交付规范](CITY_PROJECT_DIRECTORY_SPEC_2026_11_14.md)、
[自定义 City MCP 设计 §4 风格与资产](CREATOR_STUDIO_CUSTOM_CITY_MCP_DESIGN_2026_11_14.md)、
[内容包本机安装](CREATOR_CONTENT_INSTALL_2026_11_14.md)、
[City SDK 内容 MVP §4-§5](AGENT_CITY_SDK_CONTENT_MVP_SPEC_2026_11_11.md)、
[边界收口记录 §4 预算分层](CREATOR_BOUNDARY_CLOSEOUT_2026_11_14.md)、仓库 `AGENTS.md` 数据政策。

## 1. 现状与问题

资产字节目前存在三处，引用关系散落四处，没有统一账本：

| 字节位置 | 内容 | 寻址 |
|---|---|---|
| 应用 bundle（`apps/agent-city/ui/src/assets/`） | flora/mecha GLB、主题贴图 | 构建期打包，无 digest |
| `state/creator/projects/<id>/assets/<sha256>.glb` | 用户导入模型 | 内容寻址 |
| `state/creator/content/world/<pkg>/<ver>/package.json` | v2 内容包整包 | 包级 digest |

引用关系只存在于项目文档 `assets.entries`、release 快照、场景 model 对象与包 manifest 中，
读取时逐次重扫证明（`read_city_release_asset`）。具体问题：

1. **物理重复**：同一 GLB 导入多个项目、打包进多个内容包时各存一份副本。
2. **只增不减**：没有项目/城市删除路径、没有引用计数、没有 GC 与磁盘配额。
3. **引用证明成本高**：每次读取都重新解析并摘要整个 release 快照。
4. **官方资产没有可引用身份**：flora/mecha 是"代码即资产"，官方内容项目
   （`worlds/miami` 等）无法以版本化 digest 引用它们。
5. **预算分散**：导入（GLB ≤ 64 MiB）、内容包（≤ 128 文件 / 100 MiB）、运行时
   （≤ 32 资产 / 256 MiB / 512 模型实例）各管一段，用户对磁盘总量无感知。

## 2. 设计原则

1. **内容寻址是唯一真相**：`sha256` 是资产身份；字节与引用分离。
2. **物理共享、逻辑隔离**：同 digest 共享只读字节；引用与修改权限按城市/项目隔离
   （自定义 City 设计 §4 已确立的原则，本文补实现）。
3. **归属三层不混淆**：官方应用 / 用户项目 / 安装包；官方身份不继承给内容包，
   内容包不得引用包外字节（闭包校验不变）。
4. **被引用即不可删**：清理只作用于零引用资产，显式触发、先预览后删除。
5. **本机优先**：CAS 是本机存储；不新增任何网络行为、遥测或上传。
6. **CAS 是存储层，不是新的信任边界**：所有写入仍走既有校验入口
   （`inspect_glb`、内容包完整性、预算 clamp）；读侧沿用逐请求授权。

## 3. 对象与身份

| 对象 | 身份 | 权威 |
|---|---|---|
| Asset 字节 | `sha256`（64 位小写十六进制） | CAS 文件系统；注册表记录元数据 |
| Asset 记录 | `digest` | `creator_assets` 表 |
| 引用 | `(owner_kind, owner_id, digest)` | `creator_asset_refs` 表 |
| Owner | `project` / `release` / `city_instance` / `content_package` | 各自既有服务 |

- `assetId`（项目内目录名）与 `relativePath` 仍是**引用侧**概念：同一 digest 可在同一
  项目内挂多个 assetId（不禁止，计入预算），跨项目各自命名。
- 资产 `kind` 初版为 `model-glb`；贴图等类型待后续按需扩展，不预留无法校验的开放枚举。

## 4. 存储布局

```text
state/assets/cas/<sha256 前 2 位>/<sha256>      # 唯一字节存储（新）
state/creator/projects/<id>/assets/<sha256>.glb # 迁移期兼容读取；切换后移除
state/creator/content/world/<pkg>/<ver>/...     # 内容包按包存储不变（见 §8）
```

- 写入路径（项目导入、内容包安装、导出落盘）在完成各自既有校验后写 CAS，并在同一
  事务内写 `creator_assets` 与 `creator_asset_refs`；CAS 文件先落盘 + `sync_all`，
  注册表后提交，与内容包安装的"孤儿收养"模式一致：崩溃留下的无记录 CAS 文件在下次
  同 digest 写入时按字节校验收养。
- 读取路径（`ohcityasset://` 协议、`read_city_release_asset`、Studio 导出）改为
  CAS 定位；迁移期旧路径作为回退，切换完成后移除。

## 5. 引用账本与读取路径

```sql
CREATE TABLE creator_assets (
  digest TEXT PRIMARY KEY, byteLength INTEGER NOT NULL,
  kind TEXT NOT NULL, createdAtMs INTEGER NOT NULL);
CREATE TABLE creator_asset_refs (
  owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
  digest TEXT NOT NULL, createdAtMs INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, digest));
```

- 引用写入与所有者状态变更同事务：项目提交（catalog/场景/挂载）、release 发布、
  内容包安装/卸载、实例创建/删除。卸载被引用内容包仍按现行规则拒绝并列出引用。
- `read_city_release_asset` 改为查 `creator_asset_refs` 证明归属（release owner），
  再读 CAS 并校验字节 digest；快照重扫保留为失败兜底与迁移期核对，不再是常规路径。
- 引用计数只增删于明确所有者生命周期；**不**做跨所有者推导（如"另一个项目也引用了
  同 digest"不产生权限）。

## 6. 删除、GC 与配额

1. **删除保护**：`refs > 0` 的 digest 拒绝清理，返回稳定错误码
   `asset_referenced` 并列出引用所有者类别与数量（不泄露路径）。
2. **GC**：显式触发（宿主 UI 命令 + MCP 有界查询），先返回将清理的 digest 清单
   （数量与字节量），用户确认后删除；删除为幂等操作。
3. **配额**：新增用户级磁盘上限（默认值实现时定，写入描述符预算分层文档并加守卫）；
   达到上限时新导入返回 `asset_quota_exceeded` 与可修复提示。各层既有预算数值不变、
   不合并（延续预算分层定稿）。
4. 项目/城市删除能力本身是第 3 步之前的独立前置：先有引用账本与删除保护，
   才能安全提供删除。

## 7. 官方资产清单

- 构建期从 `apps/agent-city/ui/src/assets/` 生成版本化 digest 清单（模式同
  `assets/creator/templates-index.json` 与皮肤目录锁步测试），钉进仓库并加锁步守卫：
  应用资产变更而清单未更新时测试失败。
- 官方内容项目（`worlds/miami` 等）在 `design/` 引用这些 digest，使官方世界的资产
  归属可审计，也为沙海之门专属资产（巨门、砂岩建筑）立项提供落位。
- **官方资产对自定义世界的开放性是产品决议**：现行规范禁止内容包引用官方字节，
  决议前维持禁止；CAS 不为此预留绕行路径。

## 8. 与 v2 内容包 / 游戏复用

- 内容包安装仍按 `packageId/version` 整包落盘（清单与闭包校验不变）；安装时把
  包内文件的 digest 注册为 `content_package` 引用。**物理字节是否同时进 CAS 是
  实施决议**：建议初期双存（包自包含优先，CAS 记录 digest 索引），待包读取路径
  改造后再切换为 CAS 单存，避免破坏"包 = 完整闭包"的现行保证。
- v2 game 包落地后，游戏资产走同一 CAS 与闭包校验：同 digest 跨包共享物理字节由
  CAS 天然实现，引用仍按包隔离；同一 game 包可绑定多个 City 实例（挂载按布局快照），
  模型运行时按 `releaseId:digest` 缓存去重（现状保留）。
- 贴图压缩（KTX2/Basis）、运行时 LRU 等内存优化为独立后续，不与本文绑定。

## 9. 迁移路径

1. **双轨**：新增 CAS + 两表；新写路径落 CAS，读路径保留旧目录回退。
2. **收养**：启动或显式触发时按 digest 扫描旧目录，字节校验通过则登记
   `creator_assets` 并建立对应引用，不移动用户可见路径。
3. **切换**：读取全部走 CAS，写入停止落旧目录；运行对照验收（同一项目导入、
   发布、试玩、导出前后行为一致）。
4. **清理**：旧目录在确认无兼容需求后移除；黄金/对照基线如涉及路径需显式更新
   并说明。

## 10. 实施顺序与验收门槛

| 切片 | 交付 | 验收 |
|---|---|---|
| A0 | 引用账本两表 + 写路径同事务登记 | 现有导入/发布/安装回归全绿；账本与文档 JSON 一致性核对测试 |
| A1 | 删除保护 + 引用查询（含 MCP 有界查询） | 被引用资产拒绝清理并列出引用；跨项目引用不产生权限 |
| A2 | CAS 落地 + 读取切换（`ohcityasset://`、release 资产、导出） | 同一项目导入/发布/试玩/导出行为对照一致；同 digest 双项目物理单份 |
| A3 | 存量收养 + 旧路径移除 | 收养幂等；崩溃孤儿按字节收养；旧路径删除后全链路回归 |
| A4 | GC + 配额 | 零引用清理先预览后删除；配额超限返回可修复错误；既有预算分层不变 |
| A5 | 官方资产 digest 清单 + 锁步守卫 | 资产变更未更新清单时测试失败；官方内容项目可引用 digest |

每切片记录构建版本、迁移前后 digest 对照与失败诊断；自动化覆盖账本一致性、
引用保护、收养幂等与配额拒绝。桌面真机验收覆盖导入→发布→试玩→导出→卸载全链路，
并以 GC 前后可玩性不变为准。纯 schema 测试不能替代真机结果。

## 11. 明确不做与待决议

- 不做跨机器同步、去重上传、内容网络分发（数据政策不变）。
- 不做资产级差异/补丁（GLB 二进制整存）。
- 不在本规格内开放内容包引用官方资产（§7 产品决议）。
- 项目/城市删除的完整产品语义（含会话数据清理）另行设计，本文只保证资产侧安全。
