# v1.0.0-beta.1 设置页信息架构与表单规格

**状态：** Draft v1（2026-09-13，基于 Vite 开发页 `http://127.0.0.1:4178/workbench.html` 设置 tab 的整页截图与 `workbench.html:363-620` / `workbench.js` / `workbench.css` 源码核对），作为 Beta 1 M2「设置中心」的 UI 合同  
**日期：** 2026-09-13  
**关联文档：** [Beta 发布规格](BETA_1_RELEASE_SPEC.md)（B08/B11、延期项 D01、第 61 行旧预算/账单只读原则）、[Beta 执行计划](BETA_1_EXECUTION_PLAN.md)（B1-M2、E301/E305/E306）、[UI/UX 差距分析](BETA_1_UI_UX_GAP_ANALYSIS.md)（§3 目标信息架构、§5.5 数据源、§5.6 设置、§5.7 计费确认）、[总览页后端接入规格](BETA_1_OVERVIEW_BACKEND_INTEGRATION_SPEC.md)（§8.1 数据访问层、M1.1/M2 设置按需加载）、PRD REQ-033–039 / 096–100 / 124–142

## 1. 目标与判断标准

设置页只回答一个问题：**"我要改一项配置，能不能 10 秒内找到、改完、看到回执。"**

当前页面的"乱"不是单点视觉问题，而是四类结构问题叠加（§2）。本规格给出一套可验收的收口规则：

1. 一页一套层级：分区 → 设置项 → 控件，三层，不再有第四层标题；
2. 一页最多一个实心主按钮，且它必须是"待办"，不是"保存"；
3. 金额以货币单位输入，用户不接触"分"；
4. 每个设置项最多一句说明，免责与实现细节不上页面正文；
5. 卡面不出现原始 reason code、内部词表和实现术语；
6. Beta 延期能力不显示可操作入口，已有数据只读。

页面文案层级和分区顺序是本规格的合同；后端 IPC 命令沿用现有合同（§7），本规格**不新增后端命令**，只有一条需要总览接入规格配合的消费方切换（§8 D1）。

## 2. 现状问题（截图证据）

截图来自 2026-09-13 headless Chrome 1180×900 @2x 整页捕获（`$CLAUDE_JOB_DIR/tmp/settings.png`、`settings-open.png`），mock 数据来自 `apps/desktop/ui-dev/public/tauri-mock.js`。

### 2.1 结构层级：四层标题、三种样式、命名不一致

| 现象 | 位置 | 后果 |
|---|---|---|
| eyebrow「设置」+ H1「按你的计费方式配置」+ 副标 + 6 个胶囊导航，4 行才到内容 | `workbench.html:364-378` | tab 已叫「设置」，eyebrow 重复；H1 是口号不是标题 |
| 导航名 vs 分区名 vs 面板名三套写法：「计费与套餐 / 计费模板与套餐」「预算 / 预算与提醒 / 预算设置」「关于与诊断 / 帮助与诊断」 | `:372-377` vs `:381,441,476,536,558,590` | 用户点导航落到不同名字的分区，无法确认到位 |
| 一个 panel 内两个 `panel-title`（预算设置、独立按量预算），中间夹「静默/恢复」按钮，按钮与下一标题零间距 | `:449-460` | 截图 y≈1060-1100 处按钮贴着标题 |
| 「价格与显示」分区内容是统计时区 + 公共价格目录 | `:536-556` | 时区既不是价格也不是显示 |
| 盒中盒：分区边框盒 → 白色执行环境卡 → `<details>` → 按钮 | `.settings-section` + `.src-card` | 三层容器边界，视线无法判断层级 |

### 2.2 预算：三套表单、三个「保存」、单位是「分」

| 现象 | 位置 | 后果 |
|---|---|---|
| 顶部 `budget_config` 表单（月/日/阈值）+ 下方「独立按量预算」两行 profile（估算 / 已确认），共 3 个保存按钮 | `:449-460`、`workbench.js:1204-1268` | 用户不知道三个预算的关系；「按量估算观察预算」「已确认按量支出预算」「预算口径」是内部词表 |
| 金额单位「分」：月预算填 `10000` 表示 ¥100；placeholder「月预算（最小货币单位」被截断 | `:452-453`、`workbench.js:1234` | 差距分析 §5.6 明令"不让用户填写 50000 分" |
| 预警阈值显示 `0.8`，标签写「%」；同页 profile 行默认 `80` | mock `tauri-mock.js:269` `warning_ratio_bp: 80` | **mock 形状错误**：后端 `warning_ratio_bp` 是万分比（`budget.rs:128` 与 ratio_bp 比较），80% 应为 `8000`。形状来源纪律再次失守 |
| 「此预算由你在本版本设置。」 | `workbench.js:1129` origin 文案 | 对用户无信息量；只有 `legacy_import` 态才值得说 |

**后端事实（决定 §4.3 方案）：** 总览预算卡读 `read_overview().budget`（`overview.rs:538` `evaluate_alert_from_sql` → 旧 `budget_config` CNY 单币），托盘文案（`lib.rs:151`）与系统通知（`budget_alerts.rs:22`）**优先读 `budget_profiles`**，profiles 为空才回落 `budget_config`。两条消费链已经分叉。Beta 发布规格 B08 规定 Beta 交付的是"按量估算观察预算"（= `estimate` profile，分币），D01 把"已确认支出预算创建"延期，第 61 行要求旧预算只读保留、不自动转口径。

### 2.3 表单与按钮无统一规则

- 全页 **10 个实心主按钮**：保存预算、保存×2、重载、保存统计时区、检查价格更新、保存保留期、查看并修改、保存账单、确认导入。总览已定"一屏一个主 CTA"，设置页全是主按钮等于没有主按钮，唯一的待办「查看并修改」被淹没。
- 三种表单排法：预算"标签在上"；profile 行"无标签只有 placeholder"，且两个 muted 文案（标题 + 「尚未配置此预算口径」）当作字段挤在同一 flex 行；账单录入 7 个字段换行后「来源说明」孤零零掉到第二行贴着「保存账单」。
- 输入框宽度四种（250 / 250 / 140 / 下拉 280）。
- 「停止读取此来源」与破坏性的「删除已导入数据」同样式并排（`workbench.js:5388-5414`）；差距分析 §5.5 要求删除进"更多/危险区"并二次确认。

### 2.4 文案密度与术语

- 页面共 **15 句**「不会上传 / 不会删除 / 不会阻止 / 不会自动推断 / 不会改变…」型免责说明；预算面板一项就有 3 句。
- 执行环境卡正面：`失败范围：1 个源 · file_missing`（原始 code 上卡面，违反总览规格 §8.3 与差距分析 §9.1）、「扫描源 12 · 最近日志」（内部术语）、脚注「扫描状态与会话查询相互独立」（实现细节）。
- 套餐确认行三个按钮「这是我的套餐 / 不是我的 / 确认计费方式」，前后两个语义重叠；标题「确认旧套餐信息」的"旧"无所指；行文「本月影响 18K tokens / 4 条事实 / 1 个会话」中"事实"是数据面词表。
- 「实际账单记录」折叠内是完整的账单录入 + CSV 导入表单——Beta D01 明确延期，差距分析 §3 要求"不显示可操作入口"。

## 3. 目标信息架构

### 3.1 分区（6 → 5）

```text
┌──────────────┬──────────────────────────────────────────────┐
│ 数据源        │  <分区 h2>                                    │
│ 计费与套餐    │  <设置项 1：标题 / 一句说明 / 控件行 / 回执>    │
│ 预算          │  <设置项 2>                                    │
│ 统计与数据    │  …                                            │
│ 关于与诊断    │                                               │
└──────────────┴──────────────────────────────────────────────┘
  左栏 sticky，宽 152px；<760px 时折成顶部横向胶囊（现有 .settings-nav 样式）
```

| 分区 | id | 内容 | 与差距分析 §3 的差异 |
|---|---|---|---|
| 数据源 | `settings-sources` | 来源状态列表、需要恢复的来源、其他本机位置、暂停同步 | 无 |
| 计费与套餐 | `settings-billing` | 待确认套餐（唯一主 CTA）、当前计费声明、重算状态、已有账单（只读） | 账单录入/CSV 按 D01 隐藏 |
| 预算 | `settings-budget` | 按量估算观察预算（唯一表单）、通知与静默、旧预算迁移提示、已确认支出预算（只读，若存在） | 无 |
| 统计与数据 | `settings-data` | 统计时区、价格目录（只读版本）、本地保留期、导出当前月摘要 | **合并**「价格与显示」+「隐私与数据」：Beta 隐藏价格在线更新后，「价格与显示」只剩时区一项可编辑，独立成区没有意义 |
| 关于与诊断 | `settings-about` | 版本对照表、脱敏诊断包、检查更新、发布页 | 无 |

分区顺序按首次使用路径（先有数据 → 再定计费 → 再设预算），与差距分析 §3 一致。总览的深链（`openSettingsSection(sectionId, focusId)`）落到分区 h2 并聚焦目标控件，分区 id 是合同的一部分：`settings-billing` / `settings-budget` / `settings-sources` 保持现名，`settings-display` + `settings-privacy` 合并为 `settings-data`。

### 3.2 页头

删除 eyebrow、H1、副标。页头只剩左栏导航；主栏第一个元素就是第一个分区的 h2。理由：tab 已经写着「设置」，页面不需要再介绍自己。

### 3.3 三层结构

| 层 | 元素 | 样式 | 数量约束 |
|---|---|---|---|
| 分区 | `section.settings-section > h2` | 16px/600，下方 12px；分区之间 32px 空白 + 1px 分隔线，**不再用边框盒** | 5 |
| 设置项 | `div.setting > .setting-head`（标题 13px/600 + 说明 12px muted）+ `.setting-body` | 设置项之间 20px；同分区内用 1px 淡分隔 | 每分区 ≤ 5 |
| 控件行 | `.setting-body` 内的 `.form-row` / 列表 / 状态行 | 见 §5 | — |

`<details>` 只允许用于"次要诊断信息"（执行环境卡的完整路径、关于页的版本 JSON），不允许用于藏一整个表单。

## 4. 各分区规格

### 4.1 数据源

**目的：** 看清每个执行环境是否在正常读取、最近一次读到什么时候；需要时恢复、暂停、添加位置。

**4.1.1 来源列表**（替换现有 `src-cards` 大卡）

每个执行环境一行摘要，展开才看细节：

```text
Codex               ● 已连接    8 个会话 · 最近记录 09/13 21:00           [立即同步]  ▾
Claude Code         ● 需要处理  3 个会话 · 最近记录 09/13 20:00 · 读取失败  [重新同步]  ▾
DeepSeek Harness    ● 已连接    2 个会话 · 最近记录 09/13 21:30           [立即同步]  ▾
WorkBuddy           ○ 未检测到  实验支持                                    [扫描并接入] ▾
```

| 字段 | 来源（`data_source_status().sources[]`，形状出处 `crates/agent-vitals-runtime/src/mcp/mod.rs:488-499`） | 规则 |
|---|---|---|
| 名称 | `harness` → `HARNESS_DISPLAY` | WorkBuddy 追加「实验支持」灰标（差距分析 §5.5） |
| 状态点 + 词 | `connection_state`：connected→已连接 / needs_attention→需要处理 / paused→已暂停 / excluded→已停止读取 / not_detected→未检测到 / 其他→状态未知 | 颜色只在 needs_attention 用 danger，paused/excluded 用 muted，不用 warn 黄（暂停是用户选择，不是警告） |
| 会话数 | `import_scope.sessions` | 0 且 not_detected 时显示「尚未导入」，不显示「0 个会话」 |
| 最近记录 | `log.last_event_at_ms` → `MM/DD HH:MM` | null → 「尚无记录」。**与「最后成功同步」分开**（差距分析 §5.5）：同步时间显示在列表顶部一行，记录时间在每行 |
| 失败摘要 | `failed_scope.sources > 0` → 「读取失败」 | 原始 `error_codes` **不上摘要行**；展开区按 §5.6 映射为人话 |
| 状态动作 | `recovery_action.{kind,label}` | 次级按钮；connected 态的「立即同步」降为文字链（差距分析 §5.5"正常时不必持续突出"） |

展开区（`▾`，`aria-expanded`）：

- 读取位置：`~/.codex` 简写，其后「显示完整路径」文字链（差距分析 §5.5：路径敏感，默认简写）；
- 导入范围：`import_scope.first_event_at_ms` – `last_event_at_ms`，「N 条记录」（用「记录」不用「事实」）；
- 扫描：`scan.source_count` 个文件 · 上次扫描 `scan.last_scanned_at_ms`（诊断级，只在展开区）；
- 失败详情：`failed_scope.sources` 个文件读取失败 · 原因（§5.6 映射）；
- 操作行：`停止读取此来源`（次级）· `删除已导入数据…`（**文字链 + danger 色**，点击后二次确认对话框显示范围摘要「将删除 N 条记录、M 个会话，不删除 Codex 原始日志」——现有 `window.confirm` 保留但文案改为带计数；计数来自 `import_scope`）。

**4.1.2 列表顶部一行**

`上次同步：成功 22:00 · 自动同步已开启   [暂停自动同步]` —— 把现有 `src-toolbar` + `sync-row` + `src-banner` 三行合成一行；失败时这一行变为 `.notice.danger`（复用总览的 `.notice` 组件）：「部分来源读取失败：Claude Code。其他来源已继续同步。」并把该执行环境行排到列表最前。「重载」按钮删除——切换 tab 已经懒加载，且列表顶部同步行的时间戳已经回答"是不是新的"。

**4.1.3 其他本机位置**

保留现有表单（工具下拉 + 目录 + 选择目录 + 添加并同步），说明压缩为一句：「选择包含该工具数据目录的文件夹，例如含 `.claude` 的用户目录。」原两句（"添加后会在下一次同步读取；不会上传内容"、"只能添加现有的绝对路径；可随时移除配置…"）删除，移除操作旁保留 hover 提示「移除不删除已导入数据」。已添加位置列表沿用 `src-custom-list`。

**4.1.4 删除**

分区脚注「共 3 个数据源 · 扫描状态与会话查询相互独立。」整行删除。

### 4.2 计费与套餐

**目的：** 处理待确认的套餐，查看当前生效的计费声明和重算状态。

| 设置项 | 内容 | 规则 |
|---|---|---|
| 待确认套餐 | 现有 `settings-billing-candidates` 横幅 + `ov-billing-review-panel` | 横幅是**全页唯一实心主按钮**「查看并处理」；无候选时整项隐藏（不显示"没有待确认项"占位）。点击后候选列表**就地展开在横幅下方**（不再是独立 panel + 「收起」按钮），标题改为「待确认的套餐」（去掉"旧"） |
| 候选行 | `openai · 20.00 USD/月 · 自 2026-09-01 起 · Codex` 第二行 `本月涉及 18K tokens · 1 个会话` | 去掉「4 条事实」；按钮改为两个：`是我的套餐`（次级）· `不是`（文字链），并在行尾加文字链 `改为其他计费方式…` 打开 `ov-billing-declaration-panel`——三按钮并列改为"二选一 + 例外入口"，消除「这是我的套餐」与「确认计费方式」的语义重叠 |
| 当前计费声明 | `ov-billing-declarations-panel` | 说明压缩为「撤销后受影响用量恢复为按量/未定归类，历史记录保留。」 |
| 重算状态 | `ov-billing-recalculation-panel` | 无任务时整项隐藏；有失败任务时用 `.notice.warn` + 「继续重算」次级按钮 |
| 已有账单 | 新增只读列表（`harness_bills_for_period`） | Beta D01：**不渲染录入表单与 CSV 导入**（现有 `ov-billing-record-panel` + `.billing-csv` 整段 `hidden`，DOM 保留供正式版）；有账单时列出「执行环境 · 服务商 · 账期 · 金额 · 来源」，无账单整项隐藏。发布规格第 61 行：已有账单保留原币与口径可查看 |

`ov-billing-declaration-panel`（确认计费方式表单）保持现有字段，但改为**从候选行或声明行触发的内联表单**，不是常驻 panel。

### 4.3 预算

**目的：** 设一个观察预算，收到接近/超出提醒；一个表单，一个保存。

**4.3.1 唯一表单：按量估算观察预算**

对应 `budget_profiles` 的 `estimate` profile（B08、REQ-035/037）。标题用用户语言「预算（订阅 + 按量）」，说明一句：「本月『订阅月费按已过天数摊派 + 按量费用（账单优先，否则按官方价估算）』达到阈值时提醒你。」（2026-09-17 修订：此前写「按量费用预算……订阅月费不计入」，但 `budget_profiles_status_sql_at` 的 `total_spent_minor` 自同日起已含订阅摊派，标题与数字打架——用户把 ¥1458.5 读成纯按量。口径见 `docs/ATTRIBUTABLE_WASTE.md` §6.7。）

```text
预算（订阅 + 按量）
本月「订阅月费按已过天数摊派 + 按量费用（账单优先，否则按官方价估算）」达到阈值时提醒你。

币种  [CNY ▾]   月预算  ¥ [ 100.00 ]   日预算（可选）  ¥ [        ]
提醒阈值  80% 和 100% 各提醒一次                      [保存]   已保存 22:01
```

| 字段 | 输入 | 存储 | 校验 |
|---|---|---|---|
| 币种 | CNY / USD | `currency` | — |
| 月预算 | 货币单位，两位小数，前缀符号随币种 | `monthly_minor = round(元 × 100)` | 正数；空 = 停用（REQ-034 默认未设置） |
| 日预算 | 同上，可选 | `daily_minor` 或 null | 正数或空 |
| 提醒阈值 | **只读文字**「80% 和 100% 各提醒一次」 | `warning_ratio_bp = 8000`（固定） | REQ-037：阈值默认 80%/100%，"启用前可见"——Beta 不提供自定义输入，去掉一个字段 |
| 保存 | 次级按钮 | `save_budget_profile({profile_id:"estimate", …})` | 回执行内显示「已保存 HH:MM」；保存后 `wbPull` 刷新总览预算卡 |

**4.3.2 通知与静默**

设置项「提醒」：开关「达到阈值时发送系统通知」（REQ-039：用户开启时才申请权限；`save_budget_profile` 返回的 `notification_permission` 非 Granted 时在开关下方一行说明「系统通知未授权，可在系统设置中开启」）。其后一行：`本周期已静默至 09/30 · [恢复提醒]` 或 `[本周期静默提醒]`（`snooze_budget_current_period` / `clear_budget_snooze`，两个按钮改为按状态只显示一个）。

**4.3.3 旧预算与已确认支出预算（只读）**

- `budget_config` 存在且 `origin === "legacy_import"`（`budget_config_origin`）时，在表单上方显示 `.notice.todo`：「检测到旧版预算 ¥100/月。它仍在生效；保存上面的预算后将以新预算为准。」——发布规格第 61 行：不自动转换、不重置。
- `budget_profiles` 中存在 `confirmed` profile 时，在表单下方显示只读行「已确认支出预算：CNY ¥500/月 · 本月已用 ¥xx」（D01：不提供创建/编辑入口，已有的可查看）。
- 现有 `ov-budget-monthly-input / daily / warning` 三个 `budget_config` 输入框与「保存预算」**从 UI 移除**（DOM 保留 `hidden`，Rust 命令 `save_budget_config` 保留供旧数据兼容与测试）。

**4.3.4 消费方切换（§8 D1，需总览接入规格配合）**

总览预算卡与本表单必须读写同一份配置。现状：卡读 `budget_config`，表单（本规格）写 `estimate` profile——**不切换消费方就是维护第二套配置**（README「不可并行的边界」第 1 条）。方案：总览预算卡改读 `read_overview().budget_profiles.profiles[profile_id="estimate"]`（DTO 已存在，`overview.rs:356`；托盘 `lib.rs:151` 与通知 `budget_alerts.rs:22` 已经这样读），字段 `spent_minor / monthly_minor / level / currency`；`budget_profiles` 为空时回落 `budget`（旧 `budget_config`），与托盘同一回落顺序。总览接入规格 §4「预算卡」一行随本规格同步修订。

### 4.4 统计与数据

| 设置项 | 控件 | IPC | 说明（一句） | 变更 |
|---|---|---|---|---|
| 统计时区 | 下拉：「跟随系统（Asia/Shanghai）」+ 常用 IANA 列表 + 「其他…」文本输入 | `statistics_timezone_config` / `save_statistics_timezone_config` | 「决定"今天 / 本月"的边界；不改变记录时间和供应商计价时区。」 | 差距分析 §5.6：不要求手输 IANA；示例行「Asia/Shanghai、America/Los_Angeles…」删除 |
| 价格目录 | 只读一行：`内置价目 catalog_2026_09 · 覆盖 N 个模型 · 随测试版更新` | `public_pricing_catalog_status` 只读 | — | 差距分析 §4「公共价格目录检查 → Beta 延期，隐藏可操作入口」：网络开关与「检查价格更新」按钮 `hidden`，DOM 保留 |
| 本地保留期 | 数字 + 「个月」，默认 13 | `retention_config` / `save_retention_config` | 「过期记录在下一次本机维护时清理；不影响执行环境原始日志。」 | 去掉「可设置 1–60 个月」独立行，改为输入框 `min/max` + 校验失败时行内提示 |
| 导出当前月摘要 | `预览导出字段`（次级）→ 展示字段清单 + `下载 CSV`（次级） | 现有 | 「只含执行环境、服务商、用量与金额口径，不含会话正文和路径。」 | 保持 |

### 4.5 关于与诊断

| 设置项 | 内容 | 变更 |
|---|---|---|
| 版本 | **常显**四行表：App / CLI / 数据库 schema / 价格目录（`about_diagnostics`；REQ-003、B11） | 现在藏在 `<details>查看版本与同步状态</details>` 里，是 B11 的必交项，不能折叠 |
| 诊断 | `保存脱敏诊断包`（次级）+ 一句「不含会话正文、绝对路径和账户标识，不会自动上传。」 | 保持 |
| 更新 | `检查新版本`（次级）· `查看发布页`（文字链） | 三个并排次级按钮减为一按钮一链接 |

## 5. 通用表单规则

### 5.1 布局

- 标签一律在控件上方（`label > span + input`），字号 12px muted；不使用 placeholder 当标签。
- 控件宽度三档：金额/数字 **140px**、下拉 **160px**、文本/路径 **弹性到 420px**。同一行内控件基线对齐，行内 gap 12px，换行 gap 10px。
- 一个设置项只有一个保存按钮，位于控件行末尾；回执文字紧跟按钮右侧（`已保存 HH:MM` / 错误一句），不再用独立的 `.billing-preview` 状态块（保留 class 用于多行结果如导出预览）。
- 表单在 <760px 时控件纵向堆叠（现有媒体查询保留）。

### 5.2 按钮层级（与总览规格一致）

| 层 | 样式 | 允许的用途 |
|---|---|---|
| 主 | `.btn`（实心） | 全页 ≤ 1，且只用于**待办**（待确认套餐） |
| 次级 | `.btn.secondary` | 保存、同步、预览、导出、检查更新 |
| 文字链 | `.chip-link` / `button.card-link` | 显示完整路径、去发布页、不是、改为其他计费方式… |
| 危险 | `.btn.secondary.danger` 或 danger 色文字链 | 删除已导入数据、撤销声明；必须二次确认，确认框含范围计数 |

### 5.3 单位

金额输入一律**货币主单位**（元/美元）两位小数，前缀符号随币种（`¥` / `$`）；存储与 IPC 仍是 minor。百分比一律整数 + `%`；万分比只存在于 IPC。任何面向用户的标签不得出现「分」「最小货币单位」「bp」。

### 5.4 校验与回执

- 校验在提交时行内显示，消息一句、指向字段（`aria-describedby`），焦点回到首个错误字段；
- 提交按钮在进行中 `disabled` + 文案「保存中…」，成功后回执 `已保存 HH:MM`（`localStamp` 同款格式），失败显示 `errText(e)`；
- 保存成功后触发 `wbPull` 刷新总览相关区块（总览规格 §6.3「设置保存后」）。

### 5.5 说明文案

- 每个设置项 ≤ 1 句、≤ 40 字；
- 「不会上传 / 不会删除 / 不会阻止」类承诺：合并进那一句或移到 hover `title`；隐私总承诺在关于页统一说一次；
- 禁用词（正文）：事实、口径、执行环境（改"工具"）、扫描源、fact、facts、bp、minor、profile、legacy、schema（版本表除外）、reason code 原文。

### 5.6 reason code 映射

`failed_scope.error_codes[]` 与 `sync` 错误码通过一张表转人话，未知码统一「读取失败」并把原码放展开区 `title`：

| code | 文案 |
|---|---|
| `permission_denied` / `permission` | 没有读取权限 |
| `file_missing` | 找不到日志文件 |
| `all_files_failed` | 所有日志文件都读取失败 |
| `db_error` | 本地数据库出错 |
| `migration_failed` | 本地数据库需要迁移 |
| 其他 | 读取失败 |

**已核对：** 生产 `sql_sync` 目前**不写** `source_files.last_error_code`（只有 schema 与测试写 `permission_denied` / `permission`；`file_missing` 只出现在 mock）。映射表先按已知词表实现，无 code 时也走「读取失败」路径。这一项应作为总览规格 §8.3 `ERR_TEXT` 的扩展，同一张表。

## 6. 视觉规格

- 页面网格：`grid-template-columns: 152px 1fr; gap: 32px`；左栏 `position: sticky; top: 12px`；导航项 12px，当前分区（IntersectionObserver）高亮 accent 左边线。
- 分区：无边框盒；h2 16px/600；分区间 `margin-top: 32px` + `border-top: 1px solid var(--panel-2)`。
- 设置项：`.setting-head` 标题 13px/600 + 说明 12px muted；`.setting + .setting { margin-top: 20px; padding-top: 16px; border-top: 1px solid color-mix(panel-2, 50%) }`。
- 执行环境行：高 44px（可点击目标 ≥ 44px，E308），展开区缩进 16px、背景 `var(--panel)`。
- 删除 CSS：`.page-intro`、`.eyebrow`（总览已不用，设置页头删除后无消费方）、`.settings-section` 边框、`.settings-primary-action`（横幅改用 `.notice.todo`）、`.deferred-feature`、`.src-toolbar`、`.sync-row`。
- 主题：所有新颜色走现有 token（`--panel/--panel-2/--muted/--accent/--warn/--danger`），不引入 `--text-1` 一类未定义变量（总览事故）。

## 7. IPC 映射与 mock 修正

| 分区 | 读 | 写 | 形状出处 |
|---|---|---|---|
| 数据源 | `data_source_status`、`sync_request_status`、`sync_pause_state`、`source_read_locations`、`custom_source_roots` | `trigger_sync`、`set_sync_paused`、`set_source_harness_excluded`、`delete_imported_source_data`、`pick_custom_source_root`、`add_custom_source_root`、`remove_custom_source_root` | `mcp/mod.rs:450-500` |
| 计费与套餐 | `billing_import_candidates`、`billing_candidate_impact_preview`、`billing_declarations`、`billing_recalculation_jobs`、`harness_bills_for_period`（只读） | `resolve_billing_import_candidate`、`save_billing_declaration_revision`、`revoke_billing_declaration`、`enqueue_billing_recalculation`、`retry_billing_recalculation` | 现有 |
| 预算 | `budget_profiles_status`、`budget_config`（只为 legacy 提示） | `save_budget_profile`、`snooze_budget_current_period`、`clear_budget_snooze` | `runtime/budget.rs:100-152` |
| 统计与数据 | `statistics_timezone_config`、`public_pricing_catalog_status`、`retention_config` | `save_statistics_timezone_config`、`save_retention_config`（导出为前端生成） | `lib.rs:1687-1860` |
| 关于与诊断 | `about_diagnostics` | `export_diagnostic_package`、`check_for_updates`、`open_trusted_releases_page` | `lib.rs:2038` |

Beta 内不再从设置页调用：`save_budget_config`、`save_harness_bill`、`save_harness_bills`、`delete_harness_bill`、`save_public_pricing_catalog_policy`、`update_public_pricing_catalog`（命令保留，UI 入口隐藏）。

**mock 修正（`tauri-mock.js`，每条注明出处）：**

1. `budget_config.warning_ratio_bp: 80` → `8000`（`runtime/budget.rs:128`）；
2. `budget_profiles_status` 返回一条 `estimate` profile 样例（字段 `profile_id/currency/monthly_minor/daily_minor/warning_ratio_bp/spent_minor/level`，出处 `budget.rs:140-152`），否则新表单在 Vite 里永远是空态；
3. `data_source_status` 补 `workbuddy` 一行 `not_detected`，`error_codes` 用生产词表 `permission_denied`（`mcp/mod.rs:716`）而非 `file_missing`；
4. 未知命令 `default:` 必须 `throw`（总览规格 §8.2.6）。

## 8. 需要拍板的决定

| # | 决定 | 建议 | 影响 |
|---|---|---|---|
| D1 | 总览预算卡读哪份配置 | 改读 `budget_profiles.estimate`，空时回落 `budget_config`（与托盘/通知同序） | 修改 `renderSpendCards` 预算段 + 总览接入规格 §4；否则设置页写的预算总览看不到 |
| D2 | 分区 6 → 5（合并价格与显示 + 隐私与数据为「统计与数据」） | 合并 | 差距分析 §3 的六分区表述随本规格更新；`openSettingsSection` 的 `settings-display`/`settings-privacy` 深链改指 `settings-data` |
| D3 | 账单录入/CSV、`budget_config` 表单、价格在线更新在 Beta 隐藏 | 隐藏（DOM 保留 `hidden`，命令保留） | 发布规格 D01、差距分析 §3 已定，本规格只是落实 |
| D4 | 阈值自定义输入 | Beta 不提供，固定 80%/100% 只读展示 | 少一个字段；正式版如需自定义再加 |

## 9. 验收

### 9.1 结构守卫（扩展 `scripts/verify-workbench-visibility.mjs`，切到设置 tab 后断言）

- 可见实心 `.btn` ≤ 1，且若存在其文本为「查看并处理」；
- 左栏导航 5 项，`href` 与 5 个 `section.settings-section[id]` 一一对应，导航文本 == 对应 h2 文本；
- 可见文本不含：`分）`、`最小货币单位`、`bp`、`事实`、`口径`、`扫描源`、`file_missing`、`permission_denied`、`legacy`、`profile`；
- `#ov-billing-record-panel`、`.billing-csv`、`#ov-pricing-catalog-network`、`#ov-pricing-catalog-update`、`#ov-budget-monthly-input` 均 `hidden`；
- `#ov-about-versions` 可见且不在闭合 `<details>` 内；
- 阈值文字含「80%」且页面无值为 `0.8` 的可见输入；
- 每个执行环境行高度 ≥ 44px；`删除已导入数据` 不在摘要行内。

### 9.2 vm 单测（`scripts/verify-workbench-kpi-decide.mjs` 同款）

- 金额输入 `100.00` → `save_budget_profile` 收到 `monthly_minor: 10000`；输入 `0` / 空 → 不发送或 `monthly_minor: null`（停用）；
- `warning_ratio_bp` 恒 8000；
- `budget_config.origin === "legacy_import"` → 渲染 legacy 提示；`user` → 不渲染；
- `error_codes: ["permission_denied"]` → 展开区文本「没有读取权限」，摘要行不含 code；未知码 → 「读取失败」；
- `budget_profiles` 空 + `budget_config` 有值 → 总览预算卡仍显示（D1 回落）。

### 9.3 真机（`.app`）

按发布规格 T07/T09/T11/T13：时区改动后日界重算、预算 80%/100% 首穿通知与静默、保留期修改持久、200% 字号与 1024×700 下左栏与表单无遮挡、键盘可完成保存与展开。

## 10. 实施顺序

| 步 | 内容 | 依赖 |
|---|---|---|
| S1 | 页头删除、左栏导航、分区 6→5、三层结构 CSS；旧 CSS 删除 | — |
| S2 | 预算：单表单 + 元单位 + 固定阈值 + legacy/confirmed 只读；mock 修正；D1 总览预算卡消费方切换 | S1、总览规格 M1.1 数据访问层（6 个设置渲染已从 `renderOverview` 移出） |
| S3 | 数据源：行式列表 + 展开区 + 同步行合并 + reason 映射 + 危险操作降级 | S1 |
| S4 | 计费与套餐：横幅就地展开、候选行二选一、账单只读、录入/CSV 隐藏 | S1 |
| S5 | 统计与数据 + 关于：时区选择器、价格只读、版本常显、按钮减层 | S1 |
| S6 | 守卫扩展（§9.1/9.2）+ 截图基线 | S1–S5 |

S2–S5 互相独立，可并行；每步结束跑 `npm --prefix apps/desktop/ui-dev run verify` + `node scripts/verify-workbench-kpi-decide.mjs`。

## 11. 偏好存储：合并为 `<data_home>/config.json`

### 11.1 现状

设置中心的配置目前分两类存储（2026-09-13 按代码核对）：

| 类别 | 位置 | 项 |
|---|---|---|
| 金额相关，与用量事实同事务 | `agent-vitals.sqlite3` | `budget_profiles` / `budget_config` / `budget_snoozes` / `billing_import_candidates` / `billing_declarations(+_revisions,+_scopes)` / `billing_recalculation_*` / `harness_bills` |
| 纯偏好，各自一个 JSON 小文件 | `state/statistics-timezone.json`（`runtime/statistics_timezone.rs`）、`state/retention-config.json`（`retention.rs`）、`state/source-controls.json`（`source_controls.rs`）、`state/custom-sources.json`（`custom_sources.rs`）、`state/sync-control.json`（`sync_control.rs`） | 时区、保留月数、停止读取的执行环境、其他本机位置、暂停自动同步 |
| 运行状态（非偏好） | `state/budget-origin.json`（迁移标记）、`<data_home>/pricing-catalog-update.json`（上次检查结果）、`<data_home>/pricing-catalog-policy.json`（联网开关，`lib.rs:1742`） | — |

划分规则从未写下来，这里写下：**影响金额计算的进库；纯偏好进文件；运行状态不是偏好。** 五个偏好文件是逐个功能加出来的，读者分散在 App（`lib.rs`/`overview.rs`）、CLI 与 MCP 控制面（`mcp/control_plane.rs:100-233`）、同步服务（`sync_service.rs`）和 Python 镜像（`agent/state.py:59` 直接读时区文件）。

### 11.2 目标

仿 Claude Code 的 `~/.claude/settings.json`（纯偏好、人可编辑、小），**不仿** `~/.claude.json`（偏好与项目历史、`lastModelUsage` 等运行状态混装、频繁整文件重写）。把五个偏好文件 + 价格目录联网开关合并为一个：

```json
{
  "schema_version": 1,
  "statistics_timezone": "Asia/Shanghai",
  "retention_months": 13,
  "sync": { "paused": false },
  "sources": {
    "excluded_harnesses": ["workbuddy"],
    "custom_roots": { "claude-code": ["/Volumes/work/.claude"] }
  },
  "pricing_catalog": { "network_enabled": false }
}
```

- 位置 `<data_home>/config.json`——根目录、与 `config.toml` 同级，**不放 `state/`**（`state/` 是程序生成的账本与缓存，偏好是用户拥有的文件）。
- 缺省值不写入文件：文件里只出现用户改过的键；`{}` 与文件缺场等价（全部默认）。
- 不进此文件：§11.1 表第一行（库）与第三行（运行状态）。`config.toml [budget]` 保持只读旧源（发布规格第 61 行，Python `agent/budget.py` 仍读它）。

### 11.3 硬规则

| # | 规则 | 理由 |
|---|---|---|
| R1 | 写入 = `acquire(<data_home>/config.json.lock)` → 重读 → 改一个键 → 写 `config.json.tmp` → rename → release；锁复用 `runtime::lease::acquire`（O_EXCL + 原子 rename 偷取，TTL 5s） | 单文件是单写点，App / CLI / MCP 控制面三方可写；五个小文件之前只是碰巧不冲突。Claude Code `.claude.json` 的并发覆盖事故是前车之鉴 |
| R2 | 整文件解析失败 → **全部键走默认** + `data-status` 报 `warnings[{code:"config_invalid"}]` + 下一次写入前把坏文件改名为 `config.json.corrupt-<unix秒>` 再写新文件，**不覆盖** | 用户手改出语法错误不能丢他的内容，也不能让一个错字把时区/保留期/来源控制一起带走 |
| R3 | 单键无效（时区不是 IANA、月数越界、路径不是绝对路径）→ 该键走默认并在 `data-status` 报 `config_key_invalid{key}`；其他键照常生效 | 保持现在逐文件的"坏一个不连坐"语义；时区例外保留现规则：无效时**不**静默切到别的时区，而是报错（`statistics_timezone.rs:44-49`） |
| R4 | 读 → 改 → 写回保留未知键 | 旧版本、用户自加字段不被新版本抹掉 |
| R5 | 读透不缓存：每次访问读盘 | 文件几百字节；用户手改后下一次操作即生效，不需要文件监听 |
| R6 | Python 镜像同一 PR 改：`state.py::_system_timezone` 改读 `config.json.statistics_timezone`，回落旧文件；`tests/test_classification.py` 与打包清单若钉文件名一并更新 | 差分门 |
| R7 | 迁移只读不删：读时先 `config.json`，键缺场再回落对应旧文件（只读）；写只写 `config.json`。旧文件保留一个版本，下一版本删除读回落 | Beta 未对外，散落文件只在开发机上；现在合并不需要用户可见的迁移 |
| R8 | `schema_version` 只在需要不兼容改动时递增；读到更高版本 → 按 R2 处理为不可用而不是猜 | 与权威库 `schema_too_new` 同一态度 |

### 11.4 实现形状

- 新增 `crates/agent-vitals-runtime/src/preferences.rs`：`Preferences` 结构 + `load(data_home) -> Loaded { prefs, problems: Vec<Problem> }` + `update(data_home, |p| …)`（R1 的锁 + 读改写）。五个现有模块（`statistics_timezone` / `retention` / `source_controls` / `custom_sources` / `sync_control`）**保留公开函数签名**，内部改为委托 `preferences`；`lib.rs:1779` 的 `write_pricing_catalog_policy` 同样委托。IPC 命令与 MCP 控制面动作签名不变，设置页与本规格 §7 不受影响。
- `data-status` 增加 `config` 段：`{ path, present, schema_version, problems[] }`。
- 测试：并发写不丢键（两线程各改一键）、坏文件不被覆盖且改名、未知键往返、旧文件回落、Python↔Rust 时区读取一致。

### 11.5 执行计划挂钩

作为 **E300：偏好存储合并** 加入执行计划 P3，依赖 E006（隔离夹具）与 E103（来源控制已接通，其存储由 E300 迁入）；E305（时区、保留期与诊断）改为依赖 E300；工作量约 1 天，不阻塞设置页 S1–S6（IPC 不变），但应在 Beta 对外之前完成，否则外部用户机器上会出现需要迁移的散落文件。
