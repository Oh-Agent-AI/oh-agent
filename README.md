# Oh Agent

**Agent Roblox. Agents create Cities and games. People play and share them.**

Oh Agent is a local-first platform for building playable worlds with agents.
Describe what you want to make, work with an agent in Creator Studio, and try
the result in City. An existing City can host a new game, and a creation can be
packaged for sharing. Agents' session history and token usage can also enrich the
cityscape and power local activity, usage and cost views.

[City demo](https://ohagent.ai/) · [Desktop releases](https://github.com/Oh-Agent-AI/oh-agent/releases) · [Docs](https://ohagent.ai/docs/) · [中文](#中文) · [MIT license](LICENSE)

## Create, play and share

1. **Create.** Work with an agent through Creator Studio and the Creator MCP
   tools. Define a City, add places and rules, and build a game from a template
   or with the Game SDK.
2. **Play.** Review changes, preview a candidate and playtest it in a City.
   Built-in flight, driving, mecha and cinema experiences live in the City app.
3. **Share.** Export supported creations as experience packages. The roadmap
   extends sharing to playable invitations on the web, with scoped remote
   access and separate browser play sessions where supported.

## Development status

The table describes this development branch. See [Desktop releases](https://github.com/Oh-Agent-AI/oh-agent/releases) for downloadable builds and platform coverage.

| Surface | In the repository today |
| --- | --- |
| Public City demo | Explore a City and replay synthetic activity in the browser. The landing demo exposes exploration and replay. |
| Creator Studio | City drafts and project editing, agent tasks and review, project candidates, playtest and release flows. [Creator MCP setup](docs/AGENT_CREATOR_MCP_CLIENT_SETUP.md) |
| Game content and sharing | The Game SDK can build sealed artifacts. Studio supports isolated previews and installation preflight for code game builds, plus experience package export for supported releases. [Game SDK](packages/city-game-sdk/README.md) · [Experience packages](docs/CREATOR_EXPERIENCE_PACKAGE_2026_11_16.md) |
| Story | Studio reads the host's Story Project Registry. Story installation, runs and NPC leases have host/MCP entry points. A full Story editor and complete end-to-end validation are still in development. [City SDK V3 implementation](docs/V3_IMPLEMENTATION_REPORT_2026-11-21.md) |
| Remote play | Remote City and mecha have scoped session paths. General browser play for authored content and public distribution are roadmap work. [Remote gameplay](docs/DEVELOPMENT.md#remote-gameplay) |
| Miami and built-in games | The City app and built-in games are still in this repository. Separate repositories and Studio management through a unified package lifecycle are planned. [Architecture](docs/DEVELOPMENT.md#architecture-and-code-entry-points) |

## Local data and sharing

Session history is analyzed on your device. The public demo uses synthetic data.
The desktop user initiates remote sessions and approves access to the data and
controls permitted for that session. Exporting an authored experience and granting
remote access are separate actions with different data boundaries.

Usage figures describe the records the app can read. Cost views distinguish
observed usage, subscription fees, estimates and evidenced payments. Uncertain
provider routes and missing prices remain unresolved. [Data handling policy](docs/DATA_HANDLING_POLICY.md)

## Develop

- [Development guide](docs/DEVELOPMENT.md) for the repository map, commands and checks.
- [Desktop setup](apps/desktop/src-tauri/README.md) for Tauri builds, packaging and platform notes.
- [City SDK](packages/agent-vitals-city-sdk/README.md) and [Game SDK](packages/city-game-sdk/README.md) for authoring contracts and examples.
- [Repository guidelines](AGENTS.md) for architecture, data and contribution rules.
- [Historical Skill and CLI guide](README.legacy.md) for the earlier scanner and integrations.

## 中文

**Oh Agent 的定位是 Agent Roblox。Agent 创建 City 和游戏，人类游玩与分享。**

在 Creator Studio 描述想做的世界或玩法，与 Agent 一起编辑项目、审阅修改、预览和试玩。City
可以安装游戏，受支持的作品可以导出为体验包。Agent 会话历史和 Token 用量也可用于丰富城市景观、
回放活动，并在本机查看用量与费用。

当前开发分支已有 City 草稿、Agent 任务、候选版本、试玩和发布流程，以及代码游戏的隔离预览和安装预检。
Studio 可以读取宿主中的 Story 项目，完整的故事编辑体验仍在开发。远程 City 与机甲已有受限的会话通道。
创作内容的通用 Web 游玩与分享、迈阿密和内置游戏拆仓，仍是后续工作。

[官网演示](https://ohagent.ai/?lang=zh) 使用合成会话，可探索城市和回放活动。本机会话分析在设备上进行，
远程访问由桌面用户主动开启，授权与数据范围受会话限制。

[桌面下载](https://github.com/Oh-Agent-AI/oh-agent/releases) · [中文文档](https://ohagent.ai/docs/zh/) · [开发指南](docs/DEVELOPMENT.md) · [数据政策](docs/DATA_HANDLING_POLICY.md)
