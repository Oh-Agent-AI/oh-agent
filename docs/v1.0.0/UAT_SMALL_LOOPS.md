# v1.0.0 小闭环阶段性 UAT 清单

> 目标：对一轮 Loop 交付的**小闭环**做用户可走通的验收（AC 锚点），随 loop 滚动验证，不等整阶段完成。**不替代**阶段退出条件：每阶段完整出口（全部 REQ + 真实演练 + 发布门禁）仍然按 PRD 执行。
>
> 用法：`cd apps/desktop/src-tauri && cargo tauri dev`，用真机数据（`~/.agent-vitals` 当前 schema v12）。每条走通后更新状态 `[ ]→[x]`，留一句观察；失败则返回代码修复，不勾 REQ。
>
> 记录格式：在 `V1_0_0_LOOP_LOG.md` 对应轮追加一行 `UAT: AC0x walked ✔/✘ + 一句发现内容`。

## 执行顺序与勾选纪律

本清单是 v1.0.0 的**验收轨道**，不改变“完成全部 PRD + 阶段出口 + 发布门槛”的总目标。按下列批次串行执行；每项通过只证明该小闭环，不能单独勾选完整 REQ 或 AC。

1. **来源与数据可信度**：AC23 → AC02（子集）→ AC15 → AC10。
2. **低压力计费状态**：AC26 → AC28。
3. **声明与重算**：先运行 Codex 归因 replay 回填并确认质量状态收敛，再执行 AC27 → AC13 → AC14。
4. **提醒**：AC19（需独立可控的预算阈值与通知观察环境）。

每项都须满足本机桌面路径、CLI 对拍、MCP 对拍和失败态检查，并在循环日志留存 `UAT: AC0x walked ✔/✘`。没有真机证据即保持未勾选。

## 通用门槛（每条 UAT 通过都必须满足）

- 用户路径**无终端**走通：总览/会话/菜单栏可见预期结果。
- 金额/覆盖/状态在**菜单栏、总览、日历、会话、CLI、MCP** 同源一致，不出现两处不同。
  - CLI 对拍：`agent-vitals data coverage|daily --json`。
  - **MCP 对拍（不可用 CLI 代替）**：`agent-vitals data-mcp serve` 走 stdio JSON-RPC；
    至少调 `usage_hourly {date, group_by}` 与 `data_status`，与 CLI 同窗口数字核对。
    注意：MCP 是独立进程 + 独立序列化面（`session_ref` 脱敏、只读 SQL 白名单都在该层），
    CLI 通过不代表 MCP 通过。未注册到客户端时用 `printf ... | agent-vitals data-mcp serve`
    手工握手验证（见下方命令模板）。
  - 已实测基线（2026-09-12）：MCP `usage_hourly` 与 CLI `data daily` 在 2026-09-10 逐位相等
    （codex 310,823,371 / claude-code 105,495,143）。

```bash
# MCP 手工握手模板（无需注册）
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"uat","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"usage_hourly","arguments":{"date":"2026-09-10","group_by":"harness"}}}' \
 | agent-vitals data-mcp serve
```
- 失败态不冒充成功：不可读→Unavailable/未计价，绝不显示 ¥0/绿色安全。

---

## 1. 单执行环境读取失败隔离【Loop 1】→ AC15

- **路径**：构造一个真实读取失败（不可读目录、损坏日志或权限阻塞）→ 回到总览 → 手动同步。**不要**用“停止读取”替代失败注入：它应显示为“已排除”，不是 `failed_scope`。
- **期望**：其他执行环境照常刷新；横幅明说「部分来源读取失败/暂停」；受影响执行环境卡显示 failed_scope 具体错误码。
- **对拍**：`data coverage --json` 中受影响执行环境 freshness 非骗"fresh"。
- **UAT 记录**：`UAT: AC15 walked ✔`；修复后以隔离 HOME 注入目录级 `Permission denied`：CLI `EXIT=1` 且带 `[claude-code]`，桌面数据源页显示 `permission_denied`/“重新同步”，MCP `data_status` 显示 `health=warn`、`needs_attention`、`retry_sync`；Codex/DSH/WorkBuddy 仍继续同步，响应不泄露绝对路径。

## 2. 旧套餐 → 本地待确认候选【Loop 18-22】→ AC26

- **路径**：用旧版本数据/历史价卡快照启动（或迁移一次）→ 打开总览。
- **期望**：历史订阅落为「待确认候选」，**不进** harness_bills/FixedSubscription；提示语言为「确认计费方式」，不含误导词「编辑/已省钱」。
- **对拍**：`data-unresolved --month` 显示候选组；`data status` 的 harness_bills 为空。
- **UAT 记录**：

## 3. 确认一组 → 官方订阅【Loop 24-28】→ AC27

- **路径**：总览提示 → 侧边面板 → 选中一组（执行环境×provider×模型×路由）→ 点确认 → 选作用范围 → 预览→保存。
- **期望**：预览「移出估算 X / 保持估算 X / 仍待确认 X」；保存后原处回执+可撤销；总览/会话/日历/CLI 同一结果版本。
- **对拍**：`data coverage` 该执行环境 amounts 出现对应 basis 变化；`data-unresolved` 该组消失。
- **UAT 记录**：

## 4. 撤销声明 → 版本化重算【Loop 41/12】→ AC13

- **路径**：对已确认的声明点撤销 → 看回执 → 刷新总览/日历/会话。
- **期望**：生成修订并重算（不删除原用量）；金额回到确认前；原事实保留可证（route/fact 未变）。
- **对拍**：`data-reimport-verify` 通过；`usage_facts` 原预览仍可查。
- **UAT 记录**：

## 5. 仍不确定 / 稍后再说【Loop 28】→ AC28

- **路径**：对一个待确认组选「仍不确定」→ 存 → 回到总览。
- **期望**：当前估算继续有效；提示进入「待处理」列表；30 天内不重复占据首屏（可查）。
- **对拍**：未确认用量仍在 `data-unresolved`；不产生任何"确认"副作用。
- **UAT 记录**：

## 6. CNY / USD 共存【既有双币】→ AC10

- **路径**：本地有 claude-code（USD 订阅/估算）+ minimax（CNY）并行用量 → 开总览/月视图。
- **期望**：同 harness 不同币按 provider 分行、币种各标；**绝不**跨币相加成一个数；`total_summable` 保持单币可解释。
- **对拍**：`data coverage --json` 的 by_provider 各条目 currency 字段与 UI 行一致。
- **UAT 记录**：

## 7. 重算失败 → 退出重启恢复【Loop 20-22】→ AC14

- **路径**：触发一次重算 → 进程中途杀掉 → 重新打开工作台。
- **期望**：任务标记恢复/继续，不重复记账，不重复索权；旧版本结果保留可用，显示「重算待重试」。
- **对拍**：`authority.sync_runs` 无悬挂 running 跑批；`usage_facts` 计数未翻倍。
- **UAT 记录**：

## 8. 预算提醒：仅首穿通知 + 本周期静默【Loop 35 相关】→ AC19

- **路径**：设置预算（80%/100% 阈值）→ 跨过阈值一次 → 再看是否重复提醒 → 点「本周期静默」。
- **期望**：阈值**首次**跨越只发一次；重算不重复轰炸；静默后本周不再出现。
- **对拍**：通知记录仅一条（若有通知中心）；`budget_snoozes` 行存在。
- **UAT 记录**：

## 9. 全局暂停 / 排除 / 删除已导入数据【Loop 44-46】→ AC23

- **路径**：数据源页 → 暂停全局自动同步 → 恢复；再对一个执行环境依次执行排除（确认「已排除」）→ 恢复读取 → 删除已导入数据（确认框）。
- **期望**：全局暂停及单执行环境排除只影响未来读取；恢复读取后重新同步；删除确认后该执行环境事实/会话/工作流程/路由证据/来源指纹清除，**执行环境原始日志不动**；其他执行环境数据保留。
- **对拍**：`data coverage` 被删执行环境行 Unavailable 且 facts 清空；另执行环境计数不变。
- **UAT 记录**：

## 10. 自定义执行环境根目录 → 同步接入【Loop 44】→ AC02（子集）

- **路径**：设置 → 数据源 → 选择其他位置 → 目录选择器选一个真实执行环境根 → 同步 → 回到总览。
- **期望**：自定义根被对应执行环境 scanner 枚举、与标准目录合并去重、继续原解析与 fact 生命周期（不另写格式解释）；非法路径/相对路径被拒绝。
- **对拍**：`data status` 该执行环境 sources 增加自定义根对应文件；`source_files` 出现新增路径指纹。
- **UAT 记录**：

---

## 以下 AC 暂不进入小闭环 UAT（如实列出，不受本清单阻塞）

| AC | 阻塞 | 对应阶段 |
|---|---|---|
| AC01 干净机器无日志 | 需要干净环境 + 真实首启状态机（未完成） | B 出口 |
| AC16 价格服务离线/坏目录 | REQ-097 官方更新链路未建 | A 出口（批次3） |
| AC20 磁盘满/旧库升级崩溃 | D 阶段恢复页未建 | D |
| AC22 读屏/键盘/200%字号 | 无障碍完整实现 + 真实辅助技术 | C/D |
| AC24 无开发环境装正式包 | Developer ID 签名 + notarization | D |
| AC25 完全不配置走完 L0 | 首启闭环未完成 | B |
| AC12 充值与月账单 | 付款记录对账未完成 | C |
| AC21 时区切换/夏令时 | D 验证场景 | D |

## 维护说明

- 本清单文件位于 `docs/v1.0.0/`，随其所在的下一轮 commit 一并纳入版本管理。
- UAT = 用户可走通验收，与 Loop 日志中的「独立验收/自验收」（代码级）是两层不同验证；两者都必须在 REQ 勾选前存在。
