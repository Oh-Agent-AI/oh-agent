# v1.0.0-beta.1 版本冻结记录（2026-09-15）

本文记录 [`BETA_1_RELEASE_SPEC.md`](./BETA_1_RELEASE_SPEC.md) §6 G01 中"App 标
`1.0.0-beta.1`，CLI/schema 独立版本有映射"这一项**技术动作**的执行证据。它只
是 G01 的一个必要条件，不是 G01 本身的放行——G01 的完整放行条件是"B01–B12
全部有实现"，本文写作时 B02/B06/B07/B08/B09/B10/B11 仍有真机路径缺口（见
[`UAT_FULL_2026-09-15.md`](./UAT_FULL_2026-09-15.md)），因此 **G01 尚未放行**，
本文只关闭"版本号与工作树"这一个子项。

## 候选提交

- 冻结基点：`main` @ `cca6dff`（"docs(v1.0.0): add desktop UAT evidence"）。
- 冻结时工作树新增一处清理：`scripts/release-macos.sh`（此前未追踪的签名/公证/
  DMG 打包脚本，属于 G09 已完成的准备工作，随本次一并提交，不再让候选源码带着
  未追踪文件）。

## 版本映射

三个版本号独立演进，互不绑定；桌面 App 的诊断面板（`about_diagnostics` /
`export_diagnostic_package`，`apps/desktop/src-tauri/src/lib.rs:2075-2091`）在
运行时把三者一起展示，这就是 G01 要求的"映射"——不是三个数字相等，而是同一处
证据里能同时看到三个独立版本号。

| 组件 | 版本 | 来源 |
|---|---|---|
| App（Tauri，对外发布号） | `1.0.0-beta.1` | `apps/desktop/src-tauri/Cargo.toml`、`tauri.conf.json`（`env!("CARGO_PKG_VERSION")` 注入到诊断面板） |
| 随包 CLI | `1.3.0` | `apps/cli/Cargo.toml`；诊断面板对实际内置二进制跑 `--version` 现场探测（`resolved_cli_version()`），不是把 App 版本冒充 CLI 版本 |
| Authority DB schema | `14`（冻结时为 `13`；同日计费主链 v1.2 因作用域词表加 `provider` 升到 14） | `crates/agent-vitals-data/src/authority.rs::SCHEMA_VERSION` |

CLI 和 schema 版本按各自节奏演进——`1.3.0`/`14` 是当前值（schema 的 13→14 由计费主链 v1.2 触发，与 App 版本号无关），Beta
号冻结的只是 App 这一个对外可见的版本号。

## 本次改动

- `apps/desktop/src-tauri/Cargo.toml`：`version` `0.11.0` → `1.0.0-beta.1`。
- `apps/desktop/src-tauri/tauri.conf.json`：`version` `0.11.0` → `1.0.0-beta.1`。
- `apps/desktop/src-tauri/Cargo.lock`：同步 `agent-vitals-menubar` 包条目版本号。
- `scripts/release-macos.sh`：补入版本冻结前遗留的未追踪文件（内容未改动）。

`scripts/release-macos.sh` 的 DMG 文件名生成对版本号做了字符白名单校验
（`case "$version" in "" | *[!0-9A-Za-z._-]*) die ...`），`1.0.0-beta.1` 只含数字/
点/连字符，属于合法字符集，脚本不需要改动即可产出
`agent-vitals-1.0.0-beta.1-arm64.dmg`。`Info.plist` 不硬编码
`CFBundleShortVersionString`，由 Tauri 在打包时从 `tauri.conf.json` 注入，同样
不需要改动。

## 仍未关闭的部分

- 工作树"干净"只覆盖到这次提交为止；G01 真正放行前仍需在候选源码冻结点之后
  不再有未审查的漂移提交。
- G01 的"B01–B12 全部有实现"要求本文不涉及，按发布规格 §8 顺序，下一步是
  P0-2（B06/B07 计费确认主链）的真机闭环。
