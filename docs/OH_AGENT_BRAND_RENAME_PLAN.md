# Oh Agent 应用与安装包改名实施文档

日期：2026-10-16  
产品：**Oh Agent**  
官网：<https://ohagent.ai/>  
状态：源码改名已实施（2026-10-20）：显示名、窗口标题、`.app` 路径、发布文件名、通知标题，**以及 bundle identifier**
（用户决定一并改为已在 Apple 登记的 App ID `ai.ohagent.desktop`，Team `EUKB6WHY6Z`；隔离探针为
`ai.ohagent.desktop.isolation-probe`）。下表「Tauri identifier：保留」一行因此作废，其余边界不变。
**尚未完成**：三平台原生构建与安装验收、macOS 签名公证、从旧包覆盖升级的实机验证、官网下载入口（§5 第 5–7 步）。

identifier 改变的后果（实施时核对过源码）：用户数据（facts JSONL、SQL 权威库、计费声明、城市补丁与种子）在
agent-vitals 数据目录，桌面端只用 Tauri 的 `resource_dir`，不按 identifier 取数据目录，因此不受影响。随
identifier 变化的是 macOS 的应用身份：新包不覆盖旧 `agent-vitals.app`、两者可同时运行（两个菜单栏图标）；
通知权限需重新授权；「系统设置 › 菜单栏」出现新条目；WebView 本地偏好（侧栏折叠、界面语言、城市背景）重置。
升级说明见 `apps/desktop/src-tauri/README.md`。

## 1. 修改目标与边界

当前契约更新：2026-10-21。Bundle ID 固定为 `ai.ohagent.desktop`；应用包为 `Oh Agent.app`；下载文件用小写 `oh-agent` 前缀。以下为当前规则，不采用旧 worktree 的命名。

统一用户看到的应用名称、工作台标题、安装器名称和官网下载文件名，消除新发行包对外显示的 `agent-vitals` 旧品牌。

本轮保留当前已注册的 `ai.ohagent.desktop` 身份、数据位置和内部命令，避免将品牌改名扩大为数据或安装身份迁移。不要全仓库替换 `agent-vitals`。

| 对象 | 当前值 | 本轮目标 |
| --- | --- | --- |
| 产品显示名 | `agent-vitals` | `Oh Agent` |
| 主窗口标题 | `agent-vitals 工作台` | `Oh Agent 工作台` |
| 兼容界面标题 | `agent-vitals 工作台（兼容界面）` | `Oh Agent 工作台（兼容界面）` |
| macOS 应用目录 | `agent-vitals.app` | `Oh Agent.app` |
| 官网名称 | 已使用 Oh Agent | 保持，并在验收后接入实际下载地址 |
| 对外下载文件前缀 | `agent-vitals-` | `oh-agent-` |
| Tauri identifier | `com.mixlabpro.agent-vitals` | `ai.ohagent.desktop`（当前已注册身份） |
| 桌面可执行文件 / Cargo package | `agent-vitals-menubar` | 保留；Windows 自动带 `.exe` |
| 内部 CLI | `agent-vitals` / `agent-vitals.exe` | 保留 |
| CLI 资源路径 | `bin/agent-vitals` / `bin/agent-vitals.exe` | 保留 |
| Rust crate、环境变量、数据目录 | 既有命名 | 保留 |
| 发布 tag | `app-v*` | 保留 |
| 隔离探针身份 | 独立 identifier | 保留隔离，不复用正式产品身份 |

保留 identifier 只能减少身份变化，不能代替升级验证。安装目录、快捷方式、卸载项、macOS 菜单栏记录及授权状态仍需实机检查。当前已采用 `ai.ohagent.desktop`；从旧身份升级的行为仍需实机验收。

## 2. 对外产物命名

发布文件使用无空格名称；安装包版本号取实际应用版本，不重复加入 tag 的 `app-v` 前缀。macOS 应用 zip 暂保留既有 tag 命名，避免本轮扩大链接变更。示例以 `1.0.0-beta.2` 为准：

| 平台 | 发布文件名 |
| --- | --- |
| macOS Apple Silicon | `oh-agent-1.0.0-beta.2-arm64.dmg` |
| macOS Intel | `oh-agent-1.0.0-beta.2-x86_64.dmg` |
| macOS 应用归档 | `oh-agent-app-v1.0.0-beta.2-arm64.app.zip`，Intel 用 `x86_64` |
| Windows x64 | `oh-agent-1.0.0-beta.2-windows-x86_64-setup.exe` |
| Linux x64 deb | `oh-agent-1.0.0-beta.2-linux-x86_64.deb` |
| Linux x64 AppImage | `oh-agent-1.0.0-beta.2-linux-x86_64.AppImage` |

macOS 应用包内部仍为 `Oh Agent.app`。Linux 包管理器的包名与菜单显示名是不同字段：本轮保留既有内部包身份；应检查实际生成的 deb 元数据和 `.desktop` 内容，不能把外部文件重命名当作包身份迁移。Windows 同样检查实际生成的安装元数据，不假定 `productName` 覆盖所有内部字段。

在发布暂存步骤统一复制、改名；不要依赖 Tauri 原始输出文件名的完整字符串。对每类产物断言数量与架构，缺失或重复即失败，再计算 `SHA256SUMS`。CI 内部的 artifact 名称可以保留，不必与公开下载名一致。

## 3. 文件修改清单

以下路径均相对仓库根目录。

| 文件 | 要做的修改 |
| --- | --- |
| `apps/desktop/src-tauri/tauri.conf.json` | `productName` 改为 `Oh Agent`；主窗口标题改名；identifier 与资源映射不动 |
| `apps/desktop/src-tauri/tauri.react.conf.json` | 同步覆盖配置中的窗口标题，避免覆盖回旧品牌 |
| `apps/desktop/src-tauri/tauri.legacy.conf.json` | 同步兼容界面标题 |
| `apps/desktop/src-tauri/tauri.windows.conf.json` | 检查合并后的显示名称；保留 `.exe` CLI 资源映射；签名配置单独接入 |
| `apps/desktop/src-tauri/tauri.linux.conf.json` | 检查合并后的显示名称与 deb/AppImage 目标 |
| `apps/desktop/src-tauri/tauri.isolation-probe.conf.json` | 若改显示名，使用 `Oh Agent Isolation Probe`；保留独立 identifier |
| `scripts/build-macos-app.sh` | `.app` 路径改为 `Oh Agent.app`，保留所有路径引号 |
| `scripts/build-macos-react-app.sh` | 同上；继续通过 `open "$app"` 启动 |
| `scripts/release-macos.sh` | 应用路径、DMG 名、暂存目录中的应用名同步修改 |
| `scripts/verify-macos-app-bundle.mjs` | 默认应用路径改名；内部桌面可执行文件和 CLI 路径保留；核查显示名与 identifier |
| `scripts/verify-v010-app-bundle.mjs` | 判断是否仍使用；若仍是入口，更新默认路径，不借改名刷新其历史版本断言 |
| `.github/workflows/release-desktop.yml` | 更新 `.app` 路径、公证校验路径、产物查找和公开文件名；保留签名、公证和全部平台发布门禁 |
| `.github/workflows/desktop-platforms.yml` | 安装包构建后检查新产品名；暂存时统一公开文件名；保留安装后 CLI 检查 |
| `scripts/verify-release-desktop-workflow.mjs` | 同步新的路径契约，不降低现有门禁 |
| `scripts/verify-desktop-platforms.mjs` | 增加各平台合并后产品名、identifier 不变和资源映射断言 |
| `apps/desktop/src-tauri/src/lib.rs` | 排查用户可见的旧品牌文案；CLI 查找中的内部文件名保留；测试路径可使用新 `.app` 名 |
| `apps/desktop/src-tauri/Info.plist` | 保留 `LSUIElement`；检查最终生成 plist 的名称，不添加与 Tauri 冲突的重复配置 |
| `docs/DESKTOP_PLATFORM_BUILDS.md`、`AGENTS.md` | 同步当前应用包名称和启动示例；历史事故记录保留历史名称，必要时加现名说明 |
| `website/landing/index.html`、`website/landing/i18n.js` | 发布验收后再增加真实下载链接、平台/架构/签名状态；中英文同步 |

补充排查：托盘菜单、关于页、通知、错误提示、安装器欢迎页、开始菜单快捷方式、Linux 应用菜单、卸载入口。仅替换面向产品用户的旧品牌，不改日志协议、数据契约或历史记录。

## 4. Windows 签名衔接

品牌名和签名发布者不是同一个字段。安装器显示 `Oh Agent`，证书发布者显示证书主体的真实名称，不应通过文案伪造。

接入签名时：

1. 确认证书或云签名服务及其可用身份；凭据不得提交仓库。
2. 在 Windows runner 配置证书访问或云签名工具。`bundle.windows` 使用证书指纹等参数，或使用 `signCommand`。
3. 先构建并签名资源 CLI `agent-vitals.exe`，再执行桌面打包；构建钩子不得在签名后重建并覆盖该 CLI。
4. 由签名流程处理桌面主程序及 NSIS 安装器，逐项校验签名与时间戳。
5. 正式签名发布要求任何一步失败即停止；普通 PR 不接触签名凭据，测试包明确标记未签名。

本文件不表示证书已经采购、签名已经接入，也不把未签名包描述为已签名。Tauri 参数参考：<https://v2.tauri.app/distribute/sign/windows/>。

## 5. 实施顺序

1. 修改正式和覆盖配置中的产品名、标题；锁定不变的 identifier、内部 CLI 和数据目录。
2. 同步 macOS 构建、验包、签名、公证及发布脚本，处理所有带空格的路径。
3. 修改跨平台发布暂存步骤，统一公开文件名，更新配置/发布契约测试。
4. 排查 UI 文案，更新当前操作文档；不改历史事实和内部协议。
5. 在原生 runner 构建三个平台，保存安装包与校验和；完成下述安装与升级验收。
6. 如已有签名能力，完成签名及验证；否则保持诚实的未签名状态。
7. 最后更新官网真实下载入口；在安装包公开可访问且验证通过前，保留“公开下载正在准备中”。

官网不需要先改域名或仓库名。仓库改名、CLI 改名及数据目录迁移均不属于本轮。

## 6. 验证与验收

本地回归命令：

```sh
node scripts/verify-desktop-platforms.mjs
node scripts/verify-release-desktop-workflow.mjs
node scripts/test-run-npm.mjs
node scripts/verify-react-tauri-bundle.mjs
node scripts/verify-react-macos-build-script.mjs
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib resolve_binary_
git diff --check
```

macOS 必须从应用包启动，不运行桌面裸二进制：

```sh
cd apps/desktop/src-tauri
cargo tauri build --ci --bundles app
open 'target/release/bundle/macos/Oh Agent.app'
```

以上路径为改名实施后的目标路径。Windows 和 Linux 分别在原生环境运行 `cargo tauri build --ci`，不能用 macOS 测试通过替代原生打包结果。

| 检查项 | 通过标准 |
| --- | --- |
| 配置合并 | 三平台产品名为 Oh Agent；identifier 与 CLI 资源映射保持预期 |
| 原生打包 | macOS、Windows、Linux job 成功，并实际生成所有声明的安装包 |
| 显示名称 | 应用、窗口、快捷方式及安装/卸载界面使用 Oh Agent；内部进程名允许保留 |
| CLI 可用性 | 干净机器无外置 CLI、无开发 PATH 时，随包 CLI 可执行且同步正常 |
| 插件功能 | 官方插件可加载，工作台、城市与本地数据访问符合现有授权边界 |
| 签名 | macOS 签名/公证验证通过；Windows 若声明已签名，主程序、CLI、安装器逐项验证通过 |
| 全新安装 | 安装、启动、退出、重新启动、卸载成功；Windows 含空格路径可用 |
| 覆盖升级 | 旧包升级至新包后数据与设置可读；无重复卸载项/快捷方式；检查旧 `.app` 是否残留 |
| 托盘与权限 | macOS 菜单栏身份和权限正常；Windows/Linux 托盘与窗口能打开 |
| 公开下载 | 文件名、平台、架构、版本、链接、校验和一致；匿名可下载且安装验证通过 |

已有数据和设置的升级验证先做备份；不得以清空用户数据解决改名问题。Linux 显示服务器、发行版及托盘实现的兼容范围按实际验收结果声明。

## 7. 回退

若仅修改源码，回退本轮品牌相关提交即可；不触碰用户数据。若发行包已经对外发布，停止官网推荐该包，保留旧版下载及校验信息，并依据旧版安装包实测恢复步骤。不要假定降版本安装器会自动覆盖新版本，也不要自动删除用户现有应用或数据。

完成标志：代码、打包、发布、官网四处命名一致，并有三平台原生构建及安装验收记录。只有文案改完或 CI 静态检查通过，不算完成。
