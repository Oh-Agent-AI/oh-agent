---
title: 怎么安装 Oh Agent？macOS、Windows、Linux 下载与安装
description: 下载 Oh Agent 1.0.0-beta.4（预发布版），支持 Apple Silicon Mac、Windows x64 和 Linux x64。各平台安装步骤、校验方法、签名状态和首次打开。
lastUpdated: 2026-11-12
head:
  - tag: script
    attrs:
      type: application/ld+json
    content: |
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
          {"@type": "ListItem", "position": 1, "name": "Oh Agent", "item": "https://ohagent.ai/"},
          {"@type": "ListItem", "position": 2, "name": "文档", "item": "https://ohagent.ai/docs/zh"},
          {"@type": "ListItem", "position": 3, "name": "安装", "item": "https://ohagent.ai/docs/zh/install"}
        ]
      }
---

Oh Agent 当前版本是 **1.0.0-beta.4**。这是一个**预发布版（Beta）**，发布在 [GitHub](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.4) 上，提供 **Apple Silicon Mac、Windows x64 和 Linux x64** 安装包。Intel Mac 版随后提供。

:::note[测试版]
1.0.0-beta.4 是测试版。Apple Silicon 版已做 Developer ID 签名、通过 Apple 公证并装订了公证票据；Windows 和 Linux 版**暂未代码签名**，系统可能会弹出提示。
:::

<!-- source: GitHub release app-v1.0.0-beta.4（prerelease: true，2026-11-11 15:17 UTC / 北京时间 23:17 发布，2026-11-12 核过安装包与 SHA256SUMS；构建自 main@974c2137；安装包于 2026-11-12 重新打包）；apps/desktop/src-tauri/tauri.conf.json（version 1.0.0-beta.4，productName Oh Agent，identifier ai.ohagent.desktop，minimumSystemVersion 11.0） -->

## 要点

- **版本**：1.0.0-beta.4，在 GitHub 上标为 *Pre-release*。
- **价格**：免费、开源（MIT）。
- **macOS**：Apple Silicon（arm64），macOS 11.0 及以上。已签名、已公证并装订票据。
- **Windows**：x64 安装程序，暂未代码签名。
- **Linux**：x64 的 `.deb`（Debian / Ubuntu）和 `.AppImage`，暂未签名。
- **Intel Mac**：本版不包含，随后提供。
- **校验文件**：安装包旁边附有 `SHA256SUMS`。

## 该下载哪个文件？

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| macOS（Apple Silicon） | [`oh-agent-1.0.0-beta.4-arm64.dmg`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.4/oh-agent-1.0.0-beta.4-arm64.dmg) | `d1b6a42a8a08c83fa9391c037e17e3daeb5e88a5aaa65c7eab1b46b259da268b` |
| Windows x64 | [`oh-agent-1.0.0-beta.4-windows-x86_64-setup.exe`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.4/oh-agent-1.0.0-beta.4-windows-x86_64-setup.exe) | `5d8253f91fdc900083d9be442816a1dbaefb9dbeab9de63b26bb4909ecb63bcc` |
| Linux x64（Debian / Ubuntu） | [`oh-agent-1.0.0-beta.4-linux-x86_64.deb`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.4/oh-agent-1.0.0-beta.4-linux-x86_64.deb) | `f2d80bc7c8f169f14de8de286a7d0a1a3cc9613ca46e550dd1264dbba5c099e2` |
| Linux x64（免安装） | [`oh-agent-1.0.0-beta.4-linux-x86_64.AppImage`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.4/oh-agent-1.0.0-beta.4-linux-x86_64.AppImage) | `86a55b747933dea37dcb988e505379d689171da9945f9e413f4e80970c4abbc8` |
| 全部 | [`SHA256SUMS`](https://github.com/Oh-Agent-AI/oh-agent/releases/download/app-v1.0.0-beta.4/SHA256SUMS) | — |

所有文件也都列在 [1.0.0-beta.4 发布页](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.4)。因为这是预发布版，GitHub 的“最新版本”入口不会指向它，请直接用上面的链接。

## macOS 上怎么安装？

1. 下载 `oh-agent-1.0.0-beta.4-arm64.dmg`。
2. 打开 DMG，把 **Oh Agent** 拖进 **应用程序**。
3. 从“应用程序”里打开 Oh Agent。

安装后的应用是 `Oh Agent.app`（Bundle ID `ai.ohagent.desktop`），需要 Apple Silicon Mac、macOS 11.0 及以上。这个版本已做 Developer ID 签名、公证并装订了公证票据，打开时不需要绕过 Gatekeeper。

## Windows 上怎么安装？

1. 下载 `oh-agent-1.0.0-beta.4-windows-x86_64-setup.exe`。
2. 运行安装程序。

安装程序暂未做 Authenticode 签名，Windows 可能提示“未知发布者”或弹出 SmartScreen 警告。决定继续运行之前，建议先按下文用 `SHA256SUMS` 校验文件。

## Linux 上怎么安装？

Debian 或 Ubuntu 上安装 `.deb`：

```sh
sudo apt install ./oh-agent-1.0.0-beta.4-linux-x86_64.deb
```

或者直接运行 AppImage：

```sh
chmod +x oh-agent-1.0.0-beta.4-linux-x86_64.AppImage
./oh-agent-1.0.0-beta.4-linux-x86_64.AppImage
```

AppImage 能否运行取决于发行版的运行库和 FUSE 支持。两种包都暂未签名，均由 GitHub Actions 在 Ubuntu 22.04 上构建。

## 怎么校验下载的文件？

把 `SHA256SUMS` 下载到安装包所在的文件夹，然后对比：

```sh
# macOS：把输出和 SHA256SUMS 里对应的那一行对比
shasum -a 256 oh-agent-1.0.0-beta.4-arm64.dmg

# Linux：校验 SHA256SUMS 里你已下载的文件
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# Windows（PowerShell）：把输出和 SHA256SUMS 里对应的那一行对比
Get-FileHash .\oh-agent-1.0.0-beta.4-windows-x86_64-setup.exe -Algorithm SHA256
```

## 这个测试版测过哪些？

根据 1.0.0-beta.4 的发布说明和签名状态：

- **macOS Apple Silicon**：已签名、公证并装订票据。实测目前以这个平台为主。
- **Windows**：安装包暂未签名（由 GitHub Actions 构建）。交互玩法尚未完成人工验收。
- **Linux**：`.deb` 和 `.AppImage` 由 GitHub Actions 在 Ubuntu 22.04 上构建，暂未签名。交互玩法尚未完成人工验收。
- **Intel Mac**：本版不包含，随后提供。

## 打开之后会发生什么？

Oh Agent 读取你的 Agent 已经保存在用户目录里的会话日志。不需要账号，也不需要 API key，不会上传任何东西。系统可能会请你允许读取这些目录。接下来可以看：

- [Claude Code 数据来源](/docs/zh/data-sources/claude-code) · [Codex 数据来源](/docs/zh/data-sources/codex)
- [Agent City 里每栋楼代表什么](/docs/zh/city-guide)
- [Oh Agent 会上传我的会话吗？](/docs/zh/privacy-and-data)

## 不安装能先试试吗？

可以，部分体验。[ohagent.ai 上的网页演示](https://ohagent.ai/?lang=zh)用真实的 City 前端加载 2000 次虚拟会话（30 天时间窗），不会读取你的日志，也隐藏了游戏、导出和种子控件。

<!-- source: website/landing/README.md（2000 次模拟会话 / 30 天；presentation=landing 隐藏游戏、导出与种子控件） -->

## 安装后为什么还能看到 agent-vitals？

应用的显示名是 Oh Agent。随包的命令行工具和数据目录 `~/.agent-vitals/` 为了兼容，仍沿用早期的内部名 `agent-vitals`，不要改名。

如果你装过早期名叫 `agent-vitals.app`（标识 `com.mixlabpro.agent-vitals`）的 macOS 版本，请退出并删除它，否则菜单栏会出现两个图标。

<!-- source: apps/desktop/src-tauri/README.md（CLI 与数据目录继续使用 agent-vitals）；README.md -->

## 开发者怎么从源码构建？

需要 Node.js 和 npm、稳定版 Rust、Tauri 的平台依赖和 Tauri CLI。在 macOS 上，从仓库根目录执行：

```sh
# 命令行工具
cargo build --release
./target/release/agent-vitals --help

# 本地构建 macOS .app
npm ci --prefix apps/desktop/ui-dev
npm ci --prefix apps/agent-city/ui
bash scripts/build-macos-react-app.sh
```

本地构建出来的是 ad-hoc 签名的开发测试包，不是发布包。更多细节见[桌面版 README](https://github.com/Oh-Agent-AI/oh-agent/blob/dev/apps/desktop/src-tauri/README.md)。

<!-- source: README.md（Development quick start） -->

## 怎么第一时间知道新版本？

- 在 [GitHub 仓库](https://github.com/Oh-Agent-AI/oh-agent) 点 Watch → Custom → Releases。
- 在 X 上关注 [@ohagentai](https://x.com/ohagentai)。
