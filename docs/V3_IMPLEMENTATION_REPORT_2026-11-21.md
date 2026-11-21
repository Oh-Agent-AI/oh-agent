# City SDK V3 实施报告（feature/city-sdk-v3）

> 日期：2026-11-21
> 分支：`feature/city-sdk-v3`（worktree `skill-vitals-wt/city-sdk-v3`），基于 dev@019766f3，已合并 dev@80b0ad7c（ST-02 App 拆分）；**dev 于 e4f3229c 将本分支整体合回**（另一会话叠加 ST-03..08/ST-13/remix 后合并），本分支继续承载 W4/W5
> 实施依据：docs/OH_AGENT_CITY_SDK_V3_INTEGRATION_RFC_2026-11-19.md（r3）
> 实施方式：worktree + subAgent 五波并发（W1: S-1/S-5/S-0；W2: S-2+S-3/S-4；W3: S-6b/ADR-01/Top5-⑤；W4: PR-4 信封/PR-6 契约/TS trace；W5: PR-5 管线/PR-7 Inspect），主线集成者逐个独立复验后提交

## 一、commit 清单（16 个）

W4/W5 追加（2026-11-21）：

| commit | 内容 |
|---|---|
| 7492e1cd | feat(v3): narrative-sdk Canon/Knowledge/因果校验契约（PR-6 前半，40 测试） |
| 90f1d4bf | feat(v3): WorldEventEnvelopeV1 + 公共 city-resident scope 存储（PR-4 尾巴） |
| 517a4fe7 | feat(v3): TS trace 产出——host-verified 实链打通（S-6b 产出端） |
| 98369ef8 | feat(v3): PR-5 Intent 管线 + PR-7 Inspect 工具×4 + headless 臂 + Top5-②③ |

## 一·a、原 W1~W3 commit（11 个）

| commit | 内容 |
|---|---|
| 2e64ed2d | docs: RFC r3 作为实施基线 |
| c7c88041 | feat(v3): narrative-sdk（图算法包，S-5 前半） |
| 3e9b1a5f | ci(v3): desktop 全量 lib 测试进 CI（S-0 双盲区首修） |
| 7a754ea8 | feat(v3): StateScopeV1 + story_store 键迁移（S-1） |
| afe0cee7 | fix(v3): mount parameterOverrides 范围校验（S-6a，实测 P2 缺口） |
| 67b27348 | feat(v3): Story Registry + 三对象生命周期 + ResidentActivityLease（S-2+S-3） |
| d2ee3df0 | feat(v3): Story Preview Fork copy-on-read（S-4） |
| 698e0d41 | test(v3): MCP previewId 双读法 + install 面负向契约（Top5-⑤） |
| e5cde3a2 | feat(v3): ADR-01 spike 最小 AST |
| 7af09905 | merge dev (ST-02 app split) into city-sdk-v3 |
| ea00848e | feat(v3): 宿主规则复算 host-verified（S-6b/V3-16） |

总量：46 文件 +7158/−74（不含本报告）。

## 二、终验数字（全部真跑）

| 套件 | 结果 |
|---|---|
| desktop（src-tauri --lib） | **540/540** + clippy -D warnings ✓（并行下 overview 三测偶发抖动系时间敏感既有隔离问题，单线程/定向均绿） |
| agent-vitals-mcp | **123/123** + clippy ✓ |
| @oh-agent/city-sdk | **170/170** |
| @oh-agent/narrative-sdk | **40/40** |
| city-game-sdk（含 ADR-01 spike） | 76/76 + typecheck |
| agent-city（mounted-mini-game 等） | 18/18 |
| Studio UI | **62/62** + typecheck |

## 三、RFC 验收映射

- V3-15（Story 安装事务）：✅ 单测级（四字段 digest 绑定确认/过期重放/冲突回滚/活跃 Run 二道闸）
- V3-16（宿主复算）：✅ 单测级（host-verified / hostDisagreement 双向诚实；TS 侧 trace 产出为后续切片）
- V3-17/18/19/21/23：✅ 语义有单测（双 Story 串线、关视图不停 Run、租约仲裁、Fork 不变式、新周目隔离）
- V3-01~06/07~14：部分由既有回归覆盖（S-0 审计报告列缺口），未在本轮逐项自动化
- V3-12（验证器失败≠通过）：narrative-sdk 诊断契约 + spike AST 白名单 fail-closed 双处落地

## 四、已知边界与后续切片

1. TS 侧 trace 产出（客户端按 ReplayEventV1 记录 zone.entered）未实现——宿主复算的消费契约已就绪。
2. 租约完成/取消两条释放路径挂 Intent 提交管线（PR-5）；本轮以显式 release API 承接。
3. mount 歧义（多 mount 同 game 引用）退回 pack 默认值；收紧可让 evidence 携带 mountId。
4. S-0 审计 Top5-②③ 已补（W5）；④（city_runtime TTL/active_slot 生命周期测试）待补。
5. ADR-01 结论：Condition=共享谓词层归 City SDK、Effect 权威归 Game SDK、`emit` 是唯一值得单独立项的跨界效果；flight 与 checkpoint 规则图逐字相同，最小子集可冻结。
6. ~~plugin_host.rs headless 臂未接 story.*~~ W5 已接（story.* 11 + install.* 3 直接路由宿主 dispatch）。
7. MCP 直提 intent 工具刻意未接：scope 持有方由宿主落库裁定，外部 agent 直提需 Actor 适配器设计（PR-5 尾）；City WebView 提交面 city.story.intent.submit 已接线。
8. overview.rs 三测并行抖动：时间敏感既有隔离问题（单线程/定向均绿），建议后续补 test 级隔离。

## 五、合回 dev 预案

- 前置：主仓库另一会话的 remix 链路（creator.project.remix 等 3 文件，未提交）须先收尾提交。
- 预判冲突点（均可解）：creator_projects.rs DISPATCH_ROWS（双方各加行）；creator_studio.rs call_error 区（其参数错误码映射 vs 我们的 story 错误码——不同区域相邻）；Studio 测试文件 import 路径。
- 合并后必跑：desktop 512 / MCP 116+其新增 / Studio 50+ / city-sdk 169 / narrative-sdk 17 / city-game-sdk 76。
- merge 完成前不开 push；远端网络当日不通（fetch 超时），恢复后由用户决定 push 时机。
