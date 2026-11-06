# WorkBuddy Phase D：禁止伪造 Token 计量

> 状态：明确不实施。这是一份长期约束和回归审计清单，不是待开发功能。

## 决定

不得把 WorkBuddy 会话级聚合字段 `session_usage.used` 拆分或填充到 UsageFact 的四个 token 桶（uncached input、cached input、cache write、output）。

## 理由

1. WorkBuddy 没有逐 requestId token 数，只有会话级 `used`；拆分会伪造时间粒度与构成。
2. 执行环境没有四桶语义，尤其没有可靠的缓存读写信息；任何 cache hit ratio 都没有数据来源。
3. 借用 Codex、Claude 或其它执行环境的价格卡会产生错误定价；真机证据显示同一模型在不同卡下可相差约 46 倍。

## 与 Phase B 的边界

若将来批准 Phase B 路径 1，逐 requestId UsageFact 的四桶可以全部为 0。这是“执行环境未报告分桶”的诚实缺失声明，不是对会话 token 的零测量。WorkBuddy 仍必须排除在 `tokens_by_harness` 等将零解释为已测量的 token DTO 之外。

## 长期约束

- 不使用会话 `updated_at` 为每个 requestId 伪造 event time。
- requestId 无 audit timestamp 时，事件时间和 `time_basis` 保持 null。
- 不从 credit、名义成本或订阅金额反推 token 桶。
- WorkBuddy SQLite 的文件级 mtime 每次写入都可能变化；不得把它当作逐会话增量指纹。将来若需要增量，只能基于 `sessions.updated_at` 与 `session_usage.updated_at` 的内容级指纹，并另行设计与验收。

## 回归检查

每当调整 WorkBuddy facts、会话或成本代码时，确认：

1. 不存在将 `used` 写入任一 UsageFact token bucket 的映射。
2. WorkBuddy 不进入 token 汇总或由 token 桶驱动的计费。
3. 时间缺失保持缺失，不以会话级字段补齐。
4. 新价格或展示逻辑不把 credit 当实付，也不以 credit 倒推 token。

任何改变以上约束的提案必须作为新规格提出，带真机逐请求 token 证据、价格依据、迁移方案和跨视图验收；不得作为 Phase D 的“补全”。
