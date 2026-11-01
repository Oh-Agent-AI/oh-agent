# 机甲战斗清晰度与设定稿头像：验收记录

> **阅读提示（2026-11-01，本轮更新）：** 本文前部保留旧“棋盘身份标签/头像”实现的交付和失败记录，用于追溯，**不代表当前实现**。最新修正与验收见文末「本轮修正：头顶血槽与左下设定稿」。最新证据在 `artifacts/mecha-clarity-p0/reference-fix/`，不要用旧 `acceptance/` 目录的实现截图判断当前效果。

日期：2026-11-01（Asia/Shanghai）。

## 结论与范围

**整体 UI 暂不批准验收；不能称为全部开发完成。** 本批实现范围是 SPEC 的 P0 战斗清晰度及紧密相关的 P1-3 计划摘要，加上用户本次要求的已有角色设定稿头像。完整 P1/P2 与远程组局/上线门禁没有因本批交付而完成或获准。

代码在独立 worktree：
`/Users/Admin/.codex/worktrees/mecha-battle-clarity-p0/skill-vitals`，
分支 `codex/mecha-battle-clarity-p0`；本批改动未提交、未合并到 `feature/mecha`。主 checkout 的 Assault/怪兽/引擎等原有 WIP 未覆盖。

子 agent 已交付各自切片，但切片交付不能代替整合、视觉与原生验收。Franklin 和后续 Terra 的 HUD 工作是同一切片的连续完善，不计作两套独立功能。原始派单遗漏了直接阅读 SVG；本次已补做参考阅读，不能倒推原交付已经按图视觉还原。

## 设定稿头像

- 来源：已有 `docs/design/mecha/2026-10-26/{assault,gunner,support,boss,raider}.png`，不是重新生成或通用线稿。
- 使用主角色 3/4 视图的局部裁切；不把页眉、侧视、尺寸说明、剪影面板缩进头像。
- 输出五张 256×256 JPEG，总体积 147,652 bytes；原图未修改，也不作为 runtime 缩略图打包。
- 已接入三机计划卡、world DOM 身份标签、敌军威胁来源/结算顺序及目标按钮。
- West/East Raider 共用同物种设定稿，保留各自短名和方向身份符号；unknown 没有猜测头像，加载失败退回对应身份符号。
- `apps/agent-city/ui/src/assets/mecha/portraits/README.md` 和 `provenance.json` 记录原图 hash、裁切坐标、输出 hash 与本地复现方法；来源说明进入 `src/assets/LICENSES.md`。
- 主 agent 已人工检查五张裁后图；不把设定板上未经验证的尺寸/重量当游戏规则。

## 工程验证

最新头像整合版已运行：

| 检查 | 结果 |
| --- | --- |
| `npm --prefix apps/agent-city/ui run typecheck` | 通过 |
| `npm --prefix apps/agent-city/ui run verify:mecha-clarity` | 20/20 通过，含 source/output hash、身份别名、unknown、SSR 无障碍与战场 mask/lease 测试 |
| `npm --prefix apps/agent-city/ui run verify:mecha` | 267/267 通过 |
| `npm --prefix apps/agent-city/ui run build` | 通过；仍有大于 500 kB chunk 的构建警告，不是性能验收通过 |
| `node scripts/verify-city-mecha-ux.mjs` | 通过；静态门禁不代替截图验收 |
| `git diff --check` | 通过 |

## 浏览器验收环境与边界

本 worktree 的 Vite dev server `http://127.0.0.1:5198`；headless Chromium / software WebGL，DPR 1。
使用 `?fixtureSessions=30`、synthetic seed `4196523069`，不读取真实 agent/session 日志。为限制共享机器的软件渲染工作量，rAF 被测试 harness 节流到约 100ms；不是实际设备性能测试。

头像专项脚本：`scripts/verify-city-mecha-portraits-browser.mjs`。
完整 HUD 行为脚本：`scripts/verify-city-mecha-reference-hud-browser.mjs`。
脚本分别报告头像加载/失败降级/退出重进与当前 HUD 行为，不能把头像通过等同于整体视觉通过。

### 头像专项整合浏览器结果

**6/6 组合通过头像功能检查**：中英文 × 640×480 / 800×600 / 1100×700。
九张实际图片（3 计划卡 + 6 战场标签）均真实解码为 256×256；五个角色资源映射正确，东西 Raider 短名不同；敌军来源图片正确；装饰头像不重复按钮无障碍名称；主 harness 触发真实组件 `error` handler 后退回原身份符号，退出移除旧标签，重进恢复图片，不新增 pageerror。
这套整合 harness 的降级动作是主动 dispatch 图片 error，不是传输失败模拟；子 agent 的离线 portrait-only 额外检查了实际解码失败、切换单位及未知身份。两者均不能代替整体 UI/网络验收。

| 语言 | 视口 | 头像功能 | 与 HUD 相交的标签数（几何诊断） |
| --- | --- | --- | --- |
| zh | 640×480 | 通过 | 5 |
| zh | 800×600 | 通过 | 3 |
| zh | 1100×700 | 通过 | 1 |
| en | 640×480 | 通过 | 5 |
| en | 800×600 | 通过 | 5 |
| en | 1100×700 | 通过 | 1 |

几何相交不是逐像素遮挡判定；主 agent 已人工查看六张规划截图，确认 640 双语 Boss/West 标签被常驻图例遮挡、Support 被侧栏遮挡，英文 800 仍有顶栏/目标卡占用，1100 的 West 标签上沿仍与图例相交。**所以这 6 个头像功能 PASS 不是视觉 PASS。**

证据目录：`artifacts/mecha-clarity-p0/acceptance/`。
- `portraits-browser-results.json`：完整矩阵、身份/HUD 诊断及限制。
- `portraits-planning-{zh,en}-{640x480,800x600,1100x700}.png`：最新设定稿头像规划截图。
- `setting-portraits-contact-sheet.png`：五个实际 runtime 裁图。
- `reference-vs-current-portraits-640x480.png`：640 同尺寸参考与最新英文规划界面对照，不是像素回归通过图。

### 最新稳定完整 HUD 行为子集

在头像矩阵结束后，保持代码不变重新运行 **英文 640×480** 的 reference HUD 脚本：
**1 个 app assertion failure，0 inconclusive，0 harness failure**，所以这个行为子集也未通过。

剩余失败是展开风险详情、滚动到建筑条目时，102px 高的 `fixture-synth-002` 按钮仍被 `mecha-turn-summary is-compact` 裁切。中心可以 hit-test 不等于控件整块可见，不应弱化 `usable()` 的整框/祖先裁切断言。

本次已通过：回合/资源可读、三机按钮与提交可达、工具栏和主要规划面板不相交、建筑详情文字无半行、提交风险取消/确认、真实草稿移动、目标确认/取消、长目标预测的滚动+resize、键盘焦点恢复、预测失败清空旧数值并恢复。
“forecast, threats and order” 包围阶段被上述建筑按钮失败打断，后续顺序断言不是 PASS；本轮**没有重跑完整 HUD 的六组合矩阵**。头像专项六组合不能填补该缺口。

最近的 scrollport 修复让本次英文 640 目标/失败详情半行断言通过，但不证明其它语种/尺寸的长详情已通过；仍需修复建筑控件裁切后重跑。

稳定子集截图采用 `hud-stable-{planning,target,reference-hud}-en-640x480.png`，日志为 `hud-stable-en-640x480.log`。最终批次以 `portraits-planning-*` 和 `hud-stable-*` 为准；不要将更早 root 目录中的 baseline/compact/integrated 诊断图当最终验收。

## 与 refined SVG 的人工比较

参考：
- `docs/design/mecha/battle-ui-reference-refined-move-640x480.svg`
- `docs/design/mecha/battle-ui-reference-refined-target-640x480.svg`

保留项目 3D 城市与真实 10×10 规则，不以参考的独立 8×8 像素示意棋盘替换规则；示意伤害、HP、资源数字不作为实现预期。

| 维度 | 当前观察 | 判断 |
| --- | --- | --- |
| 角色识别 | 三机使用黄/蓝/绿原设定稿，Boss/Raider 保留独立外形；短名、HP、我方方形/敌方菱形、选中黄边仍在 | 头像来源修正完成；全局可见性仍受 HUD 遮挡，P0-2 不能全通过 |
| 顶部占用 | 参考分散四角，中央留白；当前常驻图例在 640 窗口横跨两行 | 顶部敌军标签被图例遮住，视觉验收阻塞 |
| 左侧计划卡 | 参考三张简身份卡同屏；当前完整计划摘要更长，640 下需滚动；800×600 英文仍较中文多一行图例、少一张同屏卡 | 必须保留真实摘要语义，但密度/渐进披露尚未收敛，不能照抄 70×37 来删信息 |
| 中心战场 | 已有可逆城市装饰弱化与格线增强；3D 楼体、街道和标记仍比参考复杂 | 不宣称棋盘与单位已经始终成为第一视觉焦点；高楼/坡地和真实拾取仍待完整验收 |
| 底部动作/提交 | 确认、取消及结束回合可达性已做行为检查；当前大面板比参考紧凑动作块占用更大 | 完整动作卡、默认视角、分区布局仍属于未完成 P1 |
| 风格统一 | 当前圆角、整块资源条、按钮与参考方角双线/分段资源有差异 | 属 P2 视觉收敛，未宣称完成 |

## 收尾优先级

1. **P0 阻塞：**先解决顶部图例与单位标签遮挡；逐一验三机和三敌身份、模型锚点/选择同步及 10×10 全局访问。头像正确不自动解决构图。
2. **P1 可用性：**先修复已复现的风险建筑按钮整块裁切，再稳定其它语种/尺寸的长预测与顺序详情的 scrollport 和 resize；保留半行、完整控件、焦点测试，不能削弱断言来宣告通过。
3. **P1 构图/渐进披露：**在完整计划摘要不丢失前提下收紧侧栏与动作区，调整默认相机、安全区和地图聚焦路径。
4. **P2 视觉：**按 refined SVG 收敛边框、字体层级、图标与资源表现，保持真实玩法语义。

尚未做 Tauri bundle/native 验收、真实机器交互/性能、高楼坡地全场景、正式无障碍及远程权限/网络验收。不得从 unit/build/headless fixture 推断这些门禁通过。


## 本轮修正：头顶血槽与左下设定稿

日期：2026-11-01。修正仍在独立 `codex/mecha-battle-clarity-p0` worktree，基于 `b352e4ae`；**本轮与前部的未提交改动均尚未提交、尚未合并 `feature/mecha`**。主 checkout 的 Assault/怪兽/规则等 WIP 和用户的 5175 服务未覆盖、未停止。本节取代前部关于“当前仍有棋盘头像标签”和“当前 HUD 行为未通过”的状态判断，但不抹除旧失败证据。

### 信息分工与实际修改

1. **棋盘只显示小血槽。** 三机与三个敌人的头顶为 34×7px 血槽（Boss 42×7px），只有填充条和必要的选中箭头；没有头像、姓名/HP 文字卡、引线或远处排布。投影跟随实际渲染模型，死亡、演出和离屏时隐藏，退出后清理。HP 上限来自 `board.ts` 的真实规则；缺失/非法数据用斜纹未知态，不把受伤后的当前 HP 当最大值，也不伪造满血。
2. **角色设定图放回身份/操作区域。** 左侧三机卡为已有设定稿缩略图＋名称/HP＋简状态；左下为 84px 大设定稿与并排的真实动作卡。选择三机时大图同步，失效图片按对应身份退化，没有重新生图或虚构驾驶员。项目没有驾驶员系统，不能将参考《陷阵之志》的驾驶员大图解读为本项目已有此机制。
3. **选目标不卷走大头像。** 预测详情拆到独立右下 scroll rail，确认/取消置于头部；长 HP 变化、碰撞和整包结果可滚动。目标结果上限收紧为 36vh，以免挡住右侧怪兽血槽。左下大图、动作卡和右上目标卡保持分区，选目标时仅暂收上一回合/设置详情，不删除其数据。
4. **紧凑默认布局，渐进披露完整信息。** 默认 640×480 三机卡完整同屏；计划来源、非零受击风险和未知警告保留，完整移动/动作/目标按需展开。图例改右下折叠，四角布置保留中央战场。待机假设、预测未知与无敌方攻击仍有区别；没有删除真实草稿语义或填入参考图示意数值。
5. **补修交互回归。** 移动表单使用稳定 scrollport，修复“应用移动”整块裁切；长风险建筑按钮/目标结果保留完整控件与半行断言。代码审核发现新高优先级 flex/grid 覆盖旧 map-focus 隐藏规则，补上同等 scoped 规则及远程停止栏例外。查看战场/恢复面板不改变草稿、目标或预测，大头像和确认/取消恢复可达。

### 工程与浏览器证据

最新代码的工程检查：

| 检查 | 结果 | 日志（均在 `reference-fix/`） |
| --- | --- | --- |
| `npm run typecheck` | 通过 | `typecheck.log` |
| `npm run build` | 通过；仍有 >500kB chunk 警告，未作为本轮性能通过 | `build.log` |
| `npm run verify:mecha-clarity` | 22/22，通过，无跳过 | `clarity-tests.log` |
| `npm run verify:mecha` | 267/267，通过，无跳过 | `rules-tests.log` |
| `node scripts/verify-city-mecha-ux.mjs` | 通过 | `static-ux.log` |
| `git diff --check` | 通过 | 收尾执行，检查 tracked diff |

浏览器矩阵：**最新串行批次完整结束，两脚本退出码均为 0。** HUD 为 0 app assertions / 0 inconclusive / 0 harness failures；未跳过依赖流程。规划和目标两条 map-focus 路径共 12 次通过。头像专项六组合均通过，默认合成场景的 HUD/头顶血槽几何相交计数均为 0。

| 语言 | 窗口 | 完整 HUD 行为 | 设定稿/血槽专项 | 默认 HUD/血槽相交 |
| --- | --- | --- | --- | --- |
| zh | 640×480 | 通过 | 通过 | 0 |
| zh | 800×600 | 通过 | 通过 | 0 |
| zh | 1100×700 | 通过 | 通过 | 0 |
| en | 640×480 | 通过 | 通过 | 0 |
| en | 800×600 | 通过 | 通过 | 0 |
| en | 1100×700 | 通过 | 通过 | 0 |

日志为 `reference-hud-full.log`、`portraits-full.log`，结构化专项结果为 `portraits-browser-results.json`。默认规划截图为 `planning-{zh,en}-{640x480,800x600,1100x700}.png`，目标截图为 `target-*`，失败恢复后的完整行为截图为 `reference-hud-*`。不把脚本几何通过表述为像素级/所有场景的视觉通过。

两个浏览器脚本均采用同一 worktree 的 Vite 5178、headless Chromium/Metal、合成 City fixture，无真实日志或用户数据。HUD 矩阵覆盖规划、目标确认/取消、草稿更新、预测失败恢复、滚动/resize、焦点恢复、三机默认整块可见、大头像/动作与目标结果分区、目标结果与血槽不相交。新增规划/选目标两条 map-focus 路径及 CSS-only 的远程停止栏显示例外；后者没有启动真实远程会话，不证明远程权限或网络门禁通过。

修复过程证据：
- `map-focus-before-fix.log`：中文 640×480 两处真实 app assertion 失败，资源栏/三机列表/提交栏未隐藏。修正后完整矩阵重新运行，不削弱断言。
- `reference-hud-interrupted-selector.log`：新增英文测试误写按钮名 `Restore panels`，而现有翻译是 `Show HUD`，导致 harness timeout 和后续依赖不可达；中止该批、修正 selector、重新完整运行。这个中止记录不是 UI 回归，也不是任何组合的完整 PASS。
- 头像专项同时检查既有 JPEG 加载、精确实体映射、真实 maxHP/填充比例、单填充子节点、无棋盘图片/标签/引线、三机切换、敌军缩图、图片失败、退出/重入及默认 HUD 相交。几何断言与人工截图审核是两类证据，不互相代替。

### refined SVG 人工对照

布局参考仍为 `battle-ui-reference-refined-{move,target}-640x480.svg`。人工查看中文 640 规划与目标、英文 640 目标、中文 1100 规划；最新同尺寸对照为：
- `comparison-move-640x480.png`：左 refined SVG，右合成场景当前规划界面。
- `comparison-target-640x480.png`：左 refined SVG，右合成场景当前目标界面。

**本轮核心 UI 分工已对齐，但不是像素级复刻。** 棋盘头顶不再承担角色肖像与姓名标签；左侧简卡、左下大设定稿/动作卡及右下预测区域已有明确分工。小窗口不再以卷走头像或遮挡血槽换取长结果常驻。完整详情改为滚动/按需展开，是信息密度取舍，不是删预测数据。

仍有设计差异：项目保留真实 3D 城市与 10×10 规则，而非参考的独立 8×8 示意棋盘；蓝色格面、城市楼体、道路、资源条分段表现、边框/字体和面板占用还不是 SVG 的美术语言。参考的示意 HP、伤害与资源不作为测试预期。剩余 P2 美术收敛应另列，不将“核心布局已修正”说成所有 SPEC/PvP 开发完成。

### 未覆盖的门禁

未做 Tauri bundle/native、真实设备触屏/鼠标与全场景 3D 拾取、高楼坡地模型/血槽遮挡、真实机器性能、正式无障碍和公网双端权限/网络验收。装饰性投影容器仍 `aria-hidden`，有局部键盘/焦点检查不等于屏幕阅读器验收。默认合成场景的几何相交为零也不证明所有视角/种子无遮挡。

## 方格属性与点击预告增补（2026-11-01）

### 实现边界

本轮新增 `MechaCellInspector.tsx` 与纯展示投影 `mecha/cellInspection.ts`，在既有右下结果区增补格子/单位查看。`CityMechaWorld` 增加可见活体模型命中与方向箭头；`controller` 不再按草稿中缺失的攻击来源清除活体敌人选择。没有修改战斗数值、原始宣告、远程协议或 Rust/native 权限。

右下空格卡展示实际地形，不照搬用户参考图中的落水死亡/水中禁攻规则：本项目水不可进入但射击可穿过，推入水域按碰撞处理。敌方红色箭头只表示当前宣告的攻击方向，横扫落点不是步行路线；绿色路线只表示我方实际寻路得到的未执行移动草稿。蓝色 P 格的预测契约保持不变。

### 证据目录与过程记录

证据目录：`artifacts/mecha-clarity-p0/cell-inspection/`。本节的最终结果以 `accepted-checks.log`、`accepted-reference-hud.log`、`accepted-portraits.log` 和 `final-interaction/` 完整矩阵为准；早期 probe 与其他复跑日志不是最终验收。

- 首次交互 probe 的击杀边界失败：合成小怪在准备阶段走向建筑，导致测试中的 Support 不再能近战它。修正为固定坐标与宣告的明确合成 fixture，而非放松攻击校验；原失败截图保留。
- 后续 touch probe 的取消按钮 locator 命中两处同名按钮，是测试定位问题，改为结果区内的精确 selector。
- 触屏试算中完整属性卡挤走确认/取消按钮的真实 UI 问题已修正为紧凑摘要与按需展开；专项增加两个按钮默认完整可见、可命中的检查。
- 首轮旧 HUD 矩阵有一处英文 1100×700 select 超时/inconclusive；未将它认定 PASS，最终稳定源码另行完整重跑。
- 复查发现只清格子坐标仍可能让残留的友方 ID 追随新对局；`restart-before-fix.log` 用真实机甲拾取重现 `restart clears friendly unit inspection` 失败。修正为同步清理坐标与单位 ID，保留友方/敌方带活动查看的重开断言，最终矩阵重跑。
- `final-checks.log` 的首轮全规则回归为 267/268：旧入口门禁的源码检查将新属性卡 `.mecha-cell-inspector` 误认成已移除的 `.mecha-cell` 方格棋盘。更新为仅允许精确 inspector 类名，增加旧棋盘 token、旧地形 cell 类名和 inspector-grid 伪后缀仍被禁止的断言；保留 CityGate/空目录/视角占用/唯一对局挂载门禁。该失败不计 PASS；最终以 `accepted-checks.log` 为准。
- 英文文案扫描首次失败保留于 `static-ux.log`；新增文案已进入 `gameCopy.ts` 对照表并使用 `t(...)`，没有放宽翻译完整性检查。

专项浏览器脚本通过 Vite 拦截注入合成地形、单位布局、只读投影和故障开关；点击经实际 canvas pointer handler 与射线拾取，不直接调用 `clickCell`。草稿/故障/生命周期边界的部分前置状态由控制器命令准备，不能将这些前置命令说成 UI 操作验收。原 HUD 脚本继续覆盖真实列表移动、选目标、确认取消与草稿提交。

### 最终验收结果

最终源码保持稳定后，完整重跑如下：

| 项目 | 结果 | 证据（本节证据目录下） |
| --- | --- | --- |
| 静态 UX/翻译、TypeScript 检查 | PASS | `accepted-checks.log` |
| 展示/头像/血槽/方格投影 | 29/29 PASS，其中方格投影 7 项 | `accepted-checks.log` |
| 规则、控制器与既有 mecha 回归 | 268/268 PASS | `accepted-checks.log` |
| Vite 生产构建 | PASS；仍有大于 500 kB 的既有 chunk 警告 | `accepted-checks.log` |
| 真 canvas 拾取专项 | 中文/英文 × 640×480、800×600、1100×700，6/6 PASS | `final-interaction.log`、`final-interaction/browser-results.json` |
| 既有 refined HUD 浏览器回归 | 同一完整 6 组合，0 app assertion、0 inconclusive、0 harness failure | `accepted-reference-hud.log`、`accepted-hud/` |
| 头像/血槽与面板几何回归 | 同一完整 6 组合 PASS，合成场景记录的相交为 0 | `accepted-portraits.log`、`accepted-portraits/portraits-browser-results.json` |
| 补充文档后 Git 空白检查 | PASS | `accepted-diff-check.log` |

`accepted-source.json` 记录本轮 15 个相关实现/测试文件的 SHA-256、worktree、分支与基础 commit，防止把后续主工作区或 HMR 改动归入这次证据。所有改动仍未提交。

人工查看最终中文 640 水格卡、大怪卡和中英文 640 触屏目标卡：右下属性/候选结果分区可读，确认/取消完整可见，未覆盖左下大设定稿。可复核的最新截图：
- `final-interaction/water-zh-640x480.png`
- `final-interaction/boss-zh-640x480.png`
- `final-interaction/touch-target-zh-640x480.png`
- `final-interaction/touch-target-en-640x480.png`

**验收范围仍有限。** 专项经过真实 canvas pointer handler/raycaster，但状态边界的部分前置准备使用合成控制器命令；没有验收 native bundle、物理设备输入、所有地形/模型遮挡、正式无障碍、真实远程匹配或公网双端权限。这里的通过不等于整个 SPEC/PvP 开发完成，也不等于参考稿的像素级复刻。

截图均为合成浏览器场景，不是主分支的运行截图。未提交、未合并到 `feature/mecha`；用户原 5175 开发服务未停止/替换。新版 worktree Vite 5178 保留供查看。
