# E08 阶段合并准备

> 历史记录：以下描述来自归并前的原工作区。当前整合版本与最终验证以
> `WORKTREE_MAIN_CONSOLIDATION_REPORT.md` 为准；原始内容由源码检查点保留。

日期：2026-10-04。目标：收尾可安全合并的扩展生命周期子集，不宣称整个扩展
架构完成，不改变 City 官方内置插件/同窗 tab 的产品目标。

## 本轮新增

- manifest 与编译适配器（含 custom roots）的保守源根互斥；安装、回滚、运行
  及 normal sync 的维护写入前检查。重叠不以暂停或卸载适配器绕过；已有事实
  的历史源范围保留，不能被另一 host 重新认领。缺失历史对象明确拒绝。
- `manifest-recompute` 的有界只读预览、精确确认、独立不可变结果与 replay 去重。
  不重新入账、不覆写账单，不改旧事实或来源。
- 源根/symlink/custom-root 与重算结果保持回归。

## 合并范围

当前 `feat/agent-city` 的提交基线与本地 `main` 相同，但工作区包含尚未提交的
E06/E07、扩展 authority/事实写入、City 文档及网站改动。本轮 E08 依赖其中
安装/生命周期/事实来源实现，不能只提交新文件而漏掉依赖。阶段提交应包含
必要的 Rust 生命周期与测试、CLI 入口及对应文档；网站、City 展示和 catalog
发布流水线改动应独立审查，不用全目录 staging 混入。

已执行 `git fetch origin main`：本地 main/当前 HEAD 为 `443e2c3a`，
远端 main 为 `55f8de0e`，当前 HEAD 相对远端为 ahead 418 / behind 0。
因此本地 main 的阶段提交与远端发布是两个不同操作；不得把 418 个历史提交
默认为本轮 E08 的单独远端合并范围。当前没有 commit、push 或 merge 操作。

## 未关闭的承诺

- 真正的历史月封账冻结尚未实现：本轮只证明已有 authority 内容不被重算修改。
- 显式跨 host 源迁移/事件时间范围接管没有实现；当前安全策略是拒绝重叠。
- 源目录和 custom-source 配置的跨进程并发 TOCTOU 尚未全面封闭。
- 独立审计和完整测试门未全部完成前，不实际合入 main。

## 验证

已通过：release 构建与 `manifest-recompute --help`；Python 全量 1284 项
（skipped 210）；Python/Rust golden 各 16 case；`git diff --check`。
全量 Clippy 曾暴露两个旧 extension-authority 测试的未使用变量，修正后通过。
Rust 全量测试发现旧 summary fixture 直接把候选目录当作激活授权，已改为
正式 install preview/confirm 后 ingest；旧 facade import 预算超限通过将新增
CLI 路径改为 `runtime::core::home` 修正，没有抬高预算。此前失败均已修复并复跑。

最终复跑：`cargo test --release` 全部默认 workspace 测试与 doc-tests 通过；
`cargo clippy --release --all-targets -- -D warnings` 通过。新增历史源范围检查、
旧 schema 只读预检、卸载后保留互斥及重算生命周期均在最终代码上复验。
没有运行桌面打包/交互验收，也没有新增独立 subAgent 审计；本记录不作为
现存桌面和网站未提交改动的合并背书。阶段提交范围需要先确认。
