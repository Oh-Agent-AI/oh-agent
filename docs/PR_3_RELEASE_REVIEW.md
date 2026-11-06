# PR #3：仓库迁移与 beta.3 审查

2026-10-22；原 PR head `782b9d2a`，审查时合入 main `90fccf84`。

结论：仓库迁移和版本更新未发现阻断合入 dev 的代码问题。运行时的
价卡/汇率/目录/发行 API 指向新仓库；官方 payload 仍限制为固定来源、
commit 与受限目录；迁移没有放宽外部网络或本地数据访问权限。旧 owner
不再作为官方来源，是本次 beta 迁移明确的兼容性选择。

- Cargo 工作区 `cargo check --workspace`：通过（Rust/Cargo 1.97.1）。
- 桌面 crate `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`：通过。
- 官方 payload URL 固定来源/commit/路径限制回归：1 项通过。
- 官网内容/链接/双语合约、产物命名、发布 workflow 合约及 catalog 检查：通过。
- Tauri / 桌面 Cargo.toml / 桌面 Cargo.lock 均为 `1.0.0-beta.3`；
  CLI 与内部库各自版本不需要机械同步成桌面版本。
- 补回了最新 main 的 CI runner 和桥下浅滩修复，避免合并后退回已知失败。
- 纠正历史审计记录的机械 URL 替换：保留当时实际检查过的旧地址，
  追加新仓库地址说明；当前官网与运行时代码使用新地址。

合并不等于发行批准。`app-v1.0.0-beta.3` 必须指向最终验收的候选 SHA，
不能对旧 PR head 或旧 main 打 tag。发行 workflow 的 preflight 会要求
该 SHA 存在成功的 Verify；合并提交应先进入 main 获得对应 CI。

尚需：最终 SHA 的完整 CI、新构建原生安装/长测、发行凭据可用性。
审查时 repository Actions secrets 名称列表为空；这不证明本机缺少证书，
也不排除 organization/environment 配置，但不能假设远端公证 job 可用。
不绕过 preflight，不把本地 cargo check 视为全量测试或公证证据。
