# Oh Agent

**Your agents work. Your world grows.**

A local-first desktop app that turns your desktop agents' recorded history into
an explorable city — and helps you understand the activity and token usage behind it.

**Your agents built it. Now explore it.**

[Explore the demo](https://ohagent.ai/) · [Download 1.0.0-beta.3](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3) · [Docs](https://ohagent.ai/docs/) · [Source repository](https://github.com/Oh-Agent-AI/oh-agent) · [中文](#中文) ·
[Desktop development](apps/desktop/src-tauri/README.md) · [MIT license](LICENSE)

## What is Oh Agent?

Your Claude Code, Codex and other supported agents leave a history of sessions.
Oh Agent analyzes supported records on your own machine:

- **Agent City:** sessions become data buildings, sources form districts, and
  token scale shapes the skyline. Select a building to inspect its session.
- **Activity replay:** revisit activity within the loaded time range.
- **Usage and cost analysis:** explore usage by source and time, inspect available
  session traces, and distinguish subscription fees, nominal estimates and evidenced spend.
- **Playful exploration:** desktop City includes free-flight practice, ring
  challenges and free drive (beta).

The city is a visual interpretation of recorded activity, not a productivity
score. Building growth does not establish task success, and repetition alone
does not prove wasted work.

## What you can try today

| Surface | Current scope |
| --- | --- |
| [Web demo](https://ohagent.ai/) | Real City frontend with 2000 synthetic sessions in the default 30-day window. Explore buildings and replay activity; it does not read your computer's logs. |
| Desktop app | 1.0.0-beta.3 pre-release: Apple Silicon Mac (signed + notarized), Windows x64 and Linux x64 (unsigned). [Download](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3) |
| Flying | Free practice and ring-challenge entry points exist in City settings outside the landing presentation. Version and scene readiness affect availability. |
| Driving | Free drive available in desktop City (beta). |
| Website gameplay | The landing presentation hides game, export and seed controls. The public mock demo does **not** offer flying or driving entry points. Desktop City includes flying and free-drive modes. |

Only describe a package as signed, notarized or platform-tested after the
corresponding release checks pass. [Windows/Linux build notes](docs/DESKTOP_PLATFORM_BUILDS.md)
describe build support, not complete UI acceptance. Intel Mac packages are coming later.

Oh Agent is the public brand: the desktop app is `Oh Agent.app` with bundle identifier
`ai.ohagent.desktop`. Repository names, CLI commands, crates, data directories and some
installed-package labels still use `agent-vitals`.
Do not rename existing data directories to match the website.

## Your history stays on your machine

- Local analysis does not upload your sessions. No cloud account or API key is
  required for the demo or supported local-history analysis.
- Public pricing/FX catalogs, release checks and explicitly chosen official
  resources may use the network. These requests must not carry local analytical data.
- Built-in City reads declared projections through the host, not arbitrary SQL or
  direct log access. The browser demo receives synthetic data only.
- MCP, exports and local presentation have different disclosure boundaries;
  connecting a networked agent is not equivalent to viewing data locally.

See [repository data-handling policy](AGENTS.md#data-retention--serving-face-policy-2026-09-19).
MIT licensing makes the implementation inspectable; it is not a security certification.

## Read the numbers honestly

Recorded tokens are observed usage, not necessarily complete history across all
devices. Source formats, permissions and retained logs determine coverage.

Subscription fees, API-equivalent nominal costs, metered estimates and actual
payments are different measures. An estimate is not a bill or proven savings.
Missing prices or uncertain provider/route evidence remain visibly unresolved,
not zero. City displays activity and usage; cost analysis is a separate view.

## Development quick start

Use a recent Node.js version, npm, stable Rust and Tauri's platform prerequisites.
The desktop is an independent Rust workspace: building the root CLI does not
build the desktop app. The macOS script requires the Tauri CLI to be installed.

```sh
# CLI
cargo build --release
./target/release/agent-vitals --help

# Local macOS .app build
npm ci --prefix apps/desktop/ui-dev
npm ci --prefix apps/agent-city/ui
bash scripts/build-macos-react-app.sh

# Launch the bundle, never the bare menubar executable
open "apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent.app"
```

See [desktop instructions](apps/desktop/src-tauri/README.md) and the
[release script](scripts/release-macos.sh) for packaging and signing requirements.
Local bundles must not be presented as notarized distribution builds.

Preview the landing page:

```sh
python3 -m http.server 5180 --bind 127.0.0.1 --directory website/landing
```

Open `http://127.0.0.1:5180/` (English) or `http://127.0.0.1:5180/zh/` (prerendered Chinese; regenerate with `node website/landing/tools/build-zh.mjs`).
See [landing build and verification](website/landing/README.md) for rebuilding City.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/desktop/` | Tauri host and React workbench |
| `apps/agent-city/ui/` | City renderer, session exploration, replay and game modules |
| `apps/cli/` | Rust CLI |
| `crates/` | Data, domain, harness, runtime and core logic |
| `packages/agent-vitals-python/` | Python compatibility implementation |
| `website/landing/` | Oh Agent website and synthetic City host |
| `website/docs/` | Documentation site (Astro Starlight), served at ohagent.ai/docs |
| `tests/`, `golden/`, `fixtures/` | Regression tests and compatibility contracts |
| `docs/` | Specifications, evidence and implementation status |

## Checks and contribution

```sh
node website/landing/tools/verify-landing.mjs
npm --prefix apps/agent-city/ui run typecheck
cargo test --release
python3 -m unittest discover tests -v
python3 tests/golden_runner.py --diff
```

Run checks relevant to your change; this list is not a claim that all suites pass
for every working-tree revision. Follow [AGENTS.md](AGENTS.md) for privacy, billing,
formatting and compatibility requirements. Do not refresh golden outputs merely
to silence failures.

The earlier Skill scanner, integrations and CLI remain in the repository, but
are not the primary product story. The [historical Skill/CLI guide](README.legacy.md)
preserves earlier explanations; its old matrices are not current support guarantees.

## 中文

**Oh Agent：Agent 在工作，你的世界在生长。**

这是一款在本机分析桌面 Agent 使用历史的应用。它把受支持的会话记录变成
一座可以探索的城市，也让你看清背后的活动、Token 用量和费用依据。

- **探索你的 Agent 城市：** 会话变成数据建筑，工具组成街区，Token 规模影响楼高。
- **回放工作节奏：** 查看已加载时间范围内的活动，点选建筑了解对应会话。
- **看懂用量与费用：** 订阅费、名义估算与真实支出分开呈现，未知金额不当作零。
- **让历史更好玩：** 桌面 City 已提供自由飞行、穿环挑战和自由驾驶（测试版）。

**下载：** 1.0.0-beta.3 预发布版，支持 Apple Silicon Mac（已签名并公证）、Windows x64 和 Linux x64（暂未签名），Intel Mac 版本随后提供。[前往下载](https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3) · [文档](https://ohagent.ai/docs/zh/)

源代码与开发历史见 [GitHub 仓库](https://github.com/Oh-Agent-AI/oh-agent)。

**官网演示不等于桌面全部功能。** [ohagent.ai](https://ohagent.ai/?lang=zh)
使用真实 City 前端和 2000 条模拟会话，不读取你的日志。目前落地页隐藏了游戏入口，
不能把它宣传成“现在打开网页就能开车、开飞机”。

你的城市来自历史记录，但不是生产力排名。建筑生长不代表任务完成，重试也不等于浪费。
会话在本机分析，不上传云端；公开价卡更新、版本检查和你明确选择的官方资源下载可能联网，
但不携带会话数据。

本地可构建应用不等于已完成签名、公证和正式发布。对外品牌为 **Oh Agent**，内部 CLI、路径和应用标识暂时保留 `agent-vitals`，
无需手工迁移或改名数据目录。

开发与检查命令见上方；旧版 Skill 审计介绍已归档到 [历史说明](README.legacy.md)。
