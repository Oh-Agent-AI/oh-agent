# Oh Agent 发布准备状态

日期：2026-10-21；代码审查基准：`main` `ce419407`。这是发布缺口清单，不是发行批准。

## 当前主线

已 fetch origin；本地 main 包含远端全部提交，领先 59 个提交，无落后，工作区干净。品牌与跨平台融合为 71b6a416，证据归档为 ce419407。其他 worktree 不整体覆盖主线。后续本地改动继续在 main 记录；此状态不代表已推送远端。

## 发布阻断与验收顺序

| 优先级 | 项目 | 当前证据/缺口 | 完成条件 |
| --- | --- | --- | --- |
| P0 | 目标提交 Verify | 当前本地主线尚未推送，不能沿用旧提交 CI；远端最近查看到的 Verify 39234593924 在 City 专项守卫失败 | 修复失败并在最终发布 SHA 上完成成功 Verify；保留 release preflight |
| P0 | 驾驶桥梁与预算 | 追踪表最终几何16下 7/2 有 closed:no-surface；1000/7 有未决预算/拓扑失败记录 | 按确定性复现修复并重跑结构、碰撞和相关审计；不改基线或放宽预算假装修复 |
| P0 | legacy 工作台夹具 | overview-contract 的 declarations 断言在原 HEAD 与融合后同样失败 | 修复生产/夹具口径差异，测试通过，不删断言 |
| P0 | Apple CI 签名/公证 | 仓库可见 Actions secret 名称列表为空；workflow 要求六项 Apple 凭据 | 安全配置凭据来源，最终 arm64/Intel 包及内置 CLI 签名、Accepted、公证装订验证通过 |
| P0 | 新版原生长测 | 当前已安装 App 身份正确，但不是本轮重建；原生记录未完成明确最新构建的30分钟测试 | 标明 SHA/种子/规模/设备；完成输入法、车/飞机切换、暂停重入、桥梁、详情跳转及内存/帧趋势 |
| P0 | 三平台真实安装 | Windows/Linux 旧 SHA 42fb1225 的包 CI 成功，不能代替新命名/mainBinaryName 后验收 | 当前发布 SHA 的 Windows/Linux 构建、安装、内置 CLI、托盘、升级与卸载检查；macOS arm64/Intel 同步验收 |
| P0 | 发行身份和下载 | 当前应用版本仍 1.0.0-beta.2，gh release list 返回空数组，官网明确未发布 | 确定 beta 或正式版本，Tauri/Cargo/tag一致；发布后核验所有资源/校验和、匿名下载，再更新官网按钮 |
| P1/范围决定 | 全路网认证模式 | 玩家入口实际使用 useCityDrivingPlay 的 free-drive，confirmationEnabled=false；图发布与正式确认 controller 未接完 | 自由驾驶可单独验收，但不能宣称全路网认证已完成；若发行承诺认证模式，补 producer、接线与端到端验收 |
| 未来功能 | 收租与建造 | 游戏 GDD 是原型计划，不是已完成产品功能 | 不作为当前驾驶版发布前置；发行说明不可宣称已上线 |

仓库 secret 列表为空不证明本机没有证书或 Keychain profile，也不排除其他组织级配置；当前 workflow 在 build job 未声明 environment，必须实际确认它能取得所需 secret。不要在文档、聊天或 Git 中粘贴凭据。

Windows 当前流程没有证书签名接入；未签名不能标为已签名。公开分发前确定签名方案与 SmartScreen 提示体验，必要时按平台分阶段发行。Apple 本机曾公证成功不代表当前源码或 CI 构建已公证。

## 已有通过证据及边界

本轮融合：React verify:react、产物唯一性/命名测试、平台配置/发布守卫、npm 参数测试、Tauri 配置解析及 MCP 文案测试通过；YAML/Bash 语法通过。已安装 App 的 CFBundleName=Oh Agent、Identifier=ai.ohagent.desktop、CLI/schema/arm64 检查通过，诊断提示该安装包不是 Developer ID 签名。

未进行本轮全量 Rust/Python/City 测试，不宣称全绿。远端 Windows/Linux 成功记录为旧 SHA，不是新主线质量证明。菜单栏错误归属已在本机清理，用户确认图标恢复，这是本机设置恢复，不是代码发布证据。

远端证据：
- Verify 失败：https://github.com/MixLabPro/oh-agent-ai/actions/runs/39234593924
- 旧版平台包成功：https://github.com/MixLabPro/oh-agent-ai/actions/runs/39234593925

## 建议执行次序

先修 legacy 夹具和桥梁/预算，再按最终源码运行相关回归及完整 Verify；准备签名凭据并选择版本；推送候选提交获得 CI 证据；生成同 SHA 三平台产物并原生安装长测；验收后创建/使用对应 release tag 发布，最后接通官网的真实下载。

在阻断关闭前可以继续内部测试或显式发布受限预览，不能称正式稳定版已验收。发布与 Git push 需按用户后续明确指令执行；本轮仅检查与记录。

## 本地修复复核追加

用户要求先仅保存在本地：不 push，不创建 Release。本机 Keychain profile 已确认可用（仅记录验证结论，不记录凭据）；这不代表 GitHub Actions 已配置 Apple secrets，也不代表本轮候选包已公证。

- legacy declarations 修复已提交 `4826a516`，工作台合约守卫通过。
- City 英文目录遗漏修复已提交 `6d5e8b66`，529条目录检查通过。
- 发布管线修复已提交 `cb282c85`：显式签名嵌套 CLI，校验 Developer ID/runtime/同 Team；App 使用 ditto ZIP 传递以保留权限和符号链接。对应合约测试及 YAML/Bash 检查通过；尚无当前 SHA 的远端运行证据。
- Python 全套1293项通过（跳过209项），Rust release tests、Clippy、Rust release build 通过；Python/Rust golden 各16项通过。
- City 全套第一轮在 i18n 目录守卫停止，此项已修复；后续阶段继续运行，尚不能称全套最终通过。
- CCD v7 的17条历史差分及4条几何16接触复现、连续驾驶守卫、typecheck 通过。真实1000/7指定桥端两向重跑为 pilot-failed，无 simulation-invalid，仍不能开放为已认证通行。7/2桥头仍未关闭。

原生最新源码打包、公证、30分钟长测和当前提交三平台验收仍待完成。此前表格中的这些阻断仍有效。

> 2026-10-22 仓库迁移补记：当前地址为 https://github.com/Oh-Agent-AI/oh-agent 。上文保留当时检查的地址与结论，不代表新地址的当前可用性。
