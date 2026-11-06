# 真截图资产位（LANDING 发布门）

> 2026-10-16：下列清单属于旧版诊断优先 landing 的历史计划。City 优先改版已使用现有演示工作区截图；当前素材、验收与待补证据以 [RELEASE_REVIEW.md](../../RELEASE_REVIEW.md) 为准。当前 `verify-landing.mjs` 验证本地实现，不将旧五图清单当作新页面或公开发布已验收的证明。

本目录存放从真机 app 捕获的发布门截图。**终端自动化捕获被 macOS Screen Recording
权限拦截**（`screencapture: could not create image from display`），需手动捕获：

## 捕获清单（对应 LANDING_VALUE_FIRST_SPEC 三组证据 + 决策区/S1）

1. `hero-diagnostics.png` — 总览页：决策区（现在该用谁 + 值回双轨）+ 支出卡
2. `b1-repeated-failure.png` — 会话详情：重复失败诊断 + 失败区间成本暴露块
3. `b2-usage-to-session.png` — 用量页小时面板 → 「该日会话」深链后首屏
4. `b3-billing-scope.png` — 三级口径卡（按量估算/订阅/账单确认分栏）
5. `tray.png` — 托盘图标 + 菜单（System Settings › Menu Bar 下自有条目确认）

## 捕获方式（手动）

1. `open /Applications/agent-vitals.app`（Developer ID 签名版已装机）
2. 托盘图标 → 打开工作台
3. `Cmd+Shift+4` 逐屏截取，命名如上，存入本目录
4. 发布门检查：`node tools/verify-landing.mjs`（若已实施 L0）

## 状态

- [ ] 5 张截图待手动捕获回填
- 分发决策（2026-09-30）：Developer ID 签名测试版分发；公证待一次性
  `xcrun notarytool store-credentials` 后执行
  `xcrun notarytool submit agent-vitals.dmg --wait` + `stapler staple`
