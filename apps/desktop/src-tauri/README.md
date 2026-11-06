# Oh Agent 桌面应用（Tauri 2）

当前产品介绍见[根 README](../../../README.md)。桌面应用包含托盘、React 工作台和
Agent City 内置插件：本机历史可视化、用量与费用分析、会话证据，以及版本相关的探索玩法。
对外品牌为 Oh Agent；桌面应用 Bundle ID 为 `ai.ohagent.desktop`（Apple 开发者后台注册的显式 App ID，Team EUKB6WHY6Z，不改名）。macOS 应用包名为 `Oh Agent.app`，下载文件名为 `oh-agent-<版本>-<架构>.dmg`。CLI 与数据目录继续使用 `agent-vitals`，以保留兼容性。

- **后端**：Rust host 负责本机数据访问与受限投影，资源 CLI 随安装包分发。
  插件不直接查询 authority DB 或读取日志；计价和证据口径遵守仓库数据契约。
- **前端**：`../ui-dev/react/` 是 React 工作台源码，生产入口为 `ui-react-dist/`。
  构建钩子准备工作台、官方插件与 CLI；不是无 npm 依赖的旧版纯 HTML 工作台。
  City 源码位于 `../../agent-city/ui/`。
- **交互**：左右键点托盘图标都弹同一个菜单（今日/本月/预算/打开工作台/立即
  同步/退出）——跟多数状态栏图标的通用手势一致，不再区分左右键语义。
  2026-09-01 之前这里还有一个独立的弹出小面板（`toggle_window`，右键单独弹、
  内容是"总览"tab 的严格子集）；面板本身对着菜单里的"打开工作台…"就已经冗余
  （内容更少），统一左右键手势之后它又连入口都没有了，所以连同
  `ui/index.html`/`main.js`/`style.css`、`hide_window` IPC、`tauri.conf.json`
  的 `overview` 窗口条目一起删除——只剩工作台一个窗口。

## 构建

```bash
# 图标：从 1024×1024 源图派生全部尺寸（icons/ 已提交，改源图后需重跑）
cargo tauri icon icons/icon-source.png

# 开发
cargo tauri dev

# 本机真机包：同一 worktree 先构建 CLI、再打包 app、最后验证内置 CLI 的 authority schema
../../../scripts/build-macos-app.sh
# 产物在 target/release/bundle/ 下；这是本地 ad-hoc 测试包，不是对外发布包
```

## 发布包安装与恢复

正式发布包应从可信 Release 页面下载 `.dmg` 或 `.app.zip`，不要从开发者工作目录
复制应用，也不需要另外安装 Python、CLI 或修改 shell `PATH`。应用内置的
`agent-vitals` 位于包的 `Contents/Resources/bin/`，工作台的诊断页会显示 App、CLI、
Engine、Authority schema、统计时区、价格和同步状态。

本地构建包仅用于开发验证：

```bash
# 从仓库根目录执行
node scripts/verify-macos-app-bundle.mjs

# 按当前机器/CI 目标架构做强校验（示例）
node scripts/verify-macos-app-bundle.mjs --require-architecture=arm64

# 正式发布门禁：要求 Developer ID 签名
node scripts/verify-macos-app-bundle.mjs --require-developer-id

# 校验桌面 Release workflow 的关键门禁仍在位
node scripts/verify-release-desktop-workflow.mjs
```

前一个检查允许本地 ad-hoc 签名并只作诊断；后一个检查失败时不得宣称安装包已完成
发布。正式 Release 还必须通过 notarization ticket 校验，并附带 `SHA256SUMS`。
当前发布 workflow 的最低 macOS 版本为 11.0；Apple Silicon/Intel 只有在对应架构
产物完成构建和真机验证后才能列入支持矩阵。
当前证据与未支持组合见[macOS 桌面支持矩阵](./SUPPORT_MATRIX.md)。

升级前请保留数据根目录的备份。升级失败时应先保留原数据和诊断包，再回退到上一份
已验证的应用包；不要删除数据库后让应用静默重建。卸载应用本身不会自动删除数据，
如需删除数据必须在用户明确确认范围后单独删除数据根目录。

## 两分钟上手

1. 打开应用并等待工作台完成首轮整理；无需填写套餐、预算、邮箱或 API Key。
2. 在“总览”查看已观测用量、名义成本、来源状态和价格覆盖；没有记录时选择“其他位置”
   或查看演示样例。
3. 若看到“确认计费方式”，只确认你有把握的那一组用量；保存前先查看作用范围和金额变化，
   也可以选择“稍后”。不确认不会删除用量或把成本变成零。
4. 需要排查时打开“帮助与诊断”，保存脱敏诊断包或进入可信版本发布页；应用不会自动上传
   会话正文。

### 金额和状态术语

- **已观测用量**：从本机可读日志归一、去重后得到的 tokens/请求事实，不代表所有设备的用量。
- **名义成本**：使用适用的公共价格目录对已观测用量作参考计算，不等于实际账单。
- **按量估算**：可匹配计费方式和价格的参考金额；provider、路由或历史价格不确定时仍会带有
  不确定标记。
- **已确认支出**：用户提供的账单、付款记录或有明确范围的付款声明；不会由订阅合同自动推导。
- **未计价**：缺少模型、价格或必要计费维度；不等于免费，也不会静默变成零。

菜单栏图标与 App Icon 分离：`icons/trayTemplate.svg` 是选定 Swept Crest 的
单色源图，导出为 22×18px / 44×36px PNG；Rust 内嵌 `trayTemplate@2x.png` 并开启
`icon_as_template(true)`，由 macOS 自动适配明暗、选中和辅助功能状态。

独立 workspace（`[workspace]` 空表 opt-out）：根仓库的 `cargo test`/`clippy`
不编译 tauri。数据根解析与北京日期键是管道（与 `paths.py`/`codex_cost.rs` 同 spec，
单测钉住），不是规则。

## 空态是诚实的

本机没有 `state/month.json`/`today.json` 时，工作台"总览"tab 显示「—」/
「本月还没有数据」，不摆全零结构；today.json 的 `date` 停在昨天时按「今天无
数据」处理（core 的 `today_cost` 判，不是把昨天的账报成今天的）。
