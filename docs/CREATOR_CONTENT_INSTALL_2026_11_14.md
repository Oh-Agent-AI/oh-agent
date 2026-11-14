# 内容包本机安装（2026-11-14）

状态：**本机安装已实现**；内容包仍不可运行为 City，也不代表来源可信或可分发。

## 1. 流程

1. Studio「项目 › 世界内容包预检」调用 `creator.content.inspect`：
   - 宿主打开原生选择器；路径/字节不进入 MCP 或 WebView。
   - Rust 读取有界文件、拒绝符号链接/变化中的文件、验证重复键/路径/文件集合/摘要。
   - 返回预检摘要，并附**一次性 `inspectionId`**（10 分钟 TTL、最多 8 个、绑定 Studio 实例）。
2. 用户在预检结果旁点「安装到本机内容库」：
   - Studio 调 `creator.content.install { inspectionId }`，不传路径。
   - 宿主重新读取同一路径并重新验证；确认 `packageId/version/contentDigest` 与预检一致后才落盘。
   - 任何变化返回 `content_file_changed`，不安装。
3. 安装结果与已安装列表通过 `creator.content.list` 展示；`creator.content.uninstall` 删除。
   卸载用「卸载 → 确认卸载」两段式按钮，不依赖 `window.confirm`（Tauri WebView 下原生 confirm
   不可靠，首版真机点击会静默无响应）。切到项目面板时重新拉取已安装列表，避免插件 ready 前的
   首次请求失败后一直显示空列表。

## 2. 存储与原子性

- 内容库：`<data_home>/state/creator/content/world/<packageId>/<version>/package.json`。
- 元数据：`creator_content_packages`（packageId、version、kind、contentDigest、manifest、相对路径、fileCount、byteLength、installedAtMs）。
- 写入顺序：校验 → 临时目录写文件 + `sync_all` → 原子 rename 到最终目录 → DB insert。
  DB insert 失败会删除本次创建的最终目录；不会留下“DB 有、文件无”的半安装。
- 崩溃恢复：若 rename 后 DB 写入前崩溃，会留下孤儿目录；再次安装同一文件时校验孤儿字节并**收养**记录，
  不覆盖不同内容。
- 卸载：先删除目录，再删除 DB 行；路径必须是 `world/` 下的安全相对路径。
- 同一 `packageId+version` 不同 `contentDigest` 拒绝为 `content_package_conflict`；相同摘要重复安装返回
  `alreadyInstalled: true`。

## 3. 明确的边界

- 安装**不**执行、不加载、不注册城市；独立 City 运行时/切换仍是未完成能力。
- 不校验来源/签名/许可证/运行时兼容；内容包仍是 unsigned。
- 不把路径或文件字节返回给 Studio UI、Agent 或 MCP。
- 没有磁盘配额/垃圾回收；内容库由用户显式卸载。

## 4. 测试

- `creator_content_install`：幂等安装、identity drift 拒绝、卸载/列表、崩溃孤儿收养、token 一次性/实例绑定。
- Rust 文件入口：普通文件通过、缺失/目录拒绝。
- Studio：预检结果、已安装列表/安装结果的严格解析；`npm test` 15 项、typecheck 通过。

## 5. 桌面真机验证（2026-11-14 22:07）

- 重新构建 `.app` 后从 LaunchServices 启动，Creator Studio → 项目 → 世界内容包预检。
- 原生选择器选择 `pack-world` 生成的 `arid-dunes@1`（1365 bytes，3 个文件）：
  界面显示「完整性预检通过：可安装到本机内容库……安装后仍不可运行」。
- 点击「安装到本机内容库」后：
  - `creator_content_packages` 出现 `arid-dunes|1|sha256:7ca82de3…|3|1365`；
  - 文件写入 `state/creator/content/world/arid-dunes/1/package.json`；
  - UI 显示 `arid-dunes@1 · 3 个文件 · 2 KiB · 仅本机安装`。
- 点击「卸载」变为「确认卸载」，再次点击后文件与 DB 行均删除，状态显示「已卸载 arid-dunes@1」。
- 重新预检并安装成功。
- 注意：预检结果文案里的“当前不可安装”已改为“可安装到本机内容库”；`window.confirm` 在
  Tauri WebView 下不可靠，卸载改为两段式按钮；切到项目面板会重新拉取已安装列表。
