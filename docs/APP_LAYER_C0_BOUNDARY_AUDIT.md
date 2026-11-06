# C0：独立 City 边界与现有依赖核对

日期：2026-10-03。依据应用层规格 v0.2；机器可读入口见
`app-layer-inventory-v1.json`。本清单描述当前源码及目标职责，不表示生产能力已实现。

## 已冻结的首发边界

第一消费者为官方独立 Tauri City；macOS 为首期平台。固定宿主 H 验证两个
独立签名版本 C1/C2 的安装、真实取数、更新、回滚、卸载与重装。默认素材随
City 包分发。第二应用、素材市场、社区应用及跨平台不进入 M0–M2。

宿主管理 authority、查询、脱敏、安装台账、grant、包与进程身份和 broker。
City 管理 UI、TS 运行时模型、城市规划、Three.js、seed/镜头偏好及本机导出。
City 的请求不包含任意 SQL、宿主命令、文件路径或字段选择。钻取由 opaque
句柄请求宿主展示；City 不接收原始 SessionRow 或读取宿主日志。

## 当前入口与迁移要求

| 当前入口 | 已确认的行为 | 迁移要求/归属 |
| --- | --- | --- |
| cityData.ts | readSessions/readFindings/readStatisticsTimezone；每页500、主装载4500，截断补抓最近两天 | query 提供 city:v1 摘要与 snapshot cursor；分页及补抓同快照；覆盖数和缺失状态显式返回 |
| cityData.ts | 时区读取失败采用浏览器时区；findings失败返回空数组；session失败构建空模型并带error | C3/C4 定义 freshness/unknown；不可将失败解释为零或无异常；时窗口径由宿主给出 |
| cityModel.ts | 纯TS建模，Map保存SessionRow；session_ref同时决定楼宇id与seed | DTO与运行时Map拆开；使用安装作用域稳定opaque id；模型和规划仍留TS |
| CityPage.tsx | 导入SessionDetail显示会话详情，间接调用sessions_read | City保留统计选择；原始详情由宿主打开，C6登记UI裁剪对比 |
| citySeed.ts / Rust city_seed_config | 读取命令可能初始化state/city-seed.json；set/reset写宿主状态；浏览器用localStorage | seed归应用私有状态；旧seed仅显式迁移；projection.read无副作用 |
| CityPage.tsx / CityEngine.ts | film/photo生成Blob，用下载anchor导出webm/png | 保留生成行为；独立native桥用用户文件选择器，导出不上传且卸载不删除 |
| tauri.ts / CityLoader | 共享宿主invoke封装与失效事件门，轮询受页面可见性限制 | SDK只开放授权projection/control；失效序号、重连、取消与权限检查由C5实现 |
| lib.rs heavy_read_gate | 宿主重查询统一ReadGate(2)，blocking查询与memo | broker同宿主进程复用该gate；独立MCP不宣称共享跨进程缓存/许可 |

City现有模型统计依赖已加载rows；不能把加载上限内的token之和冒充全窗总量。
C3须明确全窗统计、已返回数、渲染聚合数以及未知时间的语义。当前时间轴包含
Date.now和本地午夜运算；迁移对比必须固定as_of_ms和统计时区。
findings只取findings_groups_safe首50组，不跟进游标，也不按City窗口筛选；
新投影必须登记异常覆盖与时间范围。空sessions首页目前complete=false且不再发终态，
错误降级及这些现有缺陷需要修正，不作为必须保留的正确语义。
选中楼宇面板当前显示model_ids、费用状态与时长；C3须逐字段决定脱敏保留或
明确裁剪并登记行为差异，不能仅保token后宣称全部交互等价。
app-event与窗口删除事件不能整体转发给City；broker只交付有序号的失效通知。
多宿主截断时district.sessionCount存在复用全窗totalSessions的分支；C4须按
执行环境真实计数定义harness_summaries，不把这项旧行为冻结为正确口径。C6移植还要
处理共享i18n、harnessNames、costSummary和UI controls；它们是源码依赖，不授予
broker数据权限。

## 可复用与独立实现

扩展revision/generation、预览确认、ObjectStore与发布检查是参考原语；
JSON-only对象库不安装.app。应用需要独立台账、包对象、签名规范、平台验证、
安全解包、grant和恢复状态；数据扩展的origin不为应用授信。
现有app-local projection、broker、SDK、应用安装器均未实现。

## 网络与本机取数政策登记

本分支桌面lib.rs包含pricing-sync、fx-sync、manifest index、
release API请求；原AGENTS网络清单漏记FX和已开发manifest通道，本轮补齐。
新增政策允许显式opt-in官方应用索引/签名包下载，并独立约束安装许可和数据许可。
只授权固定公共下载，不授权上传；City不能后台联网或直读authority/宿主日志。
平台身份、签名和沙箱实测通过前，只允许脱敏fixture连接，不发放真实数据会话。
尚未增加应用网络请求或修改当前取数/seed行为。

### 隔离分支基线

codex/app-layer-city从本地main的564c6726c7194fd72ab42051ed510c80061ca4d7
创建。应用层四件文档从原工作区迁入；AGENTS/扩展规格/扩展计划仅重放C0边界
修订，未复制扩展安装器、网站或City运行代码的未提交改动。原工作区C0测试是
历史证据，不能直接作为新分支基线；新分支重新验证后单独登记。

2026-10-03新分支复验：City全部守卫、React typecheck与build通过。
main的verify:city脚本引用了未跟踪的verify-react-city-infrastructure.mjs；
经审阅，仅迁入这一基线检查脚本（实际执行生产桥梁方法并检查布局），
没有迁入City运行时代码。Three.js CJS弃用和大chunk提示仍为已知告警。
## M0 下一步与证据

C1冻结签名规范、manifest/index及目标物理路径；C3并行冻结projection schemas、
opaque identity和snapshot语义。C2用实际.app验证身份、沙箱与IPC；不可用时
登记真实阻断，不能把签名或同UID当成完整权限验证。

现有city守卫与build/typecheck提供迁移基线，其覆盖不包含独立应用签名、沙箱、
broker或生命周期。C0验收只证明边界清单及政策/规格对齐，G01–G12仍未完成。

本轮运行结果：npm run verify:city全组通过；npx tsc -p react/tsconfig.json
--noEmit通过；npm run build:react通过（有既存大chunk提示）。签名、IPC及OS限制
尚未测试。未修改City运行时代码或刷新golden。
独立subAgent已复核源码入口、政策、inventory和测试证据，C0限定验收通过；
发现的跨计划任务范围引用已由C0–C12修正为C0–C13。
