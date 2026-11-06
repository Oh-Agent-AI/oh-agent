# 本地 worktree 融合审查

日期：2026-10-21；主线基准：`main` `757e033c`。只读代码审查，不等于运行时验收；未合并、删除或清空任何 worktree。

## 结论

不能整体合并旧 worktree。已融合内容很多，但品牌线仍有遗漏；旧发布工作流还含主线已修复的过时配置。判断同时使用提交祖先、补丁等价、文件内容与功能接线，不能只看 branch merged 状态。

| worktree/提交 | 已融合证据 | 剩余内容与处置 |
| --- | --- | --- |
| `skill-vitals-flyingcar` / `f5d578b4` | HEAD 是 main 祖先，工作区干净 | 已融合，无需再次合并 |
| `skill-vitals-driving-lamps` / `fbac7c8e` | 标定补丁等价；灯光预算、解析灯、夜灯、地形等文件相同；路面与车材质补丁存在；CityEngine 更新/释放已迁至共享场景租约 | 功能已融合，不能把旧 WIP 快照再并入。分支提交图仍不同，后续清理前保留审查记录 |
| `oh-agent-brand-rename` / `d1568b01` | HEAD 是 main 祖先；20 个修改文件中 6 个与 main 完全相同；10 个未跟踪文件中 4 个已以相同内容进入 main | 其余是部分融合/真实遗漏/过时方案混合，必须逐项提取 |
| `skill-vitals-oh-agent` / `bb4311ad`（detached） | CLI 资源解析、平台基础构建和应用身份等部分已在 main | 两个品牌提交未整体进入 main；侧栏、窗口标题、品牌校验仍有遗漏。作为补丁来源保留 |
| `city-visual-style-analysis-a9ddd6` / `b1cb7d3d`（detached） | HEAD 是 main 祖先 | 未跟踪的 `docs/CITY_ROAD_NETWORK_FIX_PLAN.md` 不在 main；main 只有该方案审查文档，应保留原方案并标明历史基准 |
| `/private/tmp/e-solids` / `d7b43b22` | 提交是 main 祖先 | 目录已不存在，仅残留 worktree 注册；确认后可 prune，无需重合代码 |
| `/private/tmp/infra-fix` / `fce7c88b` | 提交是 main 祖先 | 同上 |

## 品牌线：已融合

- `AGENTS.md`、两个 macOS 构建脚本、official-plugins、prepare-desktop-bundle、verify-v010-app-bundle 与品牌 worktree 当前内容相同。
- Windows/Linux 平台配置、run-npm 与其测试已与 main 相同。
- `BUNDLED_RESOURCE_DIR`、平台资源目录 CLI 查找及对应测试已存在于 main。
- 主配置当前 productName 为 `Oh Agent`，identifier 为 `ai.ohagent.desktop`，mainBinaryName 已保留内部二进制名称。
- macOS `.app` 路径已统一为 `Oh Agent.app`，DMG 继续使用 `oh-agent-<version>-<arch>.dmg`。

## 品牌线：仍有实际遗漏

1. React 侧栏仍显示 `av` / `agent-vitals`；独立品牌 worktree 为 `OA` / `Oh Agent`，旧重命名 worktree 为小写 `oh`，需选定一个表现。
2. 主配置和 React/legacy 窗口标题、HTML title、部分 Skill 文案仍保留旧品牌。
3. `verify-macos-app-bundle.mjs` 尚未包含对 Info.plist CFBundleName/Identifier 与 Tauri 配置一致性的检查。
4. Windows 安装后产品名、Linux desktop entry 名称与更严格的跨平台品牌门禁未全部接入。
5. `desktop-release-artifacts.mjs` 和其测试不在 main。其“每格式唯一产物”的校验值得提取，但旧命名输出不符合用户已确定的 DMG 命名。
6. isolation probe 的名字与标识需和其验证脚本共同核对；不能只改配置漏改测试。

## 不能照搬的旧内容

- 旧重命名 worktree 的基础 identifier 仍是 `com.mixlabpro.agent-vitals`；主线应保留 `ai.ohagent.desktop`。
- 旧 release workflow 没有 main 现有的精确提交 Verify 前置门禁，Intel runner 仍为 `macos-13`，且缺 beta prerelease 分支。
- 旧 artifact helper 会生成 `Oh-Agent-<version>-macos-arm64.dmg`，与用户指定的 `oh-agent-<version>-arm64.dmg` 冲突。
- main 有后续 City/宿主改动，不能用旧 `lib.rs` 或整个文件覆盖主线；只提取遗漏的品牌文案等小 diff。

## 后续建议

先单独修复主线品牌 UI 与窗口标题，再补产物身份和跨平台发布校验，保留现有发布门禁与命名。历史道路方案单独归档。完成后重新比较并验证，再决定 worktree 清理；本轮未执行清理。

本轮运行：`node scripts/verify-desktop-platforms.mjs` 通过。这只能证明当前既有配置守卫通过，不能证明上列遗漏已解决或所有平台已打包成功。


## 建议执行记录（2026-10-21）

已在主线逐项提取：侧栏 OA/Oh Agent、主/兼容/React 窗口与 HTML 标题、Skill 展示文案；显式 mainBinaryName 保留内部程序名；隔离探针使用独立的 ai.ohagent.desktop.isolation-probe 身份并同步启动脚本；macOS 包身份与配置一致性校验；Windows/Linux 安装品牌检查；按格式唯一产物 staging 及测试；CI 注册测试；旧道路方案加历史标识后归档。

保留现有精确提交 Verify 门禁、macos-15-intel、beta prerelease 行为、Oh Agent.app 与小写 oh-agent DMG 命名，未覆盖旧工作树文件。旧品牌计划与平台构建说明已纠正命名。macOS app zip 的既有命名仍保留。

本轮验证：React verify:react 全链（build/typecheck/契约）通过；产物命名/缺失/重复/空格路径测试通过；平台配置、发布工作流与 npm 参数测试通过；已安装 App 的 CFBundleName/Identifier、内置 CLI/schema/arm64 检查通过（该包不是本轮新构建，诊断模式提示非 Developer ID 签名，不代表可发行）。legacy closeout 检查通过。

额外发现：verify-workbench-overview-contract.mjs 的 declarations 夹具断言失败；在未修改 HEAD 的隔离文件副本复现相同错误，判为既有失败，未放宽测试。本轮不宣称全套测试全绿。未重新执行原生全平台打包、签名/公证、UI 目视验收或隔离探针运行；原 worktree 仍保留，未清理。

补充验证：Tauri 平台合并配置解析测试通过，确认 mainBinaryName 字段可解析且各平台资源映射正确；工作流 YAML 与 Bash 语法检查通过。

## 第二轮远端融合

main `44da5d3d` 与 origin/dev `240881d7` 已合并为 `7e5e2be1`。origin/codex/city-repair-upgrade 同为240881d7；car-model的88e55bcc已被dev包含。本轮合入桥头/坡度审计、整桥擦除与重画方案、双向试驾、局部路面安全网、生成器6和通知品牌补全。

11个冲突逐项解决，保留main最新签名公证、权限保真归档、DMG命名及平台配置；City验证清单109项，保留全部原有驾驶/审计守卫，增加2项规划守卫。结构守卫保留斜桥合成夹具和地面起步条件，加入完整实际引道路线验证。

已通过：City typecheck/build、验证清单、plan-patch、road-rules、repair-controller、repair-copy、bridgehead、drivability、导入边界、英文目录、CCD差分与连续驾驶；桌面发布/平台、签名合约及App归档权限测试。规划基线30岛匹配（生成器6），未刷新golden。结构15城渲染一致：27桥54桥端、39端连通，两端接续的12条路线有11条完整驶过；4条匝道上/下行通过。100次合法绘路编辑99次双向试驾通过。7/2两座问题桥均可擦除，其中1座可重画并双向通过，另一座明确无方案。

仍有缺口：7/2原桥头closed:no-surface/wheel-twist未消除；新试驾只验证路面，不包含场景固体。场景基线失败：380/1600楼昼夜的city-infrastructure-decorative四项哈希与golden不同，与合并前日志`/tmp/ohagent-release-city-remaining.log`的四项差异完全相同，本轮未刷新golden。未宣称最终全套CI或原生验收通过。

旧Skill发布分支493ac71d独立融合：删除release.yml（skill-v标签发布）、package-clawhub.yml及对应打包测试，保留桌面release-desktop.yml与当前提交Verify门禁；源码分类、CLI版本口径保留。本轮仅本地融合，不push、不Release，不覆盖或清理旧worktree。

旧发布流程清理后，Python源码分类8项、regressions 88项均通过；桌面发布工作流守卫再次通过。
