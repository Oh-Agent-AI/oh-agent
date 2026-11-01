# 机甲战斗体验迭代：验证记录

日期：2026-10-31<br>
历史证据基线：`feature/mecha` 的 `9606fa221c0f11f34ee0bc73ede1fed0f73b833a`；旧工作分支 `codex/mecha-battle-ux`<br>
当前集成基线：本地 `feature/mecha` 的 `c4b5c224`；独立工作树 `/Users/Admin/.codex/worktrees/mecha-ux-integration/skill-vitals`、分支 `codex/mecha-battle-ux-integration`；新基线证据见后文。<br>
对应规范：`MECHA_BATTLE_UX_ITERATION_SPEC.md`

## 状态

**尚未完成 A/B/C 切片验收，也不满足发布条件。** 本记录区分代码检查、合成浏览器观察和仍须完成的真实环境与用户测试。浏览器观察不等于 Tauri、真实输入设备或可用性验收。

## 旧工作树自动化检查（历史）

在 `apps/agent-city/ui` 执行：

| 检查 | 结果 | 范围与限制 |
| --- | --- | --- |
| `npm run verify:mecha` | 174/174 通过 | 规则、控制器、预测/结算一致性及既有场景测试；不是 UI 设备交互测试 |
| `npm run verify:mecha-models` | 31/31 通过 | 模型、动画、表现与资源测试 |
| `npm run typecheck` | 通过 | 最新 UI 修改后 |
| `npm run build` | 通过 | 最新 UI 修改后；构建产生较大 chunk 警告 |
| `node scripts/verify-city-mecha-ux.mjs` | 通过 | 源码结构和翻译检查；不替代运行时交互或设备测试 |

规则定向测试包含：损楼与实际结算、无守楼对象和超时、全灭后不再产生敌方行动、预测和实际阶段快照、推挤/碰撞、后续行动落空、修理、候选目标及预览异常降级。控制器测试覆盖候选选择和失效、确认待机以及草稿状态。测试通过不代表所有 SPEC 交互场景均已实测。

## 浏览器观察

- 环境：macOS 26.5.2，Apple M3 Pro，arm64；Playwright 无头 Chromium / SwiftShader，设备缩放 1。使用本地合成数据 `fixtureSessions=30`，城市 seed `4196523069`；未读取真实会话数据。
- 1100×700，英文：初始全部待机时，三机预计敌方受击均为 0，守楼 80/80 → 68/80，预计损失 12；取消确认有效，继续提交后守楼实际为 68/80。敌方次序列表与分栋列表在该 fixture 中可打开。此条不是对所有地图的结论。
- 390×844，英文触屏仿真：确认框显示预计损楼 12，取消有效；此前的移动端截图仅用于记录无头浏览器布局，不是实际触屏验收。
- 某次自动化交互脚本因按钮英文名称写错而失败；这是测试脚本失败，不能据此判定目标选择成功或产品不可用。

## 未完成及发布阻塞项

1. 在正式 Tauri `.app` 的注册插件路径上，已用合成数据完成一条程序化待机场景冒烟检查；仍须实际设备操作、其他战斗路径和视觉验收。隔离探针或 bundle 构建通过不等于完整机甲场景通过。遵循仓库要求，禁止直接启动裸 menubar 二进制。
2. 依 SPEC 11.3 补齐 1100×700、1440×900、390×844 的中文/英文、普通态、焦点、重叠、选目标、展开顺序、预览错误和结算后截图及检查。不能以已有局部英文无头截图替代矩阵。
3. 在实际鼠标、键盘和触屏上走通机甲选择、威胁、目标、取消、修改草稿及提交；检查暂停、演出、终局、重开、退出和资源清理。应特别验证列表移动的键盘选择与确认、触屏目标先预览再确认。
4. 固定高威胁 fixture，在目标桌面硬件完成 20 次连续目标切换，记录浏览器/设备、p50、p95、最慢帧和主线程长任务。目标 p95 ≤ 200ms、无 >100ms 长任务；已有本机浏览器近似测量，但目标硬件身份及正式环境尚未确认，详见后文。
5. 组织至少 5 名未参与设计的目标用户完成 SPEC 的两项任务，记录成功率、耗时和误解点；每项至少 4/5 无提示完成。此项需真实用户，不能由自动化或开发者代替。
6. 完成上述检查后重新核对对应切片验收标准，记录失败项及修复，并由产品/技术评审 SPEC 与发布风险。

## 本轮补充

- 174 项和 31 项测试在目标候选及列表移动功能完成后重跑通过；随后只调整了 HUD 最大高度。`npm run typecheck`、`npm run build` 和界面结构检查在该 CSS 调整后重跑。
- 390×844 无头 Chromium 在最终布局上可展开移动列表、选择坐标并触发“Apply move”；确认框仍显示损失 12。此自动化不证明实际棋盘位移，也不替代真实键盘或触屏操作。
- `npm audit --json` 报告 1 个 high 级依赖项：直接开发依赖 Vite `<=6.4.3`，包含 Windows launch-editor 相关 [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) 等通告；尚未评估本项目环境是否受影响。未运行 `npm audit fix` 或改动锁文件，需单独排查与处置。
- 截图保存在本机 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/mecha-battle-ux-evidence/`；其中 `desktop-summary-earlier.png` 早于最后的列表移动布局修改，另外两张为最终移动端布局。截图不随 Git 工作树分发。
- 1100×700 最终目标选择截图中，摘要面板底边为 y=292，行动面板顶边为 y=304，候选确认区域位于行动面板内；这是单场合成页面的几何检查，不代表完整视觉矩阵。最终证据另存为 `desktop-target-1100x700-en-final.png`、`desktop-confirmed-1440x900-en-final.png`。
- 可重复的无头浏览器回归脚本为 `scripts/verify-city-mecha-battle-browser.mjs`（先启动合成独立页 Vite，执行通过）；范围覆盖固定 seed 的待机风险、取消、提交、顺序与威胁焦点联动、一次目标预览与确认、暂停/继续/退出以及该桌面视口的面板边界。脚本的坐标选择仍使用 `selectOption`，键盘仅激活按钮。
- 随后定位到一个实际鼠标问题：行动说明原本会撑高底部面板，使悬停后的按钮位置变化，首次点击可能未命中。现已把说明移出面板布局；该修复仍需按真实鼠标和目标选择矩阵验收。
- 在该修复后的 1100×700 无头浏览器中，第二回合通过列表选择落点并用鼠标进入近战目标选择；选择 Boss 后草稿未改变，明确确认后草稿变为 `Melee Boss`。候选试算显示直接伤害 2、碰撞导致 Boss 38 → 36 和西侧敌人 8 → 6；这是对单个合成局面的观察，不是规则与设备矩阵的替代。

## 隔离包构建

- 最新 UI 修改后，使用 `AGENT_VITALS_PLUGIN_ISOLATION_PROBE=1 cargo tauri build --ci --bundles app --config tauri.isolation-probe.conf.json --features plugin-isolation-probe` 构建隔离探针 `.app` 成功。该测试包使用合成数据，不能据此认定原生机甲战斗通过验收。
- 使用 `open -n` 启动隔离 `.app` 的首次原生探针失败：`formal_projection_window_timeout`。记录先出现宿主 `runtime_error`（无堆栈帧），随后等待投影窗口切换超时；原因尚未定位，不能假定与本次机甲改动有关或无关。该探针未进入完整隔离流程，更不能证明机甲战斗已验收。报告位于 `/tmp/mecha-isolation-probe-1793458038-73863.json`。
- 独立重试一次仍得到同一超时和无堆栈的宿主 `runtime_error`，报告 `/tmp/mecha-isolation-probe-retry-1793458093-74196.json`。静态排查发现探针仍查找 `.plugin-toolbar select`，而基线 `CityApp.tsx` 已将时间窗口移入城市设置；这是一处可能的探针与界面不匹配，尚未通过修复实验确认，需单独处理后重跑。

## 隔离探针路径修正与复验

- 探针原先从宿主工具栏寻找时间范围下拉框，但该控件已移到「更多工具 → 城市设置」；重置视角也在「更多工具」。已将探针改为先展开更多工具、打开 City 设置、在子 WebView 更改时间范围、等待真实投影变为 7 天并关闭设置，再点击重置视角。各步骤均有单独超时，未跳过原有断言。
- 重建隔离 `.app` 后以 `open -n ... --args --plugin-isolation-probe <report>` 运行，结果 `passed / probe_complete`，依次记录设置点击、窗口选择、7 天投影就绪、重置及航拍启动/停止，后续独立渲染器、故障恢复、旧实例消息拒绝、挂起与退出恢复均通过。报告：`/tmp/mecha-isolation-updated-1793458449-76371.json`。此前两次失败继续保留；通过修正路径后不再复现，支持探针路径过时的判断，但不能据此证明机甲场景已在原生环境通过。
- 新增无头键盘回归时发现，macOS 无头 Chromium 中，原生 `<select>` 的方向键在独立最小页面也不可靠；因此回归仍通过 `selectOption` 设置落点，再用键盘激活移动按钮。**不把此测试当作真实设备键盘选择通过**，该项仍待实际键盘验收。
- 再次查询 `npm audit`，Vite 的 1 项 high 依赖报告包含两个 Windows launch-editor 条目、另一个编辑器参数注入条目、自定义中间件跨源执行及非 Windows 路径访问条目；不能将整个报告概括为仅影响 Windows。项目实际可达性及安全升级方案仍待单独评估。
- 更新后的无头合成浏览器回归已通过：在 1100×700 下通过键盘打开/关闭顺序、选中敌人并检查顺序列表与威胁按钮的来源和焦点一致，选定移动坐标后以键盘激活移动，试算目标后以键盘确认；仍不代表物理设备的键盘、触屏或完整路径验收。
- 本轮在最终 CSS 状态重新执行 `npm run verify:mecha` 与 `npm run verify:mecha-models`，分别 174/174、31/31 通过。

- 在修正“Skip animation”按钮名称后的最终浏览器脚本上重跑通过；合成场景中暂停时提交与行动按钮禁用、草稿保留，继续后草稿仍在，退出后机甲覆盖层消失。它不证明物理设备交互或监听器与 GPU 资源清理。

## 原生独立 City WebView 合成探针

- 新增仅在 `plugin-isolation-probe` feature 中启用的 `--plugin-mecha-probe <report>`：通过隔离 `.app` 的 `open -n ... --args` 启动，创建一个**非正式注册插件**的独立 City 子 WebView；它使用本地合成 fixture，不请求 authority DB。URL 请求 `fixtureSessions=30`（按时间窗口筛选后显示数量可能不同），配置城市 seed `4196523069` 和中文。宿主窗口 1100×760 逻辑像素，子 WebView 1100×700；截图仅抓取唯一隔离探针窗口，未抓取其他应用或真实会话。
- 最新构建和探针报告 `passed / probe_complete`：场景进入、全待机预计损楼 12、取消、重新确认提交、结算守楼 68/80；报告中未记录 `runtime_error` 或 `unhandled_rejection`。报告里的 fixture 数量与 seed 是**请求/配置值**，不是对最终加载数量或 seed 生效的独立断言。报告：`/tmp/mecha-native-confirm-1793459103-80277.json`；上一轮先通过的报告也保留在 `/tmp/mecha-native-webview-1793458794-78530.json`。
- 经人工查看后，仅将战斗普通态、待机确认、结算后三张窗口截图和最新报告复制到本机证据目录，文件名分别为 `native-standalone-board-zh.png`、`native-standalone-hold-confirm-zh.png`、`native-standalone-resolved-zh.png`、`native-standalone-probe.json`。原始截图 2424×1744 像素，包含窗口边缘和阴影；不能按它推断整个 SPEC 视口矩阵通过。
- 这是程序化 DOM 点击与单个合成局面的原生 WebView 冒烟检查，**不是**正式注册插件中的机甲验收，也不是实际鼠标/键盘/触屏操作、性能、资源清理或用户测试；上述发布阻塞仍全部保留。


## 注册插件合成探针与视觉证据补充

- 正式注册 City 插件的机甲场景首次探针以 `mecha_hold_risk_timeout` 失败，报告 `/tmp/mecha-formal-confirm-1793459568-82780.json`。原因是该路径使用默认三会话合成数据、开局建议包含冲撞和近战，而旧探针误套用了独立 30 会话场景的「全待机损楼 12 / 80→68」断言；首次探针实际提交了混合建议，不能作为全待机测试通过。浏览器复现并确认三会话局面选择三台待机后是预计损失 3、32→29。
- 修正探针为逐台显式选择待机、验证三张行动卡确实为待机，再执行风险确认、取消、重新确认和结算；原独立场景的 12 / 68 断言未改变。重新构建隔离 `.app`，通过 `open -n ... --args --plugin-formal-mecha-probe <report>` 运行，报告 `passed / probe_complete`：预计损失 3，取消成功，再次提交后 29/32，退出战斗后关闭注册的 `plugin-city-1` WebView，未记录 `runtime_error` / `unhandled_rejection`。报告 `/tmp/mecha-formal-confirm-1793460079-85946.json`；证据目录含 `native-registered-{board-hold,hold-confirm,resolved}-zh.png` 和 `native-registered-probe.json`。
- 该 `.app` 是隔离探针构建，正式注册插件由宿主打开，但投影由探针 feature 强制使用合成 fixture，注册插件的 authority 请求被拒绝，不读取用户会话；本次是程序化 DOM 点击而不是物理输入。seed `4196523069` 已在设置和隔离 localStorage 中保存，但没有独立验证引擎实际采用的 seed。实例销毁检查不等于监听器、Three/GPU 资源全部释放验证，也不代表普通生产 `.app` 的完整实机验收。
- 在 `matrix/` 中记录无头 Chromium / SwiftShader、DPR 1、合成 30 会话请求及 seed `4196523069`：三个视口、中英各六态（普通、敌人焦点、顺序、待机确认、结算、目标候选），共 36 张，几何信息在 `geometry.json`。这些画面只是一次合成场景快照，不保证整个棋盘或所有操作在各状态均未被遮挡。目标候选在 390×844 的行动面板会发生内部滚动，初始截图中结果和确认按钮不全可见；中英文在三个视口滚动至确认按钮后均通过 Playwright trial click，中文是在修正下文的测试定位器后重跑通过；这不能代替物理输入或可发现性评价。
- 另在 Vite 开发模块的浏览器响应中注入一个**仅用于测试**的显示预览异常，不修改产品源码，生成 `preview-fault-*` 中英六图：提示风险未知、没有显示虚构的建筑预测。源码测试中已有预览异常恢复断言；注入截图不代表故障在真实生产环境自然发生。首次中文滚动检查因脚本误将「确认选择」写成「确认目标」而超时，是测试定位器失败，不据此判断产品行为。
- 三会话 fixture 首回合三台待机后，第二回合坐标 `4,7` 同时出现在可移动选项和小怪西的预测攻击列表；该交集来自 DOM 选项和威胁列表的断言，而非仅从颜色推测。已生成中英文三视口共六张 `movement-threat-overlap-*` 截图，状态不证明该格的纹理在所有尺寸上清晰可辨或未被面板遮挡，还须针对棋盘呈现和真实设备逐项检查。

- 本轮结束前重跑 `npm run typecheck`、`npm run verify:mecha`、`npm run verify:mecha-models`，均通过（后两者分别 174、31 项）；隔离 `.app` 本轮重新构建通过。截图生成脚本按当时执行版本保存在证据目录 `matrix/source-scripts/`，带本机绝对路径，仅为复现辅助，不作为正式实机或视觉验收工具。

## 目标试算小屏修正（后续轮次）

- 先前 390×844 截图暴露：长目标试算可能超出行动面板，确认按钮在结果末尾，仅将整个结果 `scrollIntoView({block: "nearest"})` 并不能保证确认可见。本轮将选择后的确认、取消放到试算标题下方，并只滚动行动面板，使所选结果从面板顶部开始；不会因为悬停候选而触发该滚动。试算较长或面板空间不足时，详细内容及不可选原因仍需在面板内滚动；这一修改不宣称整个棋盘无遮挡。
- 新增 `scripts/verify-city-mecha-target-viewport.mjs`：本机无头 Chromium / SwiftShader、DPR 1、`fixtureSessions=30`、seed 设置 `4196523069`；中英、390×844、1100×700、1440×900 的同一候选场景均通过。每次选目标后不对结果或按钮执行额外滚动，检查确认/取消按钮完整位于面板内且中心点未被遮挡，再取消并断言草稿未变化；另检查选中后从 1100×700 切到 390×844 再切回的同一结果。截图保存于证据目录 `target-viewport-after/`。这是合成页面自动化和单个目标的检查，不能替代物理输入、Tauri WebView、完整视觉矩阵或用户可用性测试。
- 修改后 `npm run typecheck`、`npm run build`、`npm run verify:mecha`（174 项）、`npm run verify:mecha-models`（31 项）、`node scripts/verify-city-mecha-ux.mjs` 和原 1100×700 `node scripts/verify-city-mecha-battle-browser.mjs` 通过。构建仍有大 chunk 警告。此前原生插件截图与探针运行在本次修改前，不能当作本次 UI 改动的原生复验。
- 移动端地图仍被上下 HUD 大面积覆盖；移动/威胁重叠格能否从棋盘上辨识、交互是否被阻断仍未完成验证。SPEC 11.3 的实际输入、桌面性能、资源释放和 5 人用户测试仍是发布阻塞项。

## 移动端战场查看与危险遮挡修正（后续轮次）

- 三会话合成场景依次将三台机甲设为待机并提交后，守楼 32→29。第二回合 `4,7` 同时出现在移动选项和小怪西的威胁来源中；该格还是当前突击机甲所在格，故点击它应拾取格子而非凭空产生移动。390×844 下投影中心约为 `(111.9, 548.6)`：普通 HUD 覆盖该点。
- 新增「查看战场 / 恢复面板」：临时收起 HUD，保留顶栏、草稿和战场视图；棋盘格被拾取后恢复 HUD，再按原控制器处理。窄屏顶栏按钮等宽并允许换行，避免英文截断；该功能不保证整个棋盘位于屏幕内。
- 检查截图与注入式渲染诊断发现 `4,7` 的危险斜纹实际受到机甲遮挡：关闭斜纹深度测试后可见，但整条纹理会穿过模型。产品实现保留地面斜纹的深度测试，并在威胁格角落增加不参与深度测试的警告三角；三个共享材质区分普通、其他来源和焦点，纹理和材质在场景清理时释放。帮助文案解释两种危险标记。该标记有意在遮挡物前显示，可能与城市模型或其他标记视觉重叠，仍需真实设备与不同局面评估。
- `scripts/verify-city-mecha-map-focus.mjs` 在 Vite 的内存响应中插入测试接口，不修改产品源文件，不读取真实数据。无头 Chromium / SwiftShader、DPR 1、390×844 中英文各一次：键盘切换 HUD 后视图和草稿不变，`4,7` 变为 Canvas 且射线拾取同格，点击后恢复 HUD；模拟触屏另选一个可达空格 `4,3` 并确认草稿更新。顶栏按钮的盒子和文本无裁剪。该测试用到软件渲染和模拟触屏，不能替代实际键盘、鼠标或触屏验收。
- 同一格的警告三角使用真实屏幕截图比较可见与测试接口临时隐藏两种状态，在投影点周围 20×20 像素区域分别检测到 9 与 0 个红色像素。此证明仅针对该 fixture / 视角，不能证明所有威胁格、重叠组合、屏幕尺寸、对比度或图例可发现性。截图在证据目录的 `map-focus-warning/`，注入诊断截图在 `stripes-diagnostic/`。没有把深度测试关闭应用于产品地面条纹。
- 修改后 `npm run typecheck`、`npm run build`、`npm run verify:mecha`（174/174）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-ux.mjs` 和 `git diff --check` 通过；build 仍有大 chunk 警告。后续浏览器矩阵及隔离原生重建的结果另行记录。
- 仍未完成：完整棋盘取景（截图可见棋盘两侧超出手机画面）、多个敌人同格且可达/可选目标的真实可辨性、触屏选目标与确认/取消的完整实机流程，以及上述性能、资源释放和 5 人用户测试。旧原生截图在这些 UI 修改前，不作为本次修改的原生视觉证据。
- 补充控制器合成 fixture：Boss、左右小怪均预计攻击 `(5,2)`，该格同时是 Support 的可达格和合法修理目标 Assault 所在格。断言三方来源各自保留、汇总只保留一个格、逐一选择和悬停均能聚焦该格；模拟控制器 touch 选目标只生成候选，取消不改草稿。此为规则/控制器测试，不证明真实三维纹理、鼠标/键盘/触屏或列表表现。
- 本次 UI 修改后，原 1100×700 浏览器流程（风险确认、顺序/威胁焦点、目标试算、暂停/恢复和退出）及中英文三个视口的目标选择/取消可见性脚本均再次通过；这些仍为合成 Chromium 自动化，不代替原生或真实用户验收。
- 最新中英文 `verify-city-mecha-map-focus.mjs` 还在移动后暂停，模拟触屏拾取另一格，确认面板恢复但已规划移动不变；恢复后草稿仍保留。完整规则/控制器回归随后为 175/175，typecheck、结构检查和 `git diff --check` 再次通过。

## 原生注册插件冒烟失败（本轮）

- 在移动 HUD 与危险标志修改后，已用 `AGENT_VITALS_PLUGIN_ISOLATION_PROBE=1 cargo tauri build --ci --bundles app --config tauri.isolation-probe.conf.json --features plugin-isolation-probe` 构建隔离 `.app`，经 `open -n` 运行正式注册插件路径的合成 fixture 程序化冒烟。报告 `/tmp/mecha-formal-hud-warning-1793462452-96247.json` 为 `failed / formal_mecha_seed_timeout`：宿主与城市 `ui_ready`、设置按钮点击成功后约 14.6 秒报 `formal_unresponsive`，180 秒时未完成种子设置。具体原因尚未定位；不能推断为产品缺陷或探针缺陷，也不能把此前版本的通过结果用于本次验收。此运行发生在最新相机适配修改之前，本次原生环境尚未通过复验。
- `npm audit --json` 针对 `apps/agent-city/ui` 当前锁定的 Vite 6.4.3 报 1 个 high（同一直接开发依赖含 5 条通告，包括 Windows launch-editor 和自定义 middleware、`server.fs.allow` 相关问题）；不等于生产包已受影响。是否在实际开发环境可触发、以及升级至不受影响版本的兼容性尚未验证，未运行 `npm audit fix` 或更改依赖。完整输出在 `/tmp/mecha-ui-npm-audit.json`。

## 战术视角适配的进行中检查

- 针对原有固定距离在竖屏裁掉棋盘两侧的问题，战术视角按画布宽高比、视场和全部网格顶点计算距离，留出顶部控件及两侧空间；旋转时保留当前距离上限，避免竖屏适配后的镜头被 520 的旧上限拉近。只在进入战斗或显式点击战术视角时重新取景，不在 resize 时打断用户镜头。
- 首次浏览器回归发现，新镜头使原先用于证明 HUD 遮挡的 `4,7` 不再被挡住，原测试因此失败；改为搜索 HUD 真实挡住的棋盘格再验证收起后的可见性，不再依赖该固定坐标。之后中文测试中 22/22 个被挡住的格子在收起 HUD 后露出，初始竖屏和三个重置视口的网格投影均在边界内。但警告图标显示/隐藏对照检测为 0/0，**暴露图标在拉远后不可读，整套测试失败**，不能将这些部分结果当作整体验收通过。
- 后续将危险与攻击顺序标记改为按屏幕像素大小呈现且不受雾衰减；是否真正可读、是否遮挡其他关键标记及实际设备效果仍需复验。运行产物见证据目录 `camera-fit/`；该截图显示完整棋盘但机体和地面细节偏小，用户可自行缩放，不能以此代替用户可用性评估。
- 首次按像素大小放大标志的中文复验仍未通过先前的红色像素门槛（0/0）；局部截图显示图标经 SwiftShader 低渲染分辨率采样后发淡。随后减小符号占比、提高红色面积与对比并禁用标志色调映射，尺寸设为 16 CSS px；中文 390×844 合成复验中显示/隐藏对照为 57/0 红色像素，HUD 收起露出 22/22 个被挡格，重选目标格、模拟触屏移动和暂停保护通过。该结果仍仅适用于此软件渲染/fixture；图标可能遮挡密集目标，需检查多敌同格、其他视角及实机。中英文完整矩阵尚在运行。

## 相机取景与多威胁同格复验（本轮）

- 最新编号排布修改前，中英文 `scripts/verify-city-mecha-map-focus.mjs` 均通过：初始 390×844、战术视角重置后 390×844 / 1100×700 / 1440×900 的棋盘网格投影检查，旋转后重置，HUD 收起后的棋盘拾取、模拟触屏移动及暂停保护。两个语言下危险标记显示/隐藏的红色像素对照均为 57/0。证据在 `mecha-battle-ux-evidence/camera-fit-final/`；测量环境仍是合成页面、SwiftShader、模拟输入。最终修改后仍需重跑。
- 首次 `scripts/verify-city-mecha-multithreat.mjs` 中文合成场景验证：Boss 和两只小怪同时威胁 `(5,2)`，该格是 Support 可达格及 Assault 合法修理目标；三条来源可分别聚焦，危险、警告和目标叠层均在场景中存在，模拟触屏候选可取消或确认，取消不改变草稿。但投影发现三个攻击次序标记仅间隔约 8 CSS px，14 px 图标相互覆盖，**初版视觉不通过**。
- 已将同格次序图标按屏幕空间居中排列，并在危险标记上方显示；24 CSS px 图标间距为 27 CSS px，禁用色调映射，非当前焦点保留 0.8 透明度。中文合成场景在 1100×700、1440×900、390×844 及各旋转视角的投影间距均为 27 CSS px，来源切换、目标叠层、模拟触屏候选/取消/确认通过。截图 `mecha-battle-ux-evidence/multithreat-readable/` 显示三个编号不再互相覆盖；在 SwiftShader 降分辨率渲染下仍有模糊，不能证明不同格之间不会互相遮挡或真实设备上可读。英文及完整回归正在进行。上述证据均位于本机 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/`，不会进入仓库。
- 英文多威胁复验亦在三个视口及各旋转视角通过同样的 27 CSS px 间距断言、来源切换、目标叠层和模拟触屏候选/取消/确认。完整英文固定流程浏览器回归通过；最终中英文视口与相机复验见下方记录。
- 本轮最终源码的 `typecheck`、规则/控制器测试 175/175、模型测试 31/31、`build`、结构检查和 `git diff --check` 均通过；构建仍报告较大 chunk。Tauri 隔离 probe `.app` 的构建日志显示成功打包。两次测试命令的 zsh 包装末尾误用了只读变量 `status`，因而包装器退出码为 1；各步骤已按日志核对，类型检查/构建/结构检查另用无该赋值的命令成功重跑，不把该包装器的退出码误记为通过。最新 bundle 的正式注册插件运行结果见下方复验记录。

## 基线分叉风险（本轮发现）

- 本 worktree 的 `HEAD` 是 `9606fa221`（本机 `origin/feature/mecha`），本机 `feature/mecha` 已推进至 `c4b5c224`，相对当前 HEAD 多 11 个提交；其中 `6787adf1` 包含本 SPEC 和一部分 UX 变更，后续还合入远程对战基础。原 `feature/mecha` 工作区另有未提交改动，未修改该工作区。
- 当前测试只证明 `9606fa221` 加本 worktree 的未提交变更；**不能代表已在最新本地 `feature/mecha` 验收通过**。尤其最新分支 `MechaBoard.tsx` 有 `RemoteMechaControls`，当前旧基线没有。直接按当前文件覆盖最新分支会丢失远程对战入口，禁止这样集成。只读三方试合并检查（基准 `6787adf1`、本 worktree、`c4b5c224`）对 8 个重叠文件未产生文本冲突，但这不证明运行时兼容，亦未包含原工作区未提交内容；正式集成须保留双方变更并重新执行类型检查、远程对战/本地战斗测试、浏览器和原生验收。


## 最新相机、原生探针与性能复验（本轮）

- 最终次序标记调整后，`scripts/verify-city-mecha-map-focus.mjs` 的中文和英文合成浏览器回归均通过：初始竖屏、三种视口重置、旋转、HUD 收起与拾取、模拟触屏移动和暂停保护。危险标记显示/隐藏红色像素对照分别为中文 57/0、英文 55/0；英文测试中 27/27 个由 HUD 遮挡的被测格在收起后露出。截图在本机证据目录 `mecha-battle-ux-evidence/camera-final-2/`。目标选择/取消三视口中英文复验和完整浏览器流程也通过。这些仍是合成页面及模拟输入，不能证明实机交互、所有格子的视觉可读性或不同格标记之间无遮挡。
- 使用本轮重新构建的隔离 `.app`，通过 `open -n ... --args --plugin-formal-mecha-probe <report>` 运行正式注册插件合成 fixture；报告 `/tmp/mecha-formal-order-1793464323-5249.json` 为 `passed / probe_complete`，记录 seed 已保存、全员待机预计损楼 3、取消、重新确认、结算守楼 29/32、退出战斗及插件关闭。此前 `formal_mecha_seed_timeout` 的失败记录保留；本次重跑通过不确定其根因。程序化 DOM 操作和报告中的插件关闭不等于物理输入、全部终局流程或 Three/监听器资源释放验收。
- 新增 `scripts/verify-city-mecha-performance-browser.mjs`，在 Vite 开发页面注入合成固定场景：10 个规则建筑、3 个威胁源、Support 的两个合法修理目标。首次运行立即计数威胁按钮得到 0（断言失败，未产生性能测量）；原因是脚本没有等待战斗异步渲染。补充等待后重跑：macOS 26.5.2、Apple M3 Pro、桌面有界面 Chrome 156.0.8078.74、1100×700、DPR 1、ANGLE Metal Apple M3 Pro；交替程序化点击 20 次并等待结果 DOM 变化及第二个 RAF，p50 **16.5 ms**、p95 **19.5 ms**，观测到的最大 RAF 间隔 **16.7 ms**；支持 Long Tasks，采样区间记录 0 个长任务。原始数据 `/tmp/mecha-performance-browser-1793464389-5601.json`。
- 该性能结果只是本机浏览器的近似基线：`.click()` 非物理输入，第二 RAF 不保证实际屏幕已呈现，最大 RAF 间隔不是完整帧耗时；采样持续时间短且可能使用候选缓存，开发服务器也不等于原生 WebView。此机器是否是产品约定的目标硬件尚未确认，尚不能据此宣称 SPEC 性能验收通过。
- 仍须在最新 `feature/mecha` 安全集成并重新验证，完成正式 Tauri 实际输入及资源释放检查、目标硬件性能确认，以及至少 5 名目标用户的两项任务测试；各项未完成前不将 A/B/C 标记为验收完成。

## 最新已提交分支隔离集成（进行中）

- 上述证据的代码基线仍为 `9606fa221`；本节另在独立 worktree `/Users/Admin/.codex/worktrees/mecha-ux-integration/skill-vitals`、分支 `codex/mecha-battle-ux-integration`，从本机 `feature/mecha` 的 `c4b5c224` 开始。使用 `6787adf1` 作为包含首批 UX 改动的共同基准，逐文件三方移植旧工作树的改动，保留远程对战入口。原工作区和旧工作树均未修改；没有提交或合并。
- 新基线的 `npm run typecheck`、`npm run build`、`npm run verify:mecha`（包含远程 match/session/client 测试）、`npm run verify:mecha-models`、`node scripts/verify-city-mecha-ux.mjs`、`git diff --check` 通过；build 有大 chunk 警告。1100×700 固定流程浏览器检查和中英文三个视口目标选择/取消检查通过。均只覆盖当前集成工作树；旧版原生探针、性能与截图不能自动作为新基线的通过证据。
- 原工作区另有未提交 Assault 接地等改动，涉及 `CityMechaWorld.tsx` 和 `MechaBoard.tsx`。只读三方试合并这两份未提交内容时各有一个文本冲突，分别涉及 `onHoverCell` 与 `onUnavailable/onPreviewLoading` 接口、地图聚焦和 Assault 预览错误处理；它们的其他新增依赖也未移植。不得用集成工作树文件直接覆盖原工作区；后续须合并双方接口和相关依赖后独立验证，且不能把已提交基线的成功视为覆盖这些未提交改动。
- 新增本地合成的远程活跃态交互检查中，首次测试替换模块使用浏览器不能解析的裸 `react` 导入，导致 City settings 等待超时；这是测试脚本失败，不是产品通过或失败。脚本已改为引用 Vite 本地模块并继续复验；它用替身切换 UI 活跃状态，不请求真实 relay。

### 集成树远程活跃态补充回归（2026-11-01）

- 用仅在 Vite 响应中注入的测试替身模拟 `remoteActive`，未发起真实 relay 或 host IPC。第一轮因测试替身的裸 `react` 导入无法在浏览器解析而超时；更换为 Vite 本地依赖后，第二轮因测试替身按钮被 HUD 遮挡而超时。改用程序化点击替身后，第三轮实际复现目标确认按钮未锁：`candidate confirmation must lock while remote is active`。以上三次失败均保留为过程记录，不是验收通过。
- 针对集成 UX 的本地入口增加活跃态保护：禁止棋盘修改、悬停试算、选择机甲、选择/确认/取消目标、自动对战 tick、设置/重开/暂停等；全员待机确认的“返回修改”同样锁定。只读敌意焦点和视角操作仍可用。远程活跃时增加中英文说明：桌面是本地局面，并不同步远程战况，停止远程会重开本地局；提交区不再提示可以结算或修改系统建议。
- 修改后 `scripts/verify-city-mecha-remote-lock-browser.mjs` 通过：英语合成场景中激活替身，确认目标按钮、机甲选择及地图编辑受锁，草稿不变，停用替身后可以继续确认目标；同时验证远程状态提示出现和消失。该检查是模拟状态切换及程序化 DOM 操作，不验证远程会话、移动端、真实联网、原生 WebView，也不覆盖所有控件/语言与状态组合。
- 最后修改后的集成树 `npm run typecheck`、`npm run verify:mecha`（195/195）、`npm run verify:mecha-models`（31/31）、`npm run build` 通过；构建仍提示大 chunk。`verify-city-mecha-ux.mjs` 首次失败是因为其静态断言仍要求旧的自动 tick 条件；更新断言以要求新增的 `remoteActive` 锁后重跑通过，`git diff --check` 通过。日志 `/tmp/mecha-integration-check-1793465157.log` 保留首次失败，不应当作全绿日志。
- 已知未完成：`RemoteMechaControls` 目前在 `start` 的 host 请求成功后才标记活跃，请求等待期间本地仍可改变，尚未验证失败、退出、后台自动对战与远程生命周期；不能把活跃态测试扩大为远程端到端验收。原工作区未提交的 Assault 接地相关变更仍未集成。
- **数据边界及仍需核查的项目（2026-11-01 更新）**：最新仓库政策第 7 条已明确为桌面用户主动发起或批准的机甲对局提供例外，允许范围内的 `RemoteArenaV1`、对局命令、快照与事件经 HTTPS/WSS relay 发给授权设备；不能再笼统表述为远程对局尚未获准。该例外不自动证明 `c4b5c224` 既有实现合规：仍须逐项核查 arena/state 转换不含日志、prompt、会话分析、完整 City 投影、本地路径或原生标识等禁传字段；relay 只在内存转发对局内容、仅短期保存获准元数据；启动、轮询及关闭均限于主动授权对局且没有遥测或其他后台联网。本次没有用真实数据或真实 relay 测试，UI 锁定不能替代产品/安全评审。


### 集成树浏览器矩阵复验（2026-11-01）

- 最终集成代码串行运行 `verify-city-mecha-battle-browser.mjs`、`verify-city-mecha-target-viewport.mjs`、`verify-city-mecha-multithreat.mjs`、`verify-city-mecha-map-focus.mjs`，全部通过，日志 `/tmp/mecha-integration-browser-1793465197.log`。覆盖固定场景待机风险与结算、目标选择/取消、三威胁来源和编号，以及中英文 1100×700、1440×900、390×844 视口下的选中/取景与部分触屏模拟。地图查看合成测试中，中英文被 HUD 遮住的被测格分别揭示 22/22、27/27；单一重叠格危险标记的显示/隐藏像素对照分别为 57/0、56/0。
- 新增 `--hold` 远程替身场景，先复现预计建筑损失 12 的全员待机确认，再模拟远程活跃，确认“返回修改”和“继续提交”禁用、草稿与回合不变，停止替身后可返回编辑；原目标选择场景也再次通过。两种场景日志 `/tmp/mecha-remote-final-1793465756.log`。只是合成状态替身与程序化操作，不联网，也不代表真实远程生命周期已完成。
- 以上均为无头 Chromium/SwiftShader 下确定性 fixture；不代替真实硬件、物理输入、原生插件、完整视觉组合或目标用户验收。本基线性能复验另行记录。
- 当前集成代码以 `AGENT_VITALS_PLUGIN_ISOLATION_PROBE=1 cargo tauri build --ci --bundles app --config tauri.isolation-probe.conf.json --features plugin-isolation-probe` 构建隔离包成功（构建日志 `/tmp/mecha-integration-native-build-1793465844.log`），并仅经 `open -n` 运行该 `.app`。正式注册插件合成 fixture 报告 `/tmp/mecha-integration-formal-1793466157-10982.json` 为 `passed / probe_complete`：保存种子、待机预计损楼 3、取消后重新确认、结算建筑 29/32、退出战斗及插件关闭。无真实会话数据，程序化 DOM 操作与插件关闭不证明物理输入、全部终局或具体 GPU/监听器资源释放。
- 当前集成代码的本机有界面 Chrome 性能复测（固定 10 栋规则建筑、3 威胁、两合法修理目标；MacBook Pro / Apple M3 Pro / 18 GB、macOS 26.5.2、Chrome 156、ANGLE Metal、1100×700、DPR 1）：20 次程序化交替选择并等待 DOM 和第二个 RAF，p50 **16.85 ms**、p95 **24.2 ms**；最大观测 RAF 间隔 **16.7 ms**，采样中长任务 0。原始报告 `/tmp/mecha-integration-performance-1793466192.json`，日志 `/tmp/mecha-integration-performance-1793466192.log`。采样可能命中候选缓存、开发浏览器不等于正式 WebView、第二 RAF 不保证屏幕真实呈现、最大 RAF 间隔不等于完整帧耗时；目标硬件身份和真实物理输入仍未确认，因此此结果不是 SPEC 性能验收通过。

## 后续人工验收执行表（尚未执行）

- 准备：使用独立浏览器临时配置和合成数据，不连接远程对战、不读取个人 City 数据。在本集成树 `apps/agent-city/ui` 启动本地 Vite，访问 `http://127.0.0.1:<端口>/?fixtureSessions=30`，将该临时配置的 `city.seed` 设为 `4196523069` 后刷新，进入机甲战斗。先由主持人核对初始局面、语言和 1100×700 视口；每位参与者从相同初始状态开始。这个浏览器方案用于玩测，不替代正式插件 WebView 和物理设备验收。
- 至少邀请 5 名未参与设计的目标用户；主持人只说明基本操作，不预先指出答案。分别提问：①“哪栋防守建筑受到威胁？”②“按当前草稿预计建筑损失多少，你现在可以做什么？”记录是否独立正确、各任务耗时、是否需要提示及误解；有提示即不计入该任务的无提示成功。以当前 fixture 的实际完整预测和提交状态为判分基准，不以录像或截图推断未知结果。每项至少 4/5 人无提示完成；不达标时保留数据并迭代，不补造通过结果。
- 逐人记录（只填匿名编号，不收集用户日志、会话或个人信息）：

| 编号 | 语言 / 设备 | 任务 1 无提示成功 / 秒 | 任务 2 无提示成功 / 秒 | 提示、误解与观察 |
| --- | --- | --- | --- | --- |
| P1 | 未执行 | — | — | — |
| P2 | 未执行 | — | — | — |
| P3 | 未执行 | — | — | — |
| P4 | 未执行 | — | — | — |
| P5 | 未执行 | — | — | — |

- 另需准备可交互的隔离正式 `.app` 合成 fixture，再分别用实际鼠标、键盘和触屏（如产品支持的目标设备可用）检查选择机甲、威胁、目标、取消、修改及提交，覆盖暂停、演出、终局、重开、退出和资源释放；记录系统、硬件、输入设备、语言、视口、结果及截图。当前程序化 `.app` 探针会自行操作并退出，不能代替此项；可交互的原生 fixture 尚待准备。

### 远程启动锁和设置入口修正（2026-11-01，进行中）

- 本节替代上文“启动请求等待期间未锁定”的历史描述：启动前先锁本地规划/自动 tick，并区分启动中、已启动、停止中和状态未知；只能在可规划回合启动，须先停止自动对战并结束演出。启动回复丢失、格式无效或停止失败时保持锁定，提供重试停止；只有宿主明确确认停止后才重开本地局并解锁。战斗内退出按钮及 Escape 在锁定期间受限，三维视角失效后提供停止恢复入口。
- 真实组件的合成浏览器测试发现两个设置入口原来绝对定位在同一位置，真实点击互相遮挡；已分开入口，并将两个设置面板设为互斥。发现过程中的一次真实点击被遮挡失败和静态断言因旧 markup 失败均不能视为通过；修改断言与布局后复测。首次启动的端口 5197 已被占用，改用独立端口 52971，未终止占用者。
- 合成宿主只拦截本地 Vite 对 `RemoteMechaControls` 的 IPC 调用，不连接 relay：中英文均覆盖启动等待、草稿和回合不变、禁用退出和 Escape、启动成功、停止请求失败、无效停止回复、启动回复丢失及确认停止后恢复。该测试使用 Playwright 程序化输入和 synthetic City，不等同真实宿主、联网或物理输入；中文日志 `/tmp/mecha-remote-lifecycle-browser-20261101.log`。最终组件复验情况见后续记录。
- 此次调整后的类型检查及静态 UX 脚本通过；调整设置布局前的 `verify:mecha` 195/195、`verify:mecha-models` 31/31 和 build 通过，日志 `/tmp/mecha-remote-lifecycle-check.log`；构建仍有大 chunk 警告。布局后的原生构建和复验另记。
- **具体数据保留风险**：只读检查 `apps/agent-city/relay/worker.ts` 发现 room 注册会持久化 `room:v1`；ticket/邀请/设备上的 `expiresAt` 控制鉴权，但未发现自动 alarm/TTL 清理。正常 `closeRoom` 才 `deleteAll`，而桌面停止会尽力请求 close 并忽略网络失败。因此崩溃或关房请求失败后，已过期元数据可能无限期留存，尚不能证明符合第 7 条“仅短期保存元数据”；须在远程发布前修复并测试。该检查没有证明对局内容泄漏，也没有完成全链路审计。
- **仍未完成的生命周期与发布边界**：宿主请求永久不返回时当前会继续锁定；插件整体关闭、城市重建导致战场组件卸载、宿主异常等跨组件生命周期尚未做端到端验证或证明可恢复。远程 relay、授权设备、移动端和异常断网未真实联网验证；原工作区并行 Assault 接地修改仍未集成。真实目标硬件、物理输入和至少 5 名目标用户玩测依然缺失，不能判定 SPEC 全部通过。
- 本轮设置布局及启动状态改动后，隔离 `.app` 构建成功（日志 `/tmp/mecha-remote-native-build-20261101.log`），经 `open -n` 执行正式注册插件的合成对局探针，报告 `/tmp/mecha-remote-formal-1793466967-17969.json` 为 `passed / probe_complete`：待机风险 3、取消后重确认、守楼 29/32、退出和插件关闭。此路径未启动远程对局，也不是物理输入或目标用户验收。
- 回归过程中一次替身浏览器测试及其诊断重跑均在 City settings 前超时，页面内容为空：并行的原生 bundle 构建清掉了正在运行的 Vite 的 `node_modules/.vite/deps`，旧 Vite 仍引用失效资源。重启本次专用 Vite 后重新执行；两次超时保留为测试环境失败记录，不能算通过，也不推断为产品缺陷。
- 重启专用 Vite 后，替身远程活跃态目标选择锁、全员待机确认锁和恢复均通过；新增真实组件 + 合成宿主的三维视角失效恢复检查，通过后确认停止才能退出。日志 `/tmp/mecha-remote-retest-20261101.log`。这些都是浏览器自动化，三维视角失效通过注入触发，并不覆盖实际设备或其他卸载路径。

### 可交互的正式插件合成场景（2026-11-01）

新增仅存在于 `plugin-isolation-probe` feature 的 `--plugin-formal-mecha-interactive <report>`。它走正式注册的 City 子 WebView，使用隔离探针的合成数据（默认三会话 fixture、seed `4196523069`），自动进入开场战棋；渲染时钟有进展时保留窗口供检查，不会执行全员待机或代替参与者完成测试。当前画面问题尚未排除，不可用于真人验收。探针 handler 不允许正式插件向真实 authority 发起请求，远程方法也不在此模式的请求范围内。它不是生产 `.app`，不要用它验证真实远程网络或真实数据。当前源码已加入中英文标签匹配及可选英文隔离入口，但英文原生入口尚未验证；下文既有原生结果均不是英文验证证据。

在本 worktree 的 `apps/desktop/src-tauri` 构建独立隔离包，然后只通过 `.app` 打开：

```bash
AGENT_VITALS_PLUGIN_ISOLATION_PROBE=1 cargo tauri build --ci --bundles app \
  --config tauri.isolation-probe.conf.json --features plugin-isolation-probe
report="${TMPDIR:-/tmp}/mecha-manual-$(uuidgen).json"
open -n "$PWD/target/release/bundle/macos/Oh Agent Isolation Probe.app" \
  --args --plugin-formal-mecha-interactive "$report"
echo "就绪报告：$report"
```

英文入口候选：同一 `open` 命令在报告路径后加 `--mecha-fixture-en`；仅隔离探针的 incognito 宿主请求英文，报告 `requested_fixture_locale: en` 表示请求而非验证成功。正式原生视觉与交互仍须重新检查。

等待报告出现；`status: needs_visual_check` / `manual_fixture_needs_visual_check` 只表示 DOM 已出现、引擎计时有进展且画布非零，仍须人工确认棋盘及机甲实际可见，不能视为测试通过。若为 `failed`（包括 `formal_mecha_render_stalled`），保留失败信息，不开始该轮玩测。报告生成后不继续记录人的操作或结果。每位参与者关闭隔离应用并重新启动一个新报告，确认演示标识与开局状态，再按上面的匿名方案记录语言、设备、任务耗时、无提示成功与误解点。仅在必要时截图当前合成窗口，不记录参与者个人数据。操作本身、物理输入、资源释放与 SPEC 的目标用户任务仍须逐项独立核验；不可用程序化点击或这份就绪报告代替。待人工检查状态不自动退出，失败会退出；测试后应退出**隔离探针**实例，勿结束其他 Oh Agent 进程。

- 首次交互模式尝试报告 `/tmp/mecha-interactive-ready-83efae2a-8238-401f-8503-a3388323ab21.json` 为 `failed / formal_mecha_seed_timeout`：已进入设置并点击应用种子，但尚未记录种子保存；约 16.7 秒时记录 `formal_unresponsive`。该次窗口截图仅抓取隔离探针窗口，内容为空白（`/tmp/mecha-interactive-probe-only.png`），不能推断具体根因或判定可用。随后调整为在隔离 WebView 启动前写入固定种子，避免测试准备阶段触发一次重建。

- 重新构建后，两次报告为 `ready / manual_fixture_ready`（`/tmp/mecha-interactive-ready-32811bf4-6e59-43fa-ad8e-c5a6fab16d86.json`、`/tmp/mecha-interactive-ready-55593dd3-009e-4918-82a8-ae0b026d202b.json`），但隔离窗口截图只显示战斗 HUD、海面和左侧城市一角，未见棋盘与机甲；第二次在报告后等待 20 秒仍如此（`/tmp/mecha-interactive-ready-55593dd3-009e-4918-82a8-ae0b026d202b.png`）。当前 `manual_fixture_ready` 只检查 DOM，不证明 Three 场景或截图采集正确；原因尚未确定，**该入口暂不可用于真人验收**。没有运行时错误记录也不能证明画面正常。旧版正常原生截图见本机证据目录 `native-registered-board-hold-zh.png`。

- 临时仅在隔离构建中注入投影诊断（已从源码移除），复现报告 `/tmp/mecha-interactive-ready-89e83bc2-36d8-456a-a0c2-32bee70eff10.json` 和窗口截图同名 `.png`：画布 910×680，棋盘顶点归一化投影范围 x=[−0.52,0.61]、y=[−0.79,0.71]，相机投影在视口内；进入战斗约 3 秒后引擎 `elapsed` 为 0。画面仍只有海面和城市一角，指向渲染时钟未推进，但尚不能确定调度、应用前后台或截图合成等根因。此非正常绘制或用户可读性的证明。为避免 DOM 假就绪，交互探针新增 15 秒内渲染时钟推进和非零画布检查，并将成功状态降为需人工视觉确认；该门禁不证明像素正确或棋盘可见。

- 隔离 `.app` 重建成功（日志 `/tmp/mecha-render-gate-build.log`，有大 chunk 警告）；经 `open -n` 复测得到 `/tmp/mecha-render-gate-0835574e-dd84-42d4-af76-f3871af3fc95.json`：`failed / formal_mecha_render_stalled`，事件包含 `mecha_seed_applied` 和 `mecha_render_stalled`，不再把该场景误报为可手测。该结果验证门禁能挡住本次停滞，不证明其根因。`node scripts/verify-city-mecha-native-gate.mjs` 对时钟推进、停滞、画布为零和时钟缺失四条探针脚本分支的合成测试通过；不涉及原生画面。此前同一源码的正式注册自动动作流程复测报告 `/tmp/mecha-auto-retest-34c1d211-c65d-436c-9551-15c8ad374b62.json` 通过；该自动流程不检查渲染循环或物理输入。

- 新门禁构建后的正式注册自动流程复测通过，报告 `/tmp/mecha-auto-retest-8c0a1413-8969-4571-a260-9cc7161bfdb5.json`；该流程仍仅校验规则和 DOM 操作，不证明真实画面或人手测试。`git diff --check` 通过。

- 补充前台激活实验：通过 `open -n` 启动隔离包后，对该 PID 调用 AppKit `NSRunningApplication.activate` 返回 `true`，但即时 `isActive=false`，不能确认真正获得焦点。报告 `/tmp/mecha-active-b104071a-e9db-4ee5-b266-d65b7c499b5a.json` 仍为 `failed / formal_mecha_render_stalled`。原生 attachment 记录 `attached=true`、`hiddenAncestor=false`、`windowVisible=true`，而 City runtime 多次记录 `hidden=true`、`focused=false`、`loopScheduled=true`、`contextLost=false`；模型同步绘制后 `firstFrame=true`，画布为 1137×850，但 `frameAgeMs` 从 1320 持续增长到 9000 以上。这表明物理视图已附着且窗口可见时，子 WebView 仍报告 document hidden，动画帧未推进；同步首帧不能证明持续渲染。原因尚未定位，隔离包结果也不证明生产包必然受影响。未修改 Web API 或强制绘制绕过门禁。

- 前台路径复验：隔离探针中临时仿照正式工作台调用 `show`、`set_focus`、AppKit 激活和 `makeKeyAndOrderFront`，仅通过 `open -n` 启动，不额外由外部脚本激活；构建成功（`/tmp/mecha-foreground-build.log`），报告 `/tmp/mecha-active-bd0f451e-8643-4766-995e-512ed5b42e83.json` 仍为 `failed / formal_mecha_render_stalled`，记录 `hidden=true`、`focused=false`，首帧之后的 frameAge 增至 16 秒。该实验没有修复停滞；临时代码已撤回，以免引入未经验证的前台抢占。测试环境获得前台的能力尚未证明，不能据此断定生产环境故障。重新运行 `npm run typecheck`、`npm run verify:mecha`、`npm run verify:mecha-models` 与门禁合成测试通过；原生人工视觉与用户验收仍未完成。

- 随后检查运行环境：`NSWorkspace.shared.frontmostApplication` 为 `loginwindow`；只读解析 `ioreg -a -w0 -d1 -n Root` 中的 console user 字段得到 `CGSSessionScreenIsLocked=true`、`kCGSSessionOnConsoleKey=true`（同一输出顶层 `IOConsoleLocked=false`，两项状态并不一致）。这为上述前后台/渲染停滞提供了重要环境解释，但不能单独证明全部根因。需在用户解锁并真正显示窗口的桌面上重建、重新运行该隔离探针和视觉检查；不要尝试绕过锁屏。最新 `.app` 包含已撤回的临时前台实验代码，**不能作为当前源码构建的验收证据**；下次验证先按上述命令重新构建。原工作区仍有独立并行未提交修改，不能直接覆盖或把当前分支当作整合完成。

## 暂停及终局打法冻结补充（本轮）

- 发现 `setDoctrine` 只阻止演出期修改：暂停时仍可重填草稿、刷新预览，终局或非玩家规划阶段也可改变打法；设置中的下拉框同样未禁用暂停与终局。按 SPEC 5.2、11.3，现由控制器同时拒绝暂停、演出、终局及非玩家规划阶段的打法变更，界面使用相同状态禁用打法选择。显式重开仍是另一操作；自动对战未暂停时切换打法并重填草稿的既有行为保留。
- 先补控制器定向测试，修复前暂停、非规划阶段及终局三项均失败；修复后三项通过。测试覆盖暂停时 snapshot/草稿及 planner 调用不变、恢复后手动和自动模式均可按新打法重填，演出期和胜利终局命令不改变 snapshot。另扩展合成浏览器流程以检查暂停/恢复时设置控件和草稿状态。新浏览器测试定位器首次误匹配战场和远程两个设置区，后续精确 label 查询也未匹配，已调整测试定位器；这两次不视为产品行为失败或通过。
- 本轮 `npm run typecheck`、`npm run verify:mecha`（197/197；增强断言后另跑定向测试通过）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-native-gate.mjs`、`node scripts/verify-city-mecha-ux.mjs` 和 `git diff --check` 通过。浏览器重跑结果另记。所有这些检查均不是原生实际输入、目标硬件性能或真人可用性验收。
- 环境复查前台仍为 `loginwindow`；console user 的 `CGSSessionScreenIsLocked=true`，顶层 `IOConsoleLocked=false`，两种状态仍不一致。需解锁 Mac 后用当前源码重新构建隔离 `.app` 并检查可见画面，不能将锁屏状态下的探针停滞当成已定位的产品缺陷。原工作区 `feature/mecha` 有重叠的并行未提交修改，当前独立 worktree 尚未合并或覆盖它们。
- 修正测试定位器后，`node scripts/verify-city-mecha-battle-browser.mjs http://127.0.0.1:5189` 在合成数据、无头 Chromium / SwiftShader、1100×700 下通过：包括暂停时打法下拉禁用、恢复后启用且草稿保留；这是脚本合成操作，不代表实体输入或原生视图通过。随后停止本次启动的 Vite，再运行 `npm run build` 成功，仍有既有的大 chunk 警告。

## 资源生命周期自动化补充（本轮）

- 新增 `scripts/verify-city-mecha-lifecycle-browser.mjs`，只在 Vite 内存响应插桩，不修改生产代码或开放生产测试接口；使用固定种子的合成 City、无头 Chromium/SwiftShader、1100×700。两次进入与退出期间共观察 4 个场景实例：每个实例的 52 个被追踪的静态几何、材质和纹理都各发出一次 `dispose`；模型均标记已销毁，旧根对象离开场景，相关 4 个画布指针监听器和捕获阶段 Escape 监听器均清除。最终 `ModeLease` 不再 busy，帧钩子为空。
- 重开一局时，同一个有效场景及监听器保持可用，没有错误释放静态资源；3 个敌方顺序标记的纹理/材质和 1 个暂停中的演出播放器的几何/材质在关闭或退出后各释放一次。第二次进入获得新的有效场景；开启自动战斗后在 700 ms 定时器触发前退出，记录到定时器取消且未触发，等待超过 1 秒后旧控制器状态未推进。
- 测试编写过程中，最初误以为每次进入只创建一个场景，实测初始化有中间场景释放及新场景创建，现改为验证所有旧实例清理且只保留一个有效实例；另一次测试因展开的设置面板遮住提交按钮而等待，现由脚本先折叠面板再继续。两次中断均为测试假设或操作流程问题，不计为完整通过；修正后的完整运行通过。
- 同轮 `npm run typecheck`、`npm run verify:mecha`、`npm run verify:mecha-models`（31 项）、`node scripts/verify-city-mecha-ux.mjs`、`node scripts/verify-city-mecha-native-gate.mjs`、`git diff --check` 通过。监听器/`dispose` 事件及定时器探针只能证明被观测的调用和状态，不证明闭包已被垃圾回收、GPU 驱动已回收显存、所有异常路径、真实设备输入、原生 WebView 生命周期或用户验收。
- Mac 解锁后的当前源码隔离 `.app` 重建、原生可见画面/实体鼠标键盘触屏和性能验证、目标用户可用性测试、以及与原 `feature/mecha` 并行改动的安全整合仍未完成。无头合成通过不能替代 SPEC §11.3 的实机验收。

## 设置面板遮挡修复（进行中）

- 合成浏览器复现：英文 1100×700 展开「Battlefield settings and rules」时，提交按钮中心被设置说明文字覆盖，不能直接点击；这是产品布局缺陷，不再把先折叠面板作为验收通过。
- 当前实现根据面板与摘要、机甲卡片、当前行动及提交区域的相对位置限制设置滚动区高度，并在尺寸变化时重新测量；展开时设置标题保持可见，便于滚动后折叠。两块设置互斥展开。生命周期测试已扩展为记录此测量逻辑的 resize 监听器和 ResizeObserver 的退出清理，等待完整复验。
- 初版合成检查在无头 Chromium/SwiftShader 下跑过英文 1100×700、1440×900 和 390×844 的设置、提交、待机确认取消及远程 URL 输入命中；中文及更完整的目标取消、资源明细、攻击顺序检查尚在执行，不将中断运行计作完整矩阵通过。增强脚本早期直接寻找首回合 Assault 近战，但该位置没有合法近战目标，属于测试前提错误；已改成完成首回合并移动到有效位置后检查。
- 除上述有限视口和状态外，设置区域空间不足、其他缩放及动态状态仍须继续验证；原生窗口、实体输入、设备性能和用户验收均未完成。
- 加强后的英文 3 视口检查已通过：展开设置时可以选机甲、查看建筑资源及攻击顺序、提交/返回修改、输入远程 URL；完成首回合并移入有效位置后，三个视口均可进入及取消选目标。此轮为合成 fixture + 无头 Chromium，脚本将 `requestAnimationFrame` 限速以减少 SwiftShader 饱和，因此不构成性能证据。中文及候选结果确认/取消按钮遮挡复验尚待执行。
- 本轮 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-ux.mjs`、`node scripts/verify-city-mecha-native-gate.mjs` 均通过；原生 gate 仅为合成逻辑检查。系统仍同时报告 `CGSSessionScreenIsLocked=Yes`、`IOConsoleLocked=No`，因此尚不能完成当前源码的原生可视和实体输入验收。
- 完整增强脚本已在中英两种语言 × 1100×700、1440×900、390×844 全部通过；除了上述控件外，还在首回合结算及移动入攻击范围后检查了设置展开时目标试算的确认与取消按钮命中，并取消后断言草稿不变。命中检查使用中心点，且试算按钮允许其行动面板内部滚动，不能证明每个像素无遮挡或其他动态状态可用。测试脚本将动画帧限速，不能作为性能结论。
- 生命周期探针首次增强运行因 Vite 把清理函数展开成多行，测试插桩未找到字符串，立即退出；这是测试插桩失败，不是产品生命周期通过或失败，已修正插桩并重跑。
- 修正插桩后生命周期探针完整通过：两次进入/退出及重开期间，测量逻辑始终至多一个活动 `resize` 监听器，退出后为零，失效的 `ResizeObserver` 均执行断开；场景资源、帧钩子及自动定时器的合成检查也通过。探针只验证被记录的调用，不证明垃圾回收、GPU 驱动回收或原生 WebView 生命周期。
- 截图复核发现上一版虽可命中主要按钮，但折叠的「Remote mecha tactics」标题覆盖了已展开战场设置的说明文字；新增叠层命中断言在英文 1100×700 实测红测，命中对象为远程设置标题。现将展开的设置面板置于折叠入口之上，仍需重新跑完整矩阵和截图复验；上述旧矩阵通过不能覆盖此视觉问题。
- 修正叠层后，新增叠层断言和完整设置交互矩阵重新通过（中英 × 1100×700、1440×900、390×844，DPR 1，合成 seed `4196523069`，SwiftShader 与限速动画）；包括对重叠处的中心命中、提交/返回、资源和顺序、目标试算两按钮命中与取消不变草稿。已保存每种语言、视口的设置与候选结果截图至本机证据目录 `mecha-battle-ux-evidence/settings-layout/`，并复核英文 1100 和 390 的设置图；这些不能代表设备视觉或其他重叠点。展开内容以关闭设置为切换入口，当前不覆盖键盘访问和非目标缩放尺寸的所有叠层情况。
- 叠层修改后重跑 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-ux.mjs` 通过。
- 叠层修正后重跑未限速的合成浏览器流程 `verify-city-mecha-battle-browser.mjs` 及目标视口脚本 `verify-city-mecha-target-viewport.mjs` 均通过：前者覆盖待机风险、取消、提交、威胁和键盘激活等；后者中英三视口检查目标试算按钮无需额外滚动即可命中。仍不等于实体输入或原生验收。
- 进一步复核发现仅提高层级时，折叠入口仍保留可见/可聚焦状态，可能成为展开面板下方的隐藏键盘焦点；新增可见性断言在英文 1100×700 红测（远程入口仍可见）。现隐藏另一折叠入口，关闭当前面板后恢复，正在重跑中英三视口及程序化焦点检查；这仍不能替代实体键盘和原生 WebView 验收。
- 隐藏折叠入口后，完整设置矩阵再次通过：中英各三个视口都确认另一入口不可见且程序化 `focus()` 不会把焦点移到该入口；关闭后另一设置仍可打开，提交/取消、资源、目标及叠层检查通过。十二张截图已按当前版本重新生成，英文 390 设置图复核不再出现远程标题残影。这只覆盖所测路径和程序化焦点，`:has()` 在原生 WebView 的行为与实体键盘顺序仍待验证。
- 最后一次 CSS 修改后 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-ux.mjs` 与原生 gate 合成逻辑检查均通过；重跑完整浏览器流程及生产构建结果另记。
- 最终 CSS 修改后的 `verify-city-mecha-battle-browser.mjs` 合成流程通过；停止本轮 Vite 后执行 `npm run build` 成功，仍有超过 500 kB 的 chunk 警告。完整 A/B/C、原生窗口、目标硬件性能、真人任务及与并行 `feature/mecha` 改动整合仍未验收或完成。

### 设备像素比下的合成落点回归（2026-11-01）

- 扩展 `scripts/verify-city-mecha-map-focus.mjs`：以 `MECHA_DPR` 设置并核对 Chromium 的 `devicePixelRatio`；截图像素采样按截图尺寸换算，不把 CSS 坐标直接当作设备像素。Vite 内存插桩只记录原有落格回调，不修改生产源码。
- 除既有视野、叠层和一次实际移动外，在 390×844 暂停态独立投影 `(1,1)、(8,1)、(4,4)、(1,8)、(8,8)` 五个格子的中心，不以射线结果预筛；针对每格分别通过 Playwright 鼠标和模拟触摸发事件，断言实际回调的格子和事件类型，并确认草稿移动未变。截图包含展开地图与警告层关闭的对照，保存在本机 `mecha-battle-ux-evidence/dpr/`。
- 使用浏览器独立页内置三会话合成 fixture、种子 `4196523069`、无头 Chromium/SwiftShader；`MECHA_FAST=1` 的落点矩阵只覆盖竖屏 390×844，回合准备过程暂用 1100×700。DPR 1 和 DPR 2 的中英文测试均通过，共 40 次暂停态鼠标/模拟触摸落点断言，日志分别为 `/tmp/mecha-map-dpr1-20261101.log` 和 `/tmp/mecha-map-dpr2-20261101.log`。投影借助渲染场景和几何数据，因此证明有限，不等同每个像素的视觉定位；`deviceScaleFactor` 不是浏览器页面缩放或 macOS 系统缩放，不能作为原生、实体输入、全视口/相机角度或性能验收。

### 窄横屏布局与移动列表回归（2026-11-01，进行中）

- 在 733×467、DPR 1.5 的无头 Chromium 合成场景中，补充几何检查后依次发现：展开设置覆盖回合摘要、摘要覆盖战斗栏的查看战场/旋转按钮、目标试算面板覆盖摘要。初次修正将 601–1000px 摘要移至战斗栏下方，限制目标态摘要高度；601–831px 设置展开时让摘要与设置面板分栏。随后旧版交互矩阵在该尺寸中英文通过，截图在 `mecha-battle-ux-evidence/narrow/`；这不能覆盖之后新增的断言。
- 新增每个视口的展开移动列表与摘要不重叠检查后，英文 733×467 红测：行动面板顶端约 y=200，摘要底端约 y=251，重叠约 51 CSS 像素；原始日志 `/tmp/mecha-settings-boundaries-20261101.log`。这是产品布局失败，不是测试环境问题。现为展开移动列表的行动面板增加滚动上限，并按可用高度限制摘要；新增检查资源入口与移动选择控件是否仍可命中。最终复测状态见下文。
- 设备屏幕只读状态仍为 `CGSSessionScreenIsLocked=Yes`、`IOConsoleLocked=No`，两者不一致；本轮未绕过锁屏，未将不可见窗口当作产品结论。实体输入、目标硬件性能、5 位目标用户和当前源码的原生视觉矩阵仍待用户和目标设备配合。远程 relay 元数据清理风险和未整合并行代码的限制同样仍然存在。
- 图片复核另发现 601×700 英文折叠的“Battlefield settings and rules”入口压在回合摘要右上方。加入折叠入口与摘要的几何断言后实际红测：入口左边 x≈390，摘要右边 x=432，交叠约 42 CSS 像素，日志 `/tmp/mecha-settings-collapsed-red-20261101.log`。已为 601–831px 的折叠态摘要预留入口空间；设置展开时继续使用更窄的分栏宽度。正在重跑带新断言的完整矩阵；中断的旧矩阵不作为通过证据。
- 额外视觉风险：601×700 英文移动列表截图中，底部机甲卡片将 `Not chosen` 截为 `Not ch...`；`.mecha-card-action` 仍使用省略号，其他较长的行动/目标文本也可能无法完整看到。本轮没有把这视作通过或修改卡片布局；须评估不遮挡行动面板的可见呈现，并覆盖多语言、已规划行动和触屏后再关闭该风险。
- 调整后，最新版设置脚本在中英文 × 601×700、831×700、832×700、1000×700、733×467、DPR 1.5 全部通过；含折叠入口/展开面板、摘要和战斗栏的几何检查，展开移动列表和目标试算时的摘要、建筑资源入口与操作控件命中，提交/返回与取消保留草稿。截图在 `mecha-battle-ux-evidence/settings-boundaries-current/`；已复核英文 601×700 移动列表截图，设置入口与摘要分离。日志 `/tmp/mecha-settings-boundaries-current-20261101.log`。用 30 会话请求的合成 City、固定 seed `4196523069`、无头 Chromium/SwiftShader、限速动画和程序化输入；并非原生、实际缩放、物理输入或性能结论。
- 最新设置交互脚本也在 SPEC 视口 1100×700、1440×900、390×844，DPR 1 的中英文通过，包括折叠入口几何、新增移动列表资源与选择控件检查；日志 `/tmp/mecha-settings-default-current-20261101.log`，截图 `mecha-battle-ux-evidence/settings-layout-current/`。它覆盖特定可复现路径，不代表 11.3 全部视觉状态或真实操作。
- 最新 CSS 下 `verify-city-mecha-target-viewport.mjs` 通过：中英三个 SPEC 视口的目标结果按钮无需额外滚动即可命中，日志 `/tmp/mecha-target-current-20261101.log`；仍是合成浏览器交互。
- 最新布局下 `verify-city-mecha-battle-browser.mjs` 的合成待机风险、取消/提交、顺序和威胁焦点、键盘程序化激活、目标预览、暂停/恢复/退出流程通过，日志 `/tmp/mecha-battle-current-20261101.log`。停止本轮 Vite 后 `npm run build` 成功，仍有大于 500 kB chunk 警告，日志 `/tmp/mecha-build-current-20261101.log`。最后执行 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）、`node scripts/verify-city-mecha-ux.mjs` 均通过，日志 `/tmp/mecha-tests-current-20261101.log`；`git diff --check` 通过。构建、合成和单测均不替代 Tauri 实机或参与者验收。

### 机甲卡片文字与动态避让回归（2026-11-01，进行中）

- 上一节记录的卡片截断是当时的历史观察，现已修改而非继续保持原状：英文 601×700 中，真实选择并确认 `Melee Boss` 后，行动文本与 `Not chosen` 的完整显示检查先红测，日志 `/tmp/mecha-card-red-20261101.log`。卡片状态与行动分行，行动允许换行而不省略；行动面板与窄屏提交面板根据实际卡片高度避让，行动面板在可用高度不足时滚动。设置布局的现有 ResizeObserver 也参与更新几何，需检查退出时的监听器和观察器清理。
- 修改后旧版设置脚本的中英文 × 601×700、733×467、390×844，DPR 1.5 通过真实目标确认及卡片文本、面板避让，日志 `/tmp/mecha-card-wrap-20261101.log`；此版本尚未加入后续压力断言。最新版脚本先以英文 733×467 和 390×844、DPR 1.5 通过：除了真实目标确认，还用仅修改 DOM 的合成长行动文本 `Melee West raider East raider` 和一条假受击行 `Hit 10` 检查卡片变高后的避让、恢复及摘要与行动/提交面板不重叠，日志 `/tmp/mecha-card-stress-20261101.log`。假文本与假受击只验证布局应力，不代表真实多目标或受击规则已覆盖。截图分别在证据目录 `card-wrap/`、`card-stress/`；人工复核了英文 733×467 与 390×844 的已规划截图和 733×467 压力截图。
- 测试使用固定 seed `4196523069` 的合成 City、无头 Chromium/SwiftShader、限速动画与程序化输入；DPR 不是浏览器或系统缩放。真实多台受击、全部行动与视口组合、触屏实体输入、原生 WebView、目标硬件性能及用户验收仍未由这些测试证明。最新版完整视口与生命周期回归另记。
- 最新设置与卡片脚本在中英文 × 1100×700、1440×900、390×844、601×700、733×467、831×700、832×700、1000×700、DPR 1.5 通过；覆盖初始草稿、实际确认近战 Boss 后的卡片、合成长文本/假受击高度变化及恢复、设置/目标候选等路径的几何与命中检查。完整日志 `/tmp/mecha-card-final-20261101.log`，截图在证据目录 `card-final/`。这是同一合成场景的程序化检查，并非对全部玩法状态或实体触屏的覆盖。
- 卡片布局改动后，串行重跑目标结果视口检查（中英三个 SPEC 视口）、战斗流程检查和生命周期检查均通过，日志分别为 `/tmp/mecha-card-recheck-target-viewport-20261101.log`、`/tmp/mecha-card-recheck-battle-browser-20261101.log`、`/tmp/mecha-card-recheck-lifecycle-browser-20261101.log`。生命周期脚本通过 Vite 内存插桩验证两次进出、被跟踪的场景资源与设置 ResizeObserver/resize 监听器清理；不证明原生 WebView、垃圾回收或 GPU 驱动释放。
- `MECHA_FAST=1` 的地图焦点回归在中英 390×844、DPR 1 通过重叠格拾取、警告像素、模拟触摸移动和暂停下各 10 次指针/格子断言，日志 `/tmp/mecha-card-recheck-map-focus-20261101.log`。这不等同实体触屏，也不覆盖所有视口和相机角度。
- 远程生命周期脚本首次超时（`/tmp/mecha-card-recheck-remote-lifecycle-browser-20261101.log`），原因是测试仍尝试在远程设置展开时直接打开被设计为隐藏的战场设置入口；更新脚本为先关闭当前设置再切换，并保留自动对战时不能启动远程的断言。更新后英文、中文的启动/锁定/恢复流程和英文的视角丢失恢复分别通过，日志 `/tmp/mecha-card-remote-recheck--en-20261101.log`、`/tmp/mecha-card-remote-recheck--zh-20261101.log`、`/tmp/mecha-card-remote-recheck--view-fail-20261101.log`。此处注入模拟宿主，不连接 relay，不能证明真实远程或元数据保留符合政策。
- 停止本轮 Vite 后，`npm run typecheck`、`npm run verify:mecha`（197/197；复跑日志 `/tmp/mecha-card-unit-20261101.log`）、`npm run verify:mecha-models`（31/31）、`npm run build`、`node scripts/verify-city-mecha-ux.mjs` 和 `git diff --check` 均通过；构建仍报告大于 500 kB chunk。此次改动后的当前源码尚未在原生隔离包上复验；只读系统状态仍显示 `IOConsoleLocked=No`、控制台会话 `CGSSessionScreenIsLocked=Yes`，未绕过锁屏。

### 多威胁重叠与模拟触屏目标选择（2026-11-01，进行中）

- 在 `scripts/verify-city-mecha-multithreat.mjs` 中使用 Vite 响应的内存插桩构造真实控制器 fixture：Boss、西/东小怪均威胁 `(5,2)`，该格同时是 Support 可维修的 Assault 所在格。使用合成 City、seed `4196523069`、无头 Chromium/SwiftShader、DPR 1 和程序化输入，不读取真实会话数据。
- 最新脚本中英文均通过：在 1100×700 和 390×844 以 Playwright `touchscreen.tap` 进入战场、点中该格、预览并取消；断言预览和取消均不改变草稿。在 390×844 再次触屏预览并明确确认，断言草稿为 Support 维修 Assault。触点以投影坐标及射线拾取核对，按钮先检查视口内与中心命中；这不是对其他坐标或所有对局的证明。
- 确认后检查真实控制器产生的维修行动文本、实际受击标识、机甲选择按钮命中，以及卡片不被行动和提交面板覆盖。人工查看了中英文 390×844 确认截图：维修文字及受击行可见；英文行动面板处于滚动位置，顶部标题未完整显示。中英文最终日志 `/tmp/mecha-touch-portrait-final-20261101.log`，截图位于证据目录 `touch-target-portrait-final/`。此前不含确认后卡片断言的版本也通过，日志 `/tmp/mecha-touch-portrait-20261101.log`；不以旧版结果替代最新版断言。
- 这是合成浏览器与模拟触屏覆盖，不等同物理鼠标/键盘/触屏、原生 WebView、全部视觉矩阵或目标用户验收。最新代码的原生包尚未复验；本轮只读系统状态仍显示 `IOConsoleLocked=No`，控制台会话 `CGSSessionScreenIsLocked=Yes`，未绕过锁屏。目标硬件性能和至少 5 名目标用户测试仍缺。原工作区并发修改未整合，远程 relay 元数据保留风险仍是远程发布阻塞，不能据此判定 SPEC 完成或具备发布条件。

### 目标结果关闭后的当前机甲标题（2026-11-01，进行中）

- 上一节观察到的英文窄屏标题截断已复现并修复，不再仅作为历史截图问题：增加检查后，修复前英文 390×844 在取消目标结果后失败，行动面板仍滚动 21px，标题上部在面板外；红测日志 `/tmp/mecha-heading-red-20261101.log`。首次尝试编辑脚本时因工作目录错误出现 `FileNotFoundError`，没有改动文件；随后从仓库根目录正确编辑并执行红测。
- 修复只在已固定的选择结果关闭后将对应行动面板滚回顶部，让当前机甲和行动重新出现；结果打开时仍滚到预览及确认操作，不对普通悬停强制滚动。中英合成多威胁触屏脚本在 1100×700、390×844 验证预览和取消后标题，在 390×844 额外验证确认后标题与维修草稿；均通过，日志 `/tmp/mecha-heading-green-20261101.log`。人工复核中英文确认截图，标题与维修卡片可见；英文较长说明位于可滚动面板底部，仍需滚动阅读。截图位于证据目录 `heading-restored/`。
- 目标列表浏览器回归通过中英文 × 1100×700、1440×900、390×844：包括结果确认/取消按钮可见且命中、已选结果在 1100×700 与 390×844 间缩放后仍可操作，以及取消后标题可见，日志 `/tmp/mecha-heading-target-20261101.log`。另用中英文 × 733×467、390×844、DPR 1.5 检查设置面板、目标选择/取消及卡片布局，通过，日志 `/tmp/mecha-heading-layout-20261101.log`；该脚本限速动画，DPR 不等于系统或浏览器缩放。
- 当前修改后 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）及 `node scripts/verify-city-mecha-ux.mjs` 通过，日志 `/tmp/mecha-heading-checks-20261101.log`；停止专用 Vite 后 `npm run build` 通过，日志 `/tmp/mecha-heading-build-20261101.log`，仍有大于 500 kB 的 chunk 警告。上述均为合成浏览器或自动化检查，不代替原生包、实体输入、目标硬件性能或参与者验收。


### 隔离原生入口的中英文准备（2026-11-01，进行中）

- 修复前的合成脚本红测分别显示英文 `City settings` 不能打开设置（`/tmp/mecha-probe-en-host-red-20261101.log`），以及英文 `Mecha tactics` 不能进入战斗（`/tmp/mecha-probe-en-red-20261101.log`）。这是隔离测试入口的标签匹配缺陷，不是产品 UI 或原生视觉的结论。
- 隔离探针的正式插件入口现同时识别中英设置、演示标识及机甲入口；仅配合 `--plugin-formal-mecha-interactive` 使用 `--mecha-fixture-en` 时，才在 incognito 探针宿主启动前请求英文。报告记录的是请求语言而非实际语言或测试通过；真实 authority 和远程数据边界不变。原中文自动行动流程未因此成为英文自动行动测试。
- `node scripts/verify-city-mecha-native-gate.mjs` 中英文合成脚本通过：设置/战斗入口、时钟推进、停滞、零画布、缺失时钟及缺失 fixture、种子、演示标识的拒绝分支，日志 `/tmp/mecha-probe-en-green-20261101.log`。这是 JS VM 的模拟 DOM，不证明 Tauri 启动、实际英文标签、原生渲染或人工验收。
- 上一源码的隔离 `.app` 已构建成功，日志 `/tmp/mecha-heading-native-build-20261101.log`；其后修改了隔离探针源码，故该包不代表当前代码，正在重建。当前控制台仍报告锁屏，未启动该包或绕过锁屏；真实可见窗口、物理输入与参与者验收仍未完成。
- 新增更早的英文启动链检查又发现独立问题：探针观察器只认 `3 会话`，而 City 英文摘要为 `3 sessions`，会在战斗入口之前超时；合成红测 `/tmp/mecha-probe-observer-en-red-20261101.log`。当前正在构建的包也不含该问题的修复，不能用于英文原生验收；待该构建结束后再修改观察器并重建。
- 上一轮（不含观察器修复）的隔离包构建成功，日志 `/tmp/mecha-bilingual-native-build-20261101.log`，未启动；随后观察器补充中英文摘要识别，保留 fixture 标识检查。中英文合成观察器测试及先前门禁分支现通过，日志 `/tmp/mecha-probe-observer-en-green-20261101.log`；`node scripts/verify-city-mecha-ux.mjs` 与 `git diff --check` 也通过。再次构建当前源码的隔离包，待构建完成后仍须在解锁桌面上人工核验，不将模拟测试记为原生通过。
- 当前源码隔离 `.app` 重建成功：`/tmp/mecha-observer-native-build-20261101.log`，构建期间仍有大 chunk 警告及 npm 的 1 项高危依赖审计提示；未运行自动修复或认定其影响范围。2026-11-01 再次只读检查控制台会话仍为锁屏（`CGSSessionScreenIsLocked=true`，同时 `IOConsoleLocked=false`）；因此未打开该包，构建成功不代表可见性、实际英文入口或物理交互已通过。

### Vite 依赖安全更新及回归（2026-11-01，进行中）

- City 的锁文件在既有 `^6.1.0` 范围内将 Vite 从 6.4.3 更新至 6.4.5，`package.json` 未改。升级针对当时 `npm audit` 报告的 Vite advisories；不据此断言旧生产包一定可被利用，影响须按部署与 advisory 判断。原工作区的并发修改未合入。
- 在此独立 worktree 执行 `npm ci --no-audit --no-fund` 并确认安装 Vite 6.4.5；随后 `npm audit --json` 退出 0、报告 0 项漏洞（仅代表该 City 依赖树和当时审计数据）。日志 `/tmp/mecha-vite645-ci-20261101.log`、`/tmp/mecha-vite645-audit-confirm-20261101.json`；旧审计 `/tmp/mecha-ui-npm-audit.json` 保留。
- 升级后 `npm run typecheck`、`npm run verify:mecha`（197/197）、`npm run verify:mecha-models`（31/31）、`npm run build`、`node scripts/verify-city-mecha-ux.mjs`、`node scripts/verify-city-mecha-native-gate.mjs` 和 `git diff --check` 通过；原生 gate 是合成逻辑检查，构建仍提示大 chunk。各命令日志以 `/tmp/mecha-vite645-` 开头。
- 之前的 `/tmp/mecha-observer-native-build-20261101.log` 对应旧锁文件，不能作为当前依赖版本的隔离包证据。2026-11-01 只读检查 `CGSSessionScreenIsLocked=true`（同时 `IOConsoleLocked=false`）；未启动包或绕过锁屏。可见原生画面、实体输入、目标硬件性能和目标用户验收仍未完成。
- 升级后使用本 worktree 独立的 Vite 6.4.5（127.0.0.1:5178）串行通过 `verify-city-mecha-battle-browser.mjs`、`verify-city-mecha-settings-layout-browser.mjs`、`verify-city-mecha-multithreat.mjs` 和 `verify-city-mecha-target-viewport.mjs`；分别覆盖合成战斗交互、设置布局与目标按钮、多威胁和模拟触屏、目标列表在中英文三个视口下的选择/取消。脚本日志分别为 `/tmp/mecha-vite645-verify-city-mecha-{battle-browser,settings-layout-browser,multithreat,target-viewport}-20261101.log`。浏览器是无头 Chromium/SwiftShader；设置布局检查还限速动画，均不证明原生、实体输入、设备性能或目标用户体验。测试结束只停止了本轮启动的 Vite。
- 升级后按仓库规定重建隔离 `.app` 成功，日志 `/tmp/mecha-vite645-native-build-20261101.log`。构建中的 City 安装审计报告 0 项漏洞，City 构建使用 Vite 6.4.5；桌面 UI 构建仍使用另一依赖树的 Vite 6.4.3，此次没有评估其审计状态。仍有大 chunk 和 `mp4-muxer` 弃用提示。

### 当前依赖的中英文原生开场检查（2026-11-01）

- 构建完成后控制台状态改变：`IOConsoleLocked=false`，控制台用户的 `CGSSessionScreenIsLocked` 键缺失、登录已完成，前台已不再是登录窗口。随后仅通过 `open -n` 启动本 worktree 的隔离 `.app`，未绕过锁屏；每次确认报告及窗口属于本轮进程，完成后仅终止该探针进程。
- 中文及英文请求分别返回 `needs_visual_check / manual_fixture_needs_visual_check`，报告显示注册 City 插件、合成 fixture、保存 seed `4196523069`、渲染时钟推进和非零画布。报告本身不是通过结论，`requested_fixture_locale` 与 `seed_saved` 也分别只证明语言请求和保存值，不独立证明实际采用的种子。
- 抓取并复核**隔离探针窗口**：两张开场图均可见棋盘、机甲及 HUD，英文图的文字实际为英文，中文图为中文。该观察仅针对普通开场态，并非完整视觉矩阵或实体输入测试。窗口尺寸由系统报告为 1100×760 点；截图为 2424×1744 像素、包含边缘和阴影，不等同 SPEC 的 1100×700 内容视口。两张截图与报告保存在本机 `mecha-battle-ux-evidence/vite645-native-opening/`，不随 Git 分发。
- 两次都是合成数据的隔离 feature；未执行完整鼠标、键盘、触屏路径或真实用户任务，也未验证其余视口、预览错误、结算状态、设备性能和生产包。此前锁屏导致的停滞报告保留，不因此归因到产品或宣称全部原生验收通过。
- 同一当前包再经 `open -n --args --plugin-formal-mecha-probe` 执行一次正式注册插件的自动流程：报告 `passed / probe_complete`，合成三会话 fixture 显式全待机、预计损楼 3、取消后再确认、结算 29/32、退出并关闭插件；报告保存在上述目录的 `auto-report.json`。这是程序化 DOM 流程，插件关闭不证明 GPU/监听器完整回收，也不证明实体输入、用户验收或所有战况；开场图与该自动流程不能相互扩大为完整验收。

### 风险摘要的键盘滚动与当前构建（2026-11-01，进行中）

- 原生开场截图中，风险摘要可能溢出且滚动提示不明显；对摘要添加独立 Tab 焦点、可见键盘焦点样式、关联的中英文屏幕阅读说明，以及滚动条样式。系统可自动隐藏 overlay 滚动条，不能断言它始终可见。
- 红测 `/tmp/mecha-summary-keyboard-red-20261101.log` 发现原 UI 没有显式 `tabindex`；这不证明所有浏览器均无法滚动。添加焦点后，默认方向键滚动测试出现间歇性失败（`/tmp/mecha-summary-keyboard-green-20261101.log`、`/tmp/mecha-summary-keyboard-green2-20261101.log`、`/tmp/mecha-summary-keyboard-poll-20261101.log`）；诊断日志 `/tmp/mecha-summary-keyboard-diagnostic-20261101.log` 中中文 1440×900 摘要具有溢出且已获得焦点，目标接收到未预先取消的 ArrowDown，但 15 秒内未观察到滚动。尚不能确定所有环境的根因，也不能将此视作原生 WebView 的复现。
- 现对摘要自身获得焦点且确有溢出时显式处理方向键、Page Up/Down 和 Home/End；子控件事件及带修饰键的输入不被该处理器拦截。脚本 `/tmp/mecha-summary-keyboard-final-20261101.log` 使用合成 fixture、无头 Chromium/SwiftShader 和程序化键盘，中英文 × 1100×700、1440×900、390×844 均验证焦点、说明、溢出滚动、方向/分页/首尾键及子按钮的方向键不被拦截和 Enter 激活。动画被测试脚本限速，不是物理键盘、屏幕阅读器、原生 WebView 或性能验收。
- 当前源码 `npm run typecheck` 通过；`verify:mecha` 197/197、`verify:mecha-models` 31/31、City build、`verify-city-mecha-ux.mjs`、合成原生门禁脚本通过，日志分别为 `/tmp/mecha-summary-handler-typecheck-20261101.log`、`/tmp/mecha-summary-handler-unit-20261101.log`、`/tmp/mecha-summary-handler-models-20261101.log`、`/tmp/mecha-summary-handler-build-20261101.log`、`/tmp/mecha-summary-handler-ux-20261101.log`、`/tmp/mecha-summary-handler-gate-20261101.log`。City 构建仍有大 chunk 警告。
- 上节原生截图及自动流程来自摘要改动之前的包，**不能证明当前源码的原生体验**。此轮复查发现 `IOConsoleLocked=false`，但控制台会话 `CGSSessionScreenIsLocked=true`，因此不启动或截图原生探针，不绕过锁屏。实体输入、屏幕阅读器、视口视觉矩阵、目标设备性能和至少 5 名目标用户的任务测试均未完成；这些限制不由合成结果替代。
- 基于上述摘要修改的新隔离 `.app` 构建成功（日志 `/tmp/mecha-summary-handler-native-build-20261101.log`，使用 `plugin-isolation-probe`，非生产包），只证明打包成功，不证明启动、画面或交互验收。
- 中英文 × 1100×700、1440×900、390×844 的响应式设置、目标结果与卡片布局合成回归通过（`/tmp/mecha-summary-handler-layout-20261101.log`）；测试限速动画并使用程序化输入，不代表原生视觉或性能通过。
- 英文 1100×700 的合成战斗浏览器回归通过（`/tmp/mecha-summary-handler-battle-20261101.log`）：包括待机风险确认/取消/提交、顺序与威胁联动、键盘激活移动和目标确认、暂停恢复及退出。它不替代物理输入或原生验收。专用 Vite 测试服务已停止。

### 结算顺序单层滚动与合并预检（2026-11-01，实机待验）

- 对上一节的风险摘要继续检查：展开结算顺序后，中文 1100×700 合成场景中内层 `.mecha-order` 的内容高 211px、容器高 160px，形成第二个独立滚动区；之前仅验证摘要的方向键，不能据此证明内层文字可完整阅读。新增断言在旧样式下失败，红测 `/tmp/mecha-order-scroll-red-20261101.log`。该测试不证明所有真实局面或原生 WebView 都受影响。
- 移除结算顺序独立的高度和滚动限制，让内容由摘要统一滚动；摘要顶部增加中英文可见提示“内容较多时可滚动”，不依赖系统滚动条是否自动隐藏。无障碍文字仍提示摘要焦点使用方向键，子按钮保留原生按键行为。合成截图目录 `mecha-battle-ux-evidence/summary-scroll-final-20261101/` 保存本机中英文三视口图；人工看过中文 390×844，提示在摘要顶部可见，顺序展开后摘要仍需滚动。实际读屏、原生显示及实体输入尚未验收。
- 当前源码 `typecheck`、规则测试 197/197、模型测试 31/31、City 构建、UX 检查和合成原生门禁通过，日志 `/tmp/mecha-order-scroll-{typecheck,unit,models,build,ux,gate}-20261101.log`；构建仍有大 chunk 警告。上述构建之后将提示字号从 10px 改成 11px，因此构建结果不代表这项样式更改后的完整原生包；后续需以最新重建和测试结果为准。
- 对原 `feature/mecha` 未提交改动仅做只读、临时副本三方预检，基线 `c4b5c224`：当时 5 个重叠文件中，`CityMechaWorld.tsx` 有 2 个文本冲突、`MechaBoard.tsx` 有 6 个；其余 3 个文件在该快照无文本冲突也不等于语义或测试通过。冲突涉及 Assault 加载/地形安全、候选悬停、远程锁与清理等，不能简单选择任一侧。原文件未修改；临时副本及快照哈希在 `/tmp/mecha-integration-audit.HI4FMQ/`。原工作区可能继续变化，最终整合时必须重新取快照、解决并复测，不能直接套用此结果。
- 最新 11px 提示样式下，合成键盘脚本中英文 × 1100×700、1440×900、390×844 均通过：确认提示在摘要初始视区内、展开顺序不再存在独立截断，以及使用摘要分页键能露出顺序末尾说明；亦复测方向/分页/首尾键及子按钮。日志 `/tmp/mecha-order-scroll-final2-20261101.log`。截图中英文 390×844 已人工查看，未证明原生或所有状态。
- 最新隔离 `.app` 重建成功，日志 `/tmp/mecha-order-scroll-native-build-20261101.log`，有大 chunk 警告；构建完成后只读检查 `CGSSessionScreenIsLocked=true`，故未启动探针、不绕过锁屏。打包成功不构成原生画面或交互验收。

- 最新 11px 提示下完整合成响应式设置回归退出码 0（`/tmp/mecha-order-scroll-layout-20261101.log`）：中英各 1100×700、1440×900、390×844，覆盖设置、目标取消、候选结果按钮及卡片布局；动画经测试脚本限速，不能替代原生视觉或实体输入。
- 同一版本英文 1100×700 合成战斗回归退出码 0（`/tmp/mecha-order-scroll-battle-20261101.log`），覆盖待机风险确认/取消/提交、顺序与威胁焦点、移动及目标确认的程序化键盘激活、暂停恢复和退出；不等同实体键盘或原生验收。测试专用 Vite 服务已停止。
- 回归后再次只读检查：`IOConsoleLocked=false`，但当前登录的控制台会话 `CGSSessionScreenIsLocked=true`。未启动或截图最新隔离包，也未绕过锁屏；最新源码的原生视觉矩阵、实体鼠标/键盘/触屏、目标硬件 20 次性能测试和至少 5 人的目标用户测试仍缺。

### 集成前 v1.4 规则保护（2026-11-01）

- 原 `feature/mecha` 当前未提交的 Assault 地形工作不只是表现层：`MechaBoard.tsx` 在 `useConnectedAssault` 路径给场地加入地形采样，`connectedAssaultMode.ts` 在非开发构建默认启用；`board.ts` 据此禁止突击移动，`combat.ts` 将被推至采样禁入处视为撞墙并扣血，规则标识仍为 `mecha-v1.4`。这是与本 SPEC §2.2 的“不改变移动与伤害规则”存在冲突的并发工作，不应通过解决文本冲突时静默带入本 UX 切片。
- 只读合成探针以同一平地局面人为标记一个禁入格（非真实城市地形采样）：原工作区样本中本地 `stepCost=null`、推挤失败且扣 2 HP；移除该标记后为 `stepCost=2`、推挤成功且不扣血。`remoteArenaFromSite` 和 `remoteStateFromSite` 的投影均未包含该采样标记，投影后的同一计算得到后者结果，但局面和 arena 均标称 `mecha-v1.4`。输出 `/tmp/mecha-integration-rules-probe-20261101.log`；只证明上述局部转换与规则函数行为，不证明真实远程网络对局已经复现、协议合法性或全部差异。探针前后相关原文件哈希一致，原工作区未修改；并发工作后续仍可能变化。
- 在本独立 worktree 的 `scripts/verify-mecha-tactics.ts` 新增规则保护：以合成的禁入格和禁入边测试 v1.4 的移动、推挤及投影不被该标记暗中改变。将该测试临时指向原工作区时，禁入格断言按预期红测 `null !== 2`（`/tmp/mecha-v14-merge-guard-red-final-20261101.log`，在首个断言失败，不能据此声称后续断言已运行）；本 worktree 定向测试通过，完整 `verify:mecha` 为 **198/198**、`typecheck` 通过（日志 `/tmp/mecha-v14-guard-{green-final,suite-final,typecheck-final}-20261101.log`）。该保护并不决定或修改另一项并发需求。
- 集成默认应保持本 SPEC 的 v1.4 规则并保留另一侧的素材与表现改动；如产品决定采用新的地形禁入/撞墙规则，应单独评审规则版本、远程协议/状态投影、预览与结算一致性，并重新测试。不要为让合并通过而删除断言或覆盖任一侧；最终仍须基于当时最新快照解决文本与语义冲突。

### 预览由成功切到异常再恢复（2026-11-01）

- 新增 `scripts/verify-city-mecha-preview-recovery-browser.mjs`：以当前独立 worktree 的 Vite 模块为被测对象，在浏览器响应中注入可切换的**显示试算**异常，不修改产品源码，也不拦截权威校验。以真实草稿/doctrine 变更使缓存失效，不通过刷新页面伪造恢复。合成 City 固定 seed、Chromium headless、1100×700、DPR 1、程序化交互，中英文退出码均为 0（`/tmp/mecha-preview-and-candidate-recovery-20261101.log`）。
- 总览路径验证成功预测 → 修改打法触发异常 → 再次修改打法恢复：异常时移除建筑预测明细、预测威胁及敌方结算次序，且不显示受击徽记；显示当前建筑值，并标注风险未知及“当前敌意不是草稿预测”；恢复后预测重新出现、异常提示消失。此回归没有核验画布中的敌意图形。
- 候选路径使用已知的第二回合及合法移动：先选中目标并确认试算结果存在，再通过撤回/重做移动使草稿版本失效并注入异常，验证旧候选被清除、异常结果无伤害/目标 HP 等旧数值且未提交行动；关闭异常、再次改变草稿后恢复同一目标结果。该测试覆盖特定同步异常与两次草稿版本变化，不证明任意故障、异步竞态或实体输入。
- 测试前只读检查得到 `IOConsoleLocked=false`，但登录控制台 `CGSSessionScreenIsLocked=true`；未启动隔离包、未绕过锁屏。以上合成浏览器回归不能替代当前源码的原生视觉矩阵、实体设备输入、目标硬件性能和目标用户研究。测试专用 Vite 已停止。

### 不可用行动原因（2026-11-01，实机待验）

- 对照 SPEC 8.2，原本只显示合法行动，缺少冷却或当前落点无目标的解释。控制器基于同一 `legalActions` 与所有机甲草稿移动落点，派生当前机甲不可用的能力及冷却/无目标原因；不添加可执行按钮、不改变行动规则。冷却优先说明“本回合不可用”，远程无目标只说明可能超距或被阻挡，不猜测确切原因。面板支持中英文折叠说明；非鼠标用户可用原生 `summary` 的 Enter/Space 展开。
- 新增两条控制器测试，覆盖三机技能冷却、各类无目标、草稿落点变化后可用状态更新、可用与不可用列表互斥及状态不变；旧实现红测 `/tmp/mecha-action-unavailable-red-20261101.log`；完整 `npm run verify:mecha` 200/200，日志 `/tmp/mecha-unavailable-verify-20261101.log`。
- 新增 `scripts/verify-city-mecha-unavailable-actions-browser.mjs`：使用合成 City、固定 seed 4196523069、Chromium headless/SwiftShader 和程序化输入，**仅在浏览器响应中注入 Assault 初始冷却**；中英文 × 1100×700、1440×900、390×844、DPR 1 均通过冷却/无相邻目标文字、不可点击、Enter/Space 展开/关闭、展开时与摘要及提交区不重叠、首回合结束再移动入范围后原因消失的检查，日志 `/tmp/mecha-unavailable-actions-browser-20261101.log`。人工查看中英文 390×844 截图，说明可读且被测面板分离；截图在 `mecha-battle-ux-evidence/unavailable-actions-20261101/`。此测试覆盖指定路径，不证明全部技能、画布或真实输入。
- 最新源码未通过原生验收：本次只读检查得到 `IOConsoleLocked=false` 但 `CGSSessionScreenIsLocked=true`，未启动隔离包或绕过锁屏。目标硬件 20 次测量、物理鼠标/键盘/触屏和至少 5 位目标用户测试仍未完成；并行分支未集成和远程 relay 元数据风险亦仍存在。合成浏览器与单测不替代 SPEC 11.3 的这些验收。
- 对新增说明后的当前源码，设置与目标选择响应式回归通过：中英文 × 三个 SPEC 视口，包含设置、资源、顺序、目标确认与取消等程序化交互；日志 `/tmp/mecha-unavailable-settings-regression-20261101.log`。`npm run typecheck`、`npm run verify:mecha-models`（31/31）、`node --check scripts/verify-city-mecha-unavailable-actions-browser.mjs`、`node scripts/verify-city-mecha-ux.mjs`、`git diff --check` 通过；这些均不代表原生或物理设备通过。
- 最新源码下英文 1100×700 合成战斗浏览器回归通过：待机风险确认、撤销与提交、顺序/威胁焦点、目标预览与确认、暂停/恢复/退出，日志 `/tmp/mecha-unavailable-battle-regression-20261101.log`。停止本任务专用 Vite 后，`npm run build` 成功，仍有大于 500 kB chunk 的警告，日志 `/tmp/mecha-unavailable-build-20261101.log`。

### 链式推挤的候选预览归因（2026-11-01）

- 在 `scripts/verify-mecha-controller.ts` 增加两个控制器回归，均使用确定性站桩 Boss 和现有 v1.4 规则，不修改产品逻辑。第一例为 Assault 与 Support 在同一整包内先后成功推动多格 Boss：分别核对单次伤害 2/1、位置 `(4,4)→(5,4)` 与 `(5,4)→(6,4)`；两次候选都显示整包最终 HP 37，而非将另一台的效果归因给当前行动。第二例验证 Assault 推走 Boss 后 Support 近战落空，候选报告 `not_adjacent`、0 伤害和无自身推挤，且不会播出 Support 攻击提示。
- 两例均经控制器的目标预览、确认草稿和提交路径，核对预览日志与正式结算日志一致；第一例额外比较玩家行动结束快照。验证临时候选不改草稿，第一例还核对不改对局及草稿版本，确认目标只更改相应草稿。测试没有发现需修改规则的缺陷，也不证明所有复杂连锁局面或视觉呈现。
- `npm run verify:mecha` 202/202，通过日志 `/tmp/mecha-chain-final-verify-20261101.log`；`npm run typecheck` 通过，日志 `/tmp/mecha-chain-final-typecheck-20261101.log`。只读检查依然显示 `CGSSessionScreenIsLocked=Yes`、`IOConsoleLocked=No`，未启动原生包或绕过锁屏。当前源码的原生视觉矩阵、物理输入、目标硬件性能及至少 5 名目标用户测试仍未完成；并行分支语义冲突与远程 relay 发布风险亦仍待处理。
- 按仓库规定构建当前产品源码的隔离 `.app` 成功（含不可用行动说明，日志 `/tmp/mecha-chain-native-build-20261101.log`；构建仍提示 JS chunk 大于 500 kB）。路径为 `apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent Isolation Probe.app`，其 `Contents/MacOS/agent-vitals-menubar` SHA-256 为 `6b95c96f3c1454f134957affafc4ca75027407fb49080640e4f894a27cfca971`。该校验和仅标识可执行文件，不单独证明包内所有资源；后续若产品源码或依赖变化需重新构建。构建后复查控制台会话仍锁屏，因此没有运行该包，构建成功不等于原生运行或验收通过。

### 非防守建筑预测明细（2026-11-01，进行中）

- 复核 SPEC 5.2、6.1 后发现：汇总正确只计 stake，但建筑展开列表原先也只列 stake，导致同场非防守建筑无法在该列表中查询其 HP、格子和 stake 身份。现改为列出试算返回的所有建筑，分别标记“防守建筑”或“非防守建筑，不计入败北条”；守楼败北条的当前值、预计值和净变化仍只汇总 stake。该修改不改变规则、试算、正式结算或败北条件。
- 新增 `scripts/verify-city-mecha-building-stakes-browser.mjs`：Vite 响应的测试专用内存插桩从合成 City 选两栋建筑，构造一栋临街 stake、一栋非 stake 的确定性 frontage 对局；断言汇总排除非 stake，逐栋标识、坐标、当前及预计 HP，键盘展开/选择/折叠及 `aria-pressed`。修复前红测为预期 2 项、实际 1 项（`/tmp/mecha-buildings-red-20261101.log`）；修复后中英文 × 1100×700、1440×900、390×844、DPR 1 均通过（`/tmp/mecha-buildings-screens-20261101.log`）。人工查看中英文 390×844 截图，两个条目的文字可读，其余摘要内容需在面板中滚动；截图位于证据目录 `building-stakes-20261101/`。测试不证明棋盘标记的实际视觉效果、实体输入或目标用户体验。
- 修改后的中英文试算成功 → 注入异常 → 恢复回归通过，同时检查目标候选失败时不遗留旧数据（`/tmp/mecha-buildings-recovery-20261101.log`）；异常由浏览器测试注入，不代表原生 WebView 或真实故障覆盖。`npm run typecheck`、`npm run verify:mecha`（202/202）、`node scripts/verify-city-mecha-ux.mjs`、新增脚本语法检查及 `git diff --check` 通过；对应日志分别为 `/tmp/mecha-buildings-typecheck-20261101.log`、`/tmp/mecha-buildings-verify-20261101.log`。
- 此次产品源码变更使上一节记录的隔离包过期，不能以其作为当前源码的原生验收证据。只读系统检查显示 `IOConsoleLocked=No`，但 `CGSSessionScreenIsLocked=Yes`；未绕过锁屏。SPEC 原生视觉矩阵、物理输入、目标硬件 20 次性能测量和至少 5 名目标用户测试仍未完成。并行工作区规则语义冲突与远程 relay 发布风险仍需解决；当前不能宣称完成验收或可发布。
- 中英文 390×844 设置布局回归通过，检查战场及远程设置、机甲选择、资源、顺序、目标预览/确认/取消等程序化交互（`/tmp/mecha-buildings-settings-20261101.log`）。脚本使用合成场景与节流动画帧，不是性能、原生或物理输入验收。
- 停止本轮 Vite 后，当前源码的 `npm run build` 通过（`/tmp/mecha-buildings-build-20261101.log`），并按仓库规定重新构建隔离 `.app` 成功（`/tmp/mecha-buildings-native-build-20261101.log`）；两者均保留大于 500 kB 的 chunk 警告。隔离包为 `apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent Isolation Probe.app`，其可执行文件 SHA-256 为 `e2f9865e3d3fa57e178d4b020f3097e96c17fbf84fe23ca51837bd8b615e2a45`，仅标识该可执行文件，不证明包内所有资源。构建后复查控制台会话仍锁屏，未启动包；构建成功不等于原生运行或验收通过。源码或依赖后续变更须重建。

### 建筑高亮在预测中断和演出后的生命周期（2026-11-01，进行中）

- 扩展 `scripts/verify-city-mecha-preview-recovery-browser.mjs` 时复现：展开明细并选择建筑后，预测异常会卸载明细；预测恢复时明细重新出现但处于关闭状态，旧楼顶标记却重新亮起。修复前红测在英文合成场景观察到标记 `true`（期望 `false`），日志 `/tmp/mecha-focus-recovery-red-20261101.log`。该问题与旧预测数字已清除是两回事。首次编辑产品文件的命令因工作目录错误报 `FileNotFoundError`，没有修改文件，随后在仓库根目录完成修改。
- 在明细因预测不可用或结算演出而卸载时清除选中的建筑；普通成功预测变化且明细仍打开时保留用户的选择。不改变规则或试算。测试对 Vite 响应做专用内存插桩，读取真实 Three 场景中目标楼顶 marker 的 `visible` 状态：中英文合成数据下验证正常预测变化保留选择、异常时隐藏且恢复后不复活、演出时隐藏及下一回合不复活，另复验候选预测异常和恢复；最终日志 `/tmp/mecha-focus-final-green-20261101.log`。程序化检查 marker 状态不证明像素可见、没有遮挡、原生 WebView 或物理输入。
- 修改后的 `npm run typecheck`、`npm run verify:mecha`（202/202，`/tmp/mecha-focus-unit-20261101.log`）、`npm run verify:mecha-models`（31/31，`/tmp/mecha-focus-models-20261101.log`）、静态 UX 检查和 `git diff --check` 通过。上一节隔离包因本次产品改动过期，不是当前源码的原生验收证据；控制台会话仍报告锁屏，未绕过锁屏。原生矩阵、实体输入、目标硬件性能、至少 5 人玩测和并行工作区整合仍未完成。
- 对此修改重跑防守与非防守建筑明细检查：中英文 × 1100×700、1440×900、390×844 均通过（`/tmp/mecha-focus-stakes-20261101.log`）；测试使用合成 frontage 对局与程序化操作，不代替原生及视觉验收。
- 当前源码的隔离 `.app` 重建成功，日志 `/tmp/mecha-focus-native-build-20261101.log`；构建仍有超过 500 kB 的 chunk 警告及 `mp4-muxer` 弃用提示，构建日志中的一次 npm 审计报告 0 项漏洞（只对应当次被审计的依赖树）。包位于 `apps/desktop/src-tauri/target/release/bundle/macos/Oh Agent Isolation Probe.app`，可执行文件 SHA-256 为 `e7de58553e7004ab8c6fb8bd09f71fbd9fcab074566a30a72f6baf0104bbc47d`；此 hash 不覆盖包内其他资源。构建后 `git diff --check` 通过。控制台会话仍为 `CGSSessionScreenIsLocked=Yes`（`IOConsoleLocked=No`）；未启动新包或绕过锁屏，构建不等于当前源码原生验收通过。

### 解锁后的人工验收交接

1. 在目标机器解锁并确认可见桌面后，只通过 `open` 启动上述隔离 `.app`，用 `--args --plugin-formal-mecha-interactive <尚不存在的报告绝对路径>`；英文另加 `--mecha-fixture-en`。报告采用 `create_new`，已有文件会导致报告写入失败。探针使用合成数据；`needs_visual_check` 只是就绪提示，需实际确认显示语言、可见画面和操作结果，不能当作通过。若启动失败或画面不动，记录报告和失败现象，不以模拟运行替代。
2. 按 SPEC §11.3 分别在中英文、三个目标内容视口下检查普通态、焦点、重叠、选目标、顺序展开、预览错误和结算后的可读性与遮挡；标注实际**内容视口**、缩放、设备、状态和截图路径。不把窗口外框尺寸冒充内容视口，也不把已有单一 fixture 视为覆盖全部战况。
3. 实际使用鼠标、键盘及目标触屏完成选择、预览、确认、取消和提交流程，检查暂停、演出、终局、重开、退出与资源清理；逐项记录设备、步骤与结果。程序化输入不充当实体操作证据。
4. 在目标桌面硬件的固定高威胁 fixture 连续切换目标 20 次，记录硬件/环境、原始数据、p50/p95、最慢帧及长任务；SPEC 要求 p95 ≤ 200ms 且无超过 100ms 主线程长任务。设备、测量链或目标 fixture 尚未确认时不要套用先前浏览器近似值。
5. 招募至少 5 名未参与设计的目标用户，逐人记录无提示任务结果、耗时、误解点；两项任务分别是指出受威胁建筑、说明当前草稿预计建筑损失及下一步可执行操作，各任务须至少 4/5 无提示完成。记录失败及补救，不用开发者或合成脚本冒充受试者。
6. 上述交接不能替代远程 relay 数据保留与真实授权链路审计，也不解决原工作区并行 Assault 规则冲突；这些须在发布前分别处理。任何源码或依赖变化后需重建并关联新证据，避免将旧包结果套用到新版本。

### 固定种子生成局面的预测一致性补充（2026-11-01）

- 在 `scripts/verify-mecha-invariants.ts` 增加固定种子 `20261101` 的多回合采样：24 个起始局面、138 个实际规划状态，包含四种敌方剧本与 `all` / `frontage` 两种 stake；对随机整包、全待机包及去掉一台的部分包进行比对。部分包按规则在原地补待机后交给正式结算；分别验证预测/结算不改变输入，成功或拒绝及故障一致，成功时的阶段快照、事件、胜负、逐栋建筑、敌方阶段机甲受击、实际敌人顺序和来源/合并危险格一致。
- 当前种子得到 407 个成功计划、7 个被双方一致拒绝的计划，138 个部分包样例；成功计划中 238 个含移动、24 个含非待机行动。定向运行通过；完整 `npm run verify:mecha` 为 203/203（`/tmp/mecha-generated-parity-suite-20261101.log`），`npm run typecheck` 及 `git diff --check` 通过。首次组合命令在两项命令后使用了 zsh 只读变量 `status` 而退出 1；已单独重跑类型检查和定向测试并确认退出 0，原日志保留。
- 这是有界采样而非穷举全部合法整包；`previewPlan` 和 `playTurn` 共享 `runTurn`，比较证明这些样本的投影和入口结果一致，不独立证明底层规则正确。现有定向边界测试仍需与此一起看，也不替代用户、原生视觉、实体输入及性能验收。此轮仅改测试与记录，不改变产品源码或依赖，上一节隔离包未因这次测试改动而过期。

### 有界棋盘的完整计划穷举（2026-11-01）

- 在 `scripts/verify-mecha-invariants.ts` 增加三个确定性有界棋盘：`stationary_smash`、`raid_ssw`、`siege`，含两种 stake、建筑、受损友军及不同敌人。棋盘上允许通行的格子被有意限制，使测试可枚举全部单机可达终点及不冲突的移动组合；在各移动后状态枚举 `legalActions`、单目标的显式目标别名及未指明目标，检查每个列出的行动能通过整包校验，再遍历合法行动组合。机甲数组顺序和“显式移动到原格”与规范表示视为同一语义，未作为独立方案重复穷举。
- 共检查 812 组移动、45,258 个合法完整计划（三个场景依次为 13,662、15,798、15,798）；其中 43,588 个含攻击、10,750 个含修理、48 个包含实际落空事件。对每个方案分别检查预测与正式结算不修改输入，比较完整阶段快照、事件、逐栋建筑和 stake、敌方阶段机甲受击、敌方顺序及实际胜负。`npm run verify:mecha` **204/204**，日志 `/tmp/mecha-exhaustive-suite-final-20261101.log`；`npm run typecheck` 和 `git diff --check` 通过。
- 穷举范围仅限以上受限场景和规范表示，不能扩大为所有可能地图、所有类型的损伤或独立证明共享 `runTurn` 的底层规则正确；它与此前 138 个多回合生成状态采样和定向案例互补。未执行原生或实体输入；只修改测试和本记录，不改变隔离包的产品源码。

### 纠正临街建筑穷举场景（2026-11-01）

- 上述 `raid_ssw` 场景原将道路放在建筑自身格 `(6,4)`；临街判断只看四邻格，结果没有建筑临街而回退为全部 stake。先增加显式断言 `stakeBuildings(state)` 只能返回 `street`，原场景如预期失败，实际为 `street`、`back`（`/tmp/mecha-frontage-assert-red-20261101.log`）。上节初版穷举的结果不能证明混合 stake 的覆盖。
- 将道路改到 `street` 的相邻格 `(5,4)`，并明确断言场景包含两栋建筑、只有 `street` 为 stake；该格同时在 Boss 脚印内，创建后的 `spawnsAreOpenGround` 和完整计划枚举均通过。修正后定向穷举仍为 812 组移动、45,258 个计划（13,662 / 15,798 / 15,798；攻击 43,588、修理 10,750、落空 48），日志 `/tmp/mecha-frontage-exhaustive-green-20261101.log`。
- 更新后完整 `npm run verify:mecha` **204/204**（`/tmp/mecha-frontage-full-20261101.log`），`npm run typecheck`（`/tmp/mecha-frontage-typecheck-20261101.log`）及 `git diff --check` 通过。这一修正覆盖该固定局面中的 stake 和非 stake 投影，不扩大穷举范围，也不能独立证明共享 `runTurn` 的底层规则。仅更改测试及记录，未变更产品源码、依赖或隔离包。
- 只读 `ioreg` 仍显示 `CGSSessionScreenIsLocked=Yes`，`IOConsoleLocked=No`；未启动包或绕过锁屏。真实原生视觉、实体设备、目标硬件性能和目标用户验收仍待完成。

### 固定种子生成棋盘的完整计划穷举（2026-11-01）

- 为 SPEC 11.1 的确定性生成局面增加完整计划检查：在原有三个固定有界棋盘外，使用种子 `20261102` 生成四个互不相同的有界地形/高度图，分别使用全部四种敌方剧本；生成建筑和机甲 HP、机甲冷却、Boss HP 及 `all` / `frontage` stake。出生点、Boss 脚印及建筑等关键格保持可构造；每局均检查出生位置有效。
- 沿用对规范合法移动与行动组合的枚举与逐包验证。四个生成局面分别检查 **16,002 / 7,722 / 6,896 / 10,583** 个完整计划，合计 **41,203** 个，其中 **39,522** 个含攻击、**8,465** 个含修理。加上三个固定场景，累计 **1,740** 组移动、**86,461** 个完整计划；其预测和正式结算的快照、事件、建筑与机甲血量、敌人实际次序及胜负逐项对照，输入不可变。定向日志 `/tmp/mecha-generated-exhaustive-final-20261101.log`。
- 完整 `npm run verify:mecha` **204/204**（`/tmp/mecha-generated-exhaustive-suite-20261101.log`），`npm run typecheck`（`/tmp/mecha-generated-exhaustive-typecheck-20261101.log`）及 `git diff --check` 通过。测试仅枚举这七张受限棋盘的规范表示，不代表其他地图、所有状态或独立证明共用的 `runTurn` 规则；原生、物理输入、目标硬件性能和目标用户验收依然缺失。仅更改测试及记录，未修改产品源码、依赖或隔离包。

### 目标用户测试执行准备（2026-11-01）

- 增加 `docs/MECHA_BATTLE_UX_USER_STUDY.md`：规定合成 fixture 与答案卡的事前核验、两项中立任务、无提示判定、匿名记录和 4/5 的计算方法。历史的 32→29 不被假定为当前构建的答案；测试前必须重新核实。该文档只是执行准备，尚未招募或测试任何参与者，不能作为用户验收通过的证据。
- 系统只读检查仍为 `CGSSessionScreenIsLocked=Yes`；本轮未打开桌面应用、未执行实体输入或改变产品源码。用户测试、原生矩阵及目标硬件性能仍未完成。

### 解锁后的注册插件检查（2026-11-01 09:28–09:32）

- 检查时本机 `IOConsoleLocked=false`、当前控制台的 `CGSSessionScreenIsLocked` 字段未出现，随后按仓库规定通过 `open -n` 启动此前构建的隔离 `.app`（可执行文件 SHA-256 仍为 `e7de58553e7004ab8c6fb8bd09f71fbd9fcab074566a30a72f6baf0104bbc47d`）；仅使用注册插件合成 fixture，非真实会话。当前独立 worktree 的 `npm run typecheck` 通过，`npm run verify:mecha` 204/204 通过。
- 自动注册插件探针报告 **failed / formal_mecha_seed_timeout**：设置界面点击、种子输入及应用事件已发出，约 17.4 秒出现宿主的 `formal_unresponsive`，约 182 秒超时；未发出种子保存及战场就绪事件。失败发生在种子应用后，但现有证据不能确定为产品逻辑、探针或环境故障；此项未通过，不能以解锁前报告替代。
- 随后启动预置种子的交互式注册插件夹具，报告 **needs_visual_check**：合成来源、种子 `4196523069`、战场 DOM 和渲染时钟推进得到程序化确认。目标进程窗口截图展示中文初始局面；该图只记录一个窗口画面，不证明全部 SPEC 视口、布局、实际输入或预测正确，探针明确标记 `automated_acceptance=false`。截图由目标窗口 ID 直接捕获，非整个桌面；窗口外框 1100×760，内容视口与缩放未测定，不能当成 1100×700 内容视口验收。
- 两份报告与窗口截图保存在 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/mecha-battle-ux-evidence/native-20261101-0931/`。交互夹具在报告后保持运行，供实际用户手动检查；重新运行须使用尚不存在的报告路径。独立 UX 提交 `c61b6228` 已成为本地 `feature/mecha` HEAD；目标工作区仍有并行 Assault 等未提交改动，此处的隔离包与测试不覆盖那些改动。
- 仍需排查自动种子超时、原生中英文/视口与状态矩阵、实体鼠标键盘触屏、目标硬件 20 次性能测量和至少 5 名目标用户测试；并行地形规则与远程 relay 风险仍待评审。当前不能宣布完成验收或发布。

### 2026-11-01：小窗、结果回看与顺序点击歧义的后续修订（进行中）

- 在独立 worktree 新增可选“精简面板”，缩小威胁摘要的高度；内容仍保留在可键盘滚动的区域，不等于在小窗中完全消除遮挡或证明镜头近景可读。新增的“上一回合结果”只在演出结束或跳过后读取实际 `lastLog`；生命值变化使用已校验的 `healthTimeline` 次序，明细不可用时明确提示，重新开局会清空。展开“结算顺序”不再改变棋盘拾取语义；来源仍可用列表选择。
- `scripts/verify-city-mecha-order-click.mjs` 的合成 Chromium 双语言回归：在三方共同威胁的可移动空格，展开/关闭顺序时鼠标移动一致、展开后模拟触屏仍可移动，列表可键盘/模拟触屏选择；640×480 的精简面板高度下降且仍可用键盘滚动；跳过演出后的回看逐项对照实际日志和生命变化，重开清空。日志 `/tmp/mecha-compact-recap-20261101.log`。这是合成 fixture 与软件渲染，不是物理设备或真实用户验收。更改前原行为及未通过的规则测试不因本次本地回归而消失。
- 换种子路径先在 worker 准备对应布局，再写入本地状态并更新引擎；异步模型变更时重新准备，取消时不主动更新引擎。单元测试 `npm run verify:city-seed` 5/5 和浏览器合成数据从 `74031` 切至 `4196523069` 并进入战斗通过（`/tmp/mecha-seed-change-browser-20261101.log`）；浏览器轮询仍不能证明目标硬件性能。失败文案区分准备失败、无法确认持久化和持久化后更新失败；保存路径本身保留宿主 IPC/localStorage fallback。
- 使用另一个独立 target 构建隔离 `.app`，未覆盖或退出仍运行的交互窗口；经 `open -n` 运行正式注册插件合成自动探针，报告 `mecha-battle-ux-evidence/native-20261101-seed-worker/formal-automatic-report.json` 为 `passed / probe_complete`（申请种子、进入战斗、待机风险确认、结算、退出）。这证明本次自动流程通过，并不能证明初始 seed 与目标 seed 不同：探针没有记录初始值，已有存储可能已是目标值，故不能据此宣称原生新种子切换已修复；亦不覆盖后来加入的面板及结果回看。此前 `formal_mecha_seed_timeout` 原报告仍保留。原生真实输入、远程对战和性能验收依旧未完成。
- 目标 `feature/mecha` 工作区存在并行、未提交的 Assault 和 relay 修改；其 `v1.4 ignores experimental Assault terrain annotations` 测试重新运行仍失败（预期 2、实际 null）。这不是 Git 未解决冲突，也不是独立 worktree 中 204/204 规则回归的证明范围；远程实机一致性未验证。不得覆盖并行修改或宣布 SPEC 完整通过。

- 后续对精简面板增加远程状态切换时回到顶部并展示锁定提示；640×480 中文合成测试通过，高度从 192 降至 96px，生命行完整，截图 `mecha-battle-ux-evidence/browser-20261101-compact-adjusted/compact-zh-640x480.png`。英文合成测试发现初版提示换行导致生命行截断，缩短提示后的英文重跑在战棋入口导航等待超时，尚未证实修复。另一次扩展目标选择视口的合成测试在中文初始 1100×700 选择大怪步骤超时，尚未定位；两项失败不能计作通过（日志分别为 `/tmp/mecha-compact-en-adjusted-20261101.log` 和 `/tmp/mecha-target-viewport-20261101.log`）。最新独立 worktree 类型检查、构建、seed 单测 5/5 和规则回归 204/204 通过；均不覆盖 `feature/mecha` 并行未提交改动，也不替代原生验收。

- 英文精简面板与移动/威胁来源选择、真实结算回看合成回归重跑通过（`/tmp/mecha-compact-en-retry-20261101.log`）；目标选择及取消的中英文五视口回归重跑通过（`/tmp/mecha-target-viewport-retry-20261101.log`）。此前入口及选择步骤的偶发超时原因仍未定位，不能据此认定已消除。
- 增强隔离探针后，在初始输入框与 localStorage 均为 `74031`、合成 fixture 标识存在的前提下，再申请 `4196523069`；隔离 `.app` 经 `open -n` 自动执行通过，报告 `mecha-battle-ux-evidence/native-20261101-distinct-seed/formal-automatic-report.json` 为 `passed / probe_complete`，事件依次包含 `mecha_seed_initial_74031`、`mecha_seed_input`、`mecha_seed_apply_clicked`、`mecha_seed_stored`、`mecha_seed_applied`、战斗结算和退出。隔离构建 `/tmp/mecha-distinct-seed-native-build-20261101.log`；门禁 VM 测试包含初值和缺 fixture 等 fail-closed 检查。该证据证明原生自动 fixture 下输入和持久化由不同初值改变，不单独证明 CityEngine 实际使用新 seed；也不覆盖真实数据、实体输入、远程或性能验收，原先超时记录保留。

- 精简面板进一步在顶部展示守楼当前值和预测值；预测失败时显示风险未知，演出中不显示预测。增补的 640×480 合成浏览器测试先在英文风险未知场景发现摘要被截断（`/tmp/mecha-compact-risk-debug.log`），调整摘要顺序和间距后，中英文的初始预测与故障状态可见性断言均已通过；同一次全流程英文通过，但中文后续“继续提交”节点脱离 DOM 并超时（`/tmp/mecha-compact-risk-green2.log`），原因尚未确认。全流程单独重跑时英文完成、中文未输出完成结果即被主动中断（`/tmp/mecha-compact-risk-green3.log`）；尚不能计为双语通过。此后源码未发生新改动时 `npm run typecheck`、`npm run build`、`npm run verify:mecha`（204/204）、`node scripts/verify-city-mecha-ux.mjs` 和 `git diff --check` 通过；不代表原生、真实用户或性能验收。

### 重绘参考稿与目标分支契约审计（2026-11-01）

- 用户纠正了主要视觉参考：本轮以 `battle-ui-reference-refined-move-640x480.svg` 和 `battle-ui-reference-refined-target-640x480.svg` 为参考，`battle-ui-compact-640x480.svg` 是另一方案。SPEC 已记录其静态示意性质以及保留 3D City、10×10 棋盘和真实预测的约束。
- 独立 worktree 的 `npm run typecheck`、`node scripts/verify-city-mecha-ux.mjs` 和 `npm run verify:mecha` 204/204 在本轮布局改造前通过。另一次现有目标视口测试进入中文合成战斗后停留在提交阶段；为释放并发软件渲染资源主动中断，不能算通过或产品失败。
- 对 `feature/mecha` 未提交的 Assault 地形变更只读审计：`mecha-v1.4` 的地形注释忽略断言在目标树失败、在独立树通过；目标树自己的陡坡测试则要求阻挡及碰撞伤害。合成内存投影检查显示局部限制格与边在本地受限，但远程 arena/state 重建未携带注释；这只证明本地到远程启动投影行为不同，并非已在真实远程对局观察到分歧。UX 按现行 SPEC 不改规则；保留 v1.4 或引入新规则版本与远程契约，须单独评审决定。两工作树未做合并或覆盖，相关行为、兼容版本和真实 relay 尚未验证。

### 参考稿首轮截图验收（2026-11-01）

- 独立 worktree 当前未提交代码；使用本地 Vite（端口 5188）、合成 City `fixtureSessions=30`、seed `4196523069`、Chromium headless/SwiftShader、DPR 1，限制 requestAnimationFrame 以减少软件渲染负载。分别截图中英文、1100×700 与 640×480 的首回合规划态，以及先提交全员待机、跳过演出、第二回合将 Assault 移动至 `(3,2)` 后选择大怪但未确认的目标试算态。截图位置 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/mecha-battle-ux-evidence/reference-hud-acceptance-20261101/`，目标选择使用列表，不证明棋盘点击。截图脚本一次运行完成，但未运行自动化断言。
- **视觉验收结论：未通过，需继续迭代。** 两侧分栏、三机状态、守护建筑与预测汇总、回合、确认/取消已出现在截图，但镜头仍偏高偏远，3D 棋盘边界及机甲/目标难辨；城市环境和小型箭头竞争视觉注意力，与重绘稿的战场中心、单位和目标优先级差距明显。640×480 的两个侧栏及底部面板仍侵占较多画面。
- 640×480 的右侧威胁详情在默认高度下被裁在滚动区域内，截图中有半行文字；英文目标试算首屏仅露出直接伤害，后续结果须滚动。左上已同时展示完整的守护建筑当前值与预测变化，但这不等于右侧详情首屏可读。需检查收起/滚动提示与确认后焦点，不能仅缩小字体解决。
- 目标试算已有基于真实规则的伤害/推挤文本，但画布中缺少足够清晰的已选目标及其方向反馈；世界视图尚未接入选中目标状态，不能据静态截图宣称已有完整目标可视化。补齐时需保持预测不可用和草稿语义。
- 本次未验证真实 Tauri、实体鼠标/键盘/触屏、真实远程或目标硬件性能，也未测试所有状态/视口。此前浏览器回归在布局并行调整期间报告英文 640×480 的预测详情被裁及另一个 DOM 脱离异常；截图验证了首屏详情裁切现象，但未定位 DOM 异常。不得将本次截图记为 SPEC 全部验收通过。

### 参考稿对照与第二轮截图（2026-11-01）

- 对照分析见 `docs/MECHA_BATTLE_UI_DESIGN_COMPARISON.md`。针对小横屏缩窄两侧栏、目标试算移到下方中央；3D 增加棋盘边界、阵营/当前 HP 标记和目标框。候选与位移取真实试算；碰撞无位移不画成功箭头，前序行动改变了目标位置时暂不画方向，避免箭头脱离当前显示的目标。保留 v1.4，不引入 Assault 特殊坡地规则。
- 本地 Vite/Chromium headless/SwiftShader、DPR 1，使用先前同一合成 seed、规划态和第二回合目标态，经列表选大怪；截图目录 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/mecha-battle-ux-evidence/reference-hud-iteration-20261101/`，中英文 640×480、1100×700 共八张。目标局面因碰撞未发生位移，缺少箭头是规则一致的，不能据此验证成功位移箭头的视觉效果。
- **视觉仍未通过参考稿验收。** 小窗左侧更窄，目标框和真实结果可见；但城市仍抢眼，棋盘与机甲相对小，未达到设计稿的棋盘优先。640×480 中文规划面板底部及目标面板后续内容仍有被截半的视觉现象；英文目标截图中目标按钮仍挤占面板，完整试算需滚动。它们是视觉观察，不能笼统声称所有文本已修复。
- 当前源码 `npm run typecheck`、`npm run build`（仍有大 chunk 警告）、`npm run verify:mecha` 204/204、`npm run verify:mecha-models` 31/31、`node scripts/verify-city-mecha-ux.mjs`、`git diff --check` 通过。独立合成 3D 回归覆盖三种比例四次旋转、中心拾取、不同目标与位移标记，但不是完整 City 实景/真人测试。
- 稳定源码下英文 640×480 浏览器回归：基础状态、提交/移动、目标确认取消、目标试算与故障恢复通过；展开的守楼详情及攻击顺序各有一处末行局部裁切断言失败（其余内容可滚动到），记录 `/tmp/mecha-hud-final-en-640-20261101.log`。该脚本只用列表操作，非 3D 点击、无障碍或原生验证；仅跑了英文单视口，不能当完整矩阵通过。
- 尚未验证真实 Tauri、实体设备/键盘、屏幕阅读器、真实远程、性能或真人可用性。独立 worktree 仍有未提交修改；目标 `feature/mecha` 的并行未提交改动和 Assault/远程契约问题没有被覆盖或解决，尚未合并。

### 棋盘与决策反馈 P0 执行进度（2026-11-01）

- 已在独立 worktree 实施：按棋盘和地形高度拟合战术视角，强化格网与边界；保留地图聚焦入口供 HUD 下的棋盘操作。单位阵营/当前生命、选中单位、目的格、目标及威胁采用各自标记。候选结果的文字与目标/位移标记使用同一次规则试算；没有实际位移或起点已被先前行动改变时不画成功推挤箭头。取消、确认及试算失败时清理相应标记。**这些是已实现的行为，不等于全部 P0 已验收。**
- 在扩展宽屏行对齐处理之前，独立合成 3D 测试覆盖平地、矩形、坡地及 640×480、390×844、1100×700 的四次旋转，检查格顶点、指定格模拟鼠标/触屏拾取与镜头租约恢复（`/tmp/mecha-camera-final-20261101.log`）。真实 `MechaBoard` 与 `CityMechaWorld` 的合成集成覆盖成功位移、碰撞无位移、前序推挤、确认/取消及预测失败恢复（`/tmp/mecha-target-integration-final-20261101.log`）。这两组不验证真实城市高楼遮挡或标记的视觉可读性。
- 同一版本的 640×480 中英文 HUD 测试通过，含详情滚动和 700×500 ↔ 640×480 变化后的行边界检查（`/tmp/mecha-hud-extended2-{zh,en}-r3-640-20261101.log`）；800×600 中英文通过（`/tmp/mecha-hud-{zh,en}-800x600-r3-20261101.log`）。1100×700 中文守楼详情发现底部半行；英文预测恢复的一步超时，结论不确定。随后把行对齐处理扩展到宽屏，但该修改的完整复验尚未完成。
- 本轮浏览器截图位于 `/Users/Admin/.codex/visualizations/2026/10/31/01a19222-356d-7c23-84c9-35be788cbd41/mecha-battle-ux-evidence/reference-hud-r3-20261101/`，为扩展宽屏行对齐处理之前的代码，合成 City、Chromium/SwiftShader、DPR 1；各尺寸点击“战术视角”重置构图。640×480 中棋盘与单位仍小，城市仍显眼，**视觉验收未通过**。目标截图的碰撞结果没有位移，不能作为成功位移箭头的视觉证据。
- 之后尝试最终代码的宽屏回归时，中英文 1100×700 均在合成城市加载预检超时，未进入应用断言（`/tmp/mecha-hud-{zh,en}-1100x700-r4-20261101.log`）；这是未完成/测试环境不确定，不能当作通过或确认产品缺陷。窗口大小变化不会自动重置用户镜头，可手动按“战术视角”重新拟合；是否需要自动重拟合仍待设计与验收。
- 未完成：真实 City 多种高楼遮挡、地图聚焦下 HUD 覆盖格的端到端操作、多种地形与物理输入、真实 Tauri、无障碍、远程与性能实测。没有引入 Assault 特殊坡地规则；目标 `feature/mecha` 的并行修改和规则契约风险仍须独立协调，当前改动尚未合并。
- 最终代码补跑：`npm run typecheck`、`npm run build`（大 chunk 警告仍在）、`npm run verify:mecha`、`npm run verify:mecha-models`、`node scripts/verify-city-mecha-ux.mjs` 和 `git diff --check` 通过。静态 UX 检查中关于旧格网透明度的精确断言已按本次有意增强对比度的数值更新，而非作为视觉可读性的证明。
- 最终代码的中文 640×480 HUD 子集通过（`/tmp/mecha-hud-zh-640x480-r4-20261101.log`，含滚动、缩放和预测失败恢复）；英文 640×480 及其余 800×600 最终代码子集未完成，本轮矩阵未全部通过。原本宽屏的半行修正仍需在可运行的环境中重测。以上都不替代真实设备、棋盘点击和视觉验收。

### 本地 / 远程规划共用进展（2026-11-01，开发中）

- 草稿结构、待机补全、整包/单行动计划组装、移动后位置投影，以及预检的成功 / 拒绝 / 未知结果统一放在 `game/mecha/planning.ts`。本地控制器与远程界面都使用它；行动与移动是否合法仍由 PvE / PvP 对应的权威规则判断，不在界面再维护一份。
- 移动投影本身不代表合法；远程先验证整队移动再展示投影。本地保留原有草稿编辑和预览失败降级逻辑。远程 PvE 预检隔离事件接收器；PvP 沿用自身规则。未显式选择的行动均视为待机，预检通过也不能保证顺序结算时不会落空。
- **尚未统一的是展示与状态编排**：本地 City 控制器、HUD、城市 3D 场景和远程网络/权限、简化 3D 场景与控制界面仍是独立适配。后续应先定义共用的视图模型与可组合 HUD，再迁移展示，不能复制规则或假称目前已经复用整套 UI。
- 远程规划测试使用合成客户端与模拟 3D 回调，不代表真实 WebGL、Tauri、弱网恢复或公网双端已验收。PvP 预检目前会运行克隆后的整回合，性能有待测量；未知结果不能显示为确定的成功。
- 回归入口：在 `apps/agent-city/ui` 运行 `npm run verify:mecha` 和 `npm run verify:mecha-remote`；后者是 Playwright 浏览器测试，需安装 `apps/desktop/ui-dev` 的依赖和 Chromium。两项都不替代双设备实测。
