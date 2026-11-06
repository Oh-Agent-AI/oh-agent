# Oh Agent 发布候选准备（2026-10-22）

本轮将 `origin/dev` 快进合入 `main`，基准为 `be7fa34c`，包含地形编辑 T0、
桥头重绘和桥面端头拟合。没有创建 tag 或 GitHub Release；应用版本仍为
`1.0.0-beta.2`，不能视为已验收的稳定版。

## 本轮关闭的检查缺口

- Verify 的四个 Linux Python 3.9 作业固定为 Ubuntu 24.04。之前
  ubuntu-latest 已切到 26.04，setup-python 找不到 3.9 构建；官方
  actions/python-versions 当前清单提供 22.04/24.04 的 3.9.25。保留
  Python 3.9 下限验证，不删测试，也不把安装失败当成功。
- 自动桥头平整保留桥跨中央的浅水通道：曾把 seed 3576928465 的正高度
  浅滩从约 0.31 抬到 1.46，使一座约 9.91 长的短桥失去跨水区域。
  平整版本升为 2，保留桥头落地过渡，桥下通道按纵横向距离和原高度平滑
  降低填土权重；短跨也按自身长度缩放。新增浅水保留与桥头高度不变回归。
- 场景基线仅更新 1600/day 和 1600/night 的
  `city-infrastructure-decorative` 分区：其中桥面/栏杆/标线实例直接消费
  dev 新增的端头拟合。380 场景和其余分区不变；没有放宽几何断言。

## 本地验收

已通过：City typecheck/build，工作台 `verify:react`，地形 T0、plan-patch、
repair-controller、repair-bridgehead、实际 bridge-crossing、coastal-receivers、
飞车 VTOL、driving-entry、shared-runtime，四个昼夜场景基线，以及发布
workflow/平台配置/产物命名合约检查。地理守卫保留全部 31 个原始种子和断言。
最终候选仍需以 GitHub Verify 的当前 SHA 运行结果为准。

桥头专项明确仍有 7/2 的两座原始缺陷桥，其中一座可通过重绘修复并双向
试驾，另一座拒绝为 `no-road-on-bank`。修复工具可用不等于所有原始道路
均已认证；发行说明不得宣称全路网通行认证完成。

## 发布前剩余门槛

1. main 推送后的最终 SHA 完整 Verify 与 Windows/Linux 包 CI 成功。
   本轮本地专项通过不能替代整条远端流水线。
2. 用最终 SHA 重建 macOS 包、签名、公证和装订。现有已公证 DMG / 已安装
   App 来自 `2f4f2ddd`，包含旧代码，不能替代新候选包。
3. 记录新包的原生安装及至少 30 分钟驾驶稳定性验收；含输入法、车/飞机
   切换、飞车喷升/落地、桥头、暂停重入、会话详情跳转和帧/内存趋势。
4. 明确发行平台矩阵：Windows/Linux CI 构建成功不等于干净机器安装、
   托盘、升级/卸载验收；macOS Intel 也需对应架构证据。可按平台分阶段 beta。
5. 核实 GitHub macOS release job 的 Apple 凭据可用性，或使用本机已配置
   的安全签名公证流程。不得在文档/Git/聊天中放入密钥。
6. 验收后再创建与版本一致的 `app-v*` tag，核对安装资源/校验和与匿名下载，
   最后将官网的“准备中”替换成真实下载。当前尚未创建 Release。

本轮没有修改版本、安装 App、上传公证包或发布发行资源。
