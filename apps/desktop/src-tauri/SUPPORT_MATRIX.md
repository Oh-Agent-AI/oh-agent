# macOS 桌面支持矩阵

这份矩阵只记录已有构建和验收证据，不把“可以交叉编译”当作“已支持”。正式
Release 发布前，目标组合还必须通过 Developer ID、notarization、无开发环境安装、
退出重开和升级恢复验收。

| 组合 | 当前状态 | 已有证据 | 正式发布条件 |
| --- | --- | --- | --- |
| macOS 11+ / Apple Silicon (`arm64`) | 候选验证中 | 本地 `.app` 与随包 CLI 均为 `arm64`；架构预检、CLI `--version` 和 Vite/Workbench 验证通过 | Developer ID、公证、干净机安装/升级/恢复和资源性能验收 |
| macOS 11+ / Intel (`x86_64`) | 未支持 | 尚无本机或 CI 产物证据 | 完成 `x86_64` 构建、架构预检、签名公证及真实机器验收 |

当前不声明 universal binary，也不声明 Windows/Linux 桌面版。发布 workflow 会在构建
和发布两个边界根据 runner 架构校验 App 主程序与随包 CLI，避免资产名称与实际架构不符。

