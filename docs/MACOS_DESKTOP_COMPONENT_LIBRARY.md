# macOS 工作台组件库定义

状态：P0 基础控件与 Sessions 筛选栏已落地；主要页面操作已移至桌面标题栏。其余组件仍在迁移。2026-09-24。

## 目标与边界

工作台使用 React + Tailwind CSS v4，但视觉与交互以 macOS 桌面窗口为准。组件库负责一致的控件尺寸、状态、键盘操作和布局密度；业务数据仍由现有 Tauri bridge 与各 feature 管理。组件不得直接调用 Tauri、读取 authority 或自行推断风险与计费状态。

本轮最优先的验收问题是：同一行的文本框、下拉框和日期控件外框等高、文字基线一致；字段宽度由语义决定，换行后仍按网格对齐。背景是否透明不作为统一标准。

## 现状盘点

| 区域 | 当前实现 | 问题 | 归入组件库 |
| --- | --- | --- | --- |
| 构建 | `ui-dev/package.json` 已含 Tailwind v4；`styles.css` 引入 Tailwind；Vite 启用插件 | Tailwind 已可用，但页面主要使用全局手写 CSS | 设计 token 与组件样式层 |
| 共享组件 | `components/ui/StatusPill.tsx` | 只有状态 pill；按钮、表单、面板和表格主要靠重复 class | 共享基础组件 |
| 表单 | Sessions、Settings、Skills、Test、Usage 各自定义 input/select | 最小高度存在 34、35、36px；标签、内边距、焦点态也重复且不完全一致 | `Field`、`TextInput`、`SelectInput`、`DateInput`、`FilterBar` |
| 按钮 | `.button` 及页面变体；桌面 shell 覆盖高度/字重 | 页面变体和全局覆盖共同决定最终尺寸 | `Button`、`IconButton` |
| 页面首部 | 各页 `*-page-header`、eyebrow、h2、动作区 | 原生 toolbar 已有页名，正文有重复标题和说明 | `PageToolbar`、`SectionHeader` |
| 容器 | `info-panel`、`trust-card`、`skills-panel` 等 | 圆角、边框、阴影、padding 按页面复制；密度不一致 | `Pane`、`InsetGroup` |
| 列表 | Sessions、Test、Usage、Findings 各自绘制表格/行 | 行高、选中态、hover、空态不一致 | `DataTable`、`ListRow`、`EmptyState` |
| 状态 | pill、badge、notice、error banner 分散定义 | 语义颜色和只读/可操作状态缺少共同约束 | `StatusPill`、`InlineNotice`、`CountBadge` |

盘点时 `styles.css` 为约 700 行，`desktop-shell.css` 约 80 行。后者覆盖前者的按钮、标题、侧栏等规则，适合在迁移时收束为 token 和组件样式，但不应先整文件重写。盘点截图中的 Sessions 筛选器使用可换行 flex，计费状态落到第二行；第一批接入已改为按内容区宽度变化的网格。

## 设计 token

统一从 `react/src/styles/tokens.css` 暴露语义变量，由 `react/src/styles/components.css` 消费；Tailwind utility 可以引用同一组 token。避免在 feature CSS 中再次写入十六进制颜色或控件高度。亮色 token 已建立；暗色覆盖须随整个工作台主题一起实施，避免只有输入框切换成暗色。

| Token | 亮色初值 | 用途 |
| --- | --- | --- |
| `--ui-canvas` | `#fafafa` | 内容背景 |
| `--ui-sidebar` | `#efeff0` | 侧栏 |
| `--ui-toolbar` | `#f0f0f1` | 标题栏 |
| `--ui-surface` | `#ffffff` | 表单、列表、检查器 |
| `--ui-border` | `#dedfe2` | 分隔线与普通边框 |
| `--ui-text` | `#292d34` | 主文字 |
| `--ui-muted` | `#63748a` | 次级文字 |
| `--ui-accent` | `#087f62` | 选中、主操作、焦点 |
| `--ui-focus-ring` | `#087f62` | 键盘焦点 |
| `--ui-control-height` | `32px` | 所有常规 input/select/date/button 的外框高度 |
| `--ui-control-radius` | `6px` | 常规控件圆角 |
| `--ui-row-height` | `36px` | 紧凑列表行最小高度；多行内容自然增高 |
| `--ui-space-1/2/3/4` | `4/8/12/16px` | 页面内间距阶梯 |

窗口 toolbar 保持现有 48px。控件字体 12px，字段标签 11px，正文 12–13px，次级说明 11px；数字使用 tabular numerals。固定高度仅限定控件外框，不截断动态字体或错误信息：系统字体放大时允许控件增高，同一组控件仍要等高。暗色模式以相同语义 token 覆盖，不在组件里硬编码亮色背景。

## 组件合同

### P0：控件与筛选栏

| 组件 | 关键 props / 行为 | 视觉合同 |
| --- | --- | --- |
| `Field` | `label`, `htmlFor`, `hint?`, `error?`, `required?`, `children` | 标签统一在控件上方，间距 4px；错误文案另起行，不挤压相邻控件 |
| `TextInput` | 原生 `input` props；`invalid?` | 高 32px、圆角 6px、水平 padding 10px；保留浏览器输入法与自动填充 |
| `SelectInput` | 原生 `select` props；`invalid?` | 与 TextInput 等高、边框/文字/焦点态一致；系统原生弹出菜单 |
| `DateInput` | `type="date"` 或 `type="month"`；原生 props | 外框与其他控件等高；系统日期选择器可用 |
| `CheckboxField` | `label`, `description?`, 原生 checkbox props | 勾选目标与文字共同可点击；不强行套用 32px 文本框外观 |
| `FilterBar` | `children`, `actions?`, `density="regular"` | 网格布局；字段列宽按语义分 `short=120px`、`medium=176px`、`wide=240px`、`fill=minmax(160px,1fr)`；窄窗整列换行，禁止孤立字段漂到下一行 |
| `Button` | `variant="primary|secondary|ghost|danger"`, `disabled`, `busy?`, 原生 button props | 常规高度 32px；工具栏可用 `size="compact"` 28px；同一操作组只能使用一个 size |

表单组件不包装或改变原生 `onChange`、`value`、`name`、`id`、`type` 语义。`Field` 必须通过 `htmlFor` 与真实控件关联。异步按钮的 busy 状态保留原宽度，提供可见状态和 `aria-busy`，不把失败静默处理。

Sessions 筛选栏在可用内容宽度足够时建议列轨道为 `120px 176px minmax(160px,1fr) minmax(160px,1fr) minmax(160px,1fr) 176px`。宽度不足时，先把可选的模型、服务商和计费状态移至整齐的第二行。断点必须由筛选栏所在容器决定，因为打开会话检查器后，即使窗口很宽，列表区也会变窄；容器窄于约 900px 时改为 2–3 列，窄于约 640px 时单列。每个轨道中的控件宽度为 100%，但高度始终一致。

### P1：工作台结构

| 组件 | 责任 | 约束 |
| --- | --- | --- |
| `PageToolbar` | 当前页动作、刷新与状态 | 窗口 toolbar 已显示页名时，正文不再重复大标题；保留可访问的隐藏 h1 |
| `SectionHeader` | 区块名称、计数和局部动作 | 标题层级稳定；说明仅在帮助理解决策时常显 |
| `Pane` | 主内容区与检查器表面 | 统一边框、圆角和 padding；紧凑桌面列表不叠加大阴影 |
| `InsetGroup` | 设置中的相关字段组 | 同组字段共享列宽与间距 |
| `SummaryStrip` | 会话/用量等少量窗口数字 | 紧凑单行，允许窄窗换行；单位写在数值旁或下方，不把长免责声明推到最右侧 |
| `DataTable` | 排序/分页之外的通用表格壳 | 统一表头、行间距、选中、键盘焦点、横向溢出；业务列内容留给页面 |
| `ListRow` | 选择行与操作行 | 明确按钮/链接语义；不要给 `<tr>` 添加 `role="button"` 后丢失表格语义 |
| `EmptyState`、`InlineNotice` | 空、加载、错误、部分可用状态 | 文案准确说明当前状态与下一步操作；可恢复错误提供重试 |

`StatusPill` 继续使用现有组件，迁移到统一 token。颜色只辅助文字，不独自表达成功、警告或错误。`DataTable` 不接收任意 authority 原始行；页面先通过现有安全 DTO 形成展示列。

## Tailwind 与 CSS 的分工

- Tailwind 用于页面级 grid/flex、响应式列数、间距与简单排布。
- token 和组件 CSS 负责控件尺寸、状态、平台细节与稳定的表格密度。组件根节点使用 `av-` 前缀，避免与现有 `.button`、`.sidebar` 等全局类冲突。
- feature CSS 仅负责业务布局与特殊可视化；新 feature 不复制 input/select/button 的边框、padding、高度和焦点规则。
- 不引入新的外部组件库。当前 React/Tailwind 依赖足以建立这套薄组件层。

## 迁移顺序与验收

1. 增加 token、P0 组件和独立预览页，先覆盖 text/select/date/checkbox 的正常、焦点、禁用、错误与加载状态。
2. 将 Sessions 筛选栏迁移为 `FilterBar`，处理截图中的字段换行和不等高；保持现有筛选值、服务端查询、分页与 sessionStorage 行为。
3. 迁移 Settings、Skills、Test、Usage 的表单。每迁移一页就删除该页重复控件规则，防止全局 CSS 与新组件互相覆盖。
4. 再迁移页面首部、摘要、面板和表格。逐页验证语义和行为后删除旧类；不得一次删除仍被其他页面使用的样式。

验收窗口为 640×480、760×560、1100×760 和宽屏；在 macOS 系统默认字体尺寸及放大文字下观察。检查同一操作组的控件外框高度、标签和文字基线，筛选项换行顺序，键盘 Tab/Shift+Tab、焦点、原生日期选择、禁用/错误状态、VoiceOver 标签，以及亮色/暗色显示。React 构建与 TypeScript 检查通过后，还需从 `.app` 启动做真机截图；Vite 预览不能代替原生窗口验收。

## 当前实现进度

- 已建立 `Field`、`TextInput`、`DateInput`、`SelectInput`、`FilterBar`、`Button` 和亮色 token；Sessions 筛选栏与刷新/加载按钮已接入。
- 未迁移页面的 input/select/textarea 外框由桌面样式层临时统一；各页面原有规则仍在，后续迁移时按页删除。checkbox/radio/file/range/color 控件保留各自原生尺寸。
- Sessions 页缩短了重复首部、摘要条和表格行间距。Settings、Skills、Test、Usage、Trust 等页还没有迁移为共享 React 组件。
- `ToolbarActions` 通过 React portal 将页面自有的筛选、刷新和扫描入口呈现在窗口标题栏；不提升业务状态到 App 壳层。用量、会话、发现、测试、Trust、Skill、设置已接入。窗口宽度不超过 700px 时，操作退回正文首行，避免遮挡系统窗口控件。Skill 的快照、对比和导出留在扫描结果区，避免把标题栏塞满。
- `CheckboxField`、P1 结构组件、暗色主题和真机视觉验收仍待完成。组件落地进度与 Tailwind 依赖状态分别记录。

本轮验证：`npm run verify:react`（生产构建、TypeScript 和 React bridge 契约）通过；Vite mock 的 1400×900 截图中，Sessions 的六个筛选控件同高且在一行，760×560 截图中按两列整齐换行，标题栏与正文不再重复显示“会话”。尚未把此版本安装到 `.app` 做原生窗口验收。
