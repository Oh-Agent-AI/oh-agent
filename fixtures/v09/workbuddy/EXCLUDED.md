# WorkBuddy — 声明但排除（v0.9 Stage 0.7）

本目录**没有**数据 fixture，这是刻意的：用户 2026-09-05 决定 WorkBuddy 不接
入 v0.9 数据面（"workbuddy 的问题先不处理"），Stage 0.7 对它的全部要求是
§3.3 表的"声明但排除"——

- **声明面**：capability 注册表（`agent-vitals harnesses --json`）里有 `workbuddy`
  行，`unmeasured_signals`/`degraded_rules` 齐全——机器认识这个执行环境。
- **数据面**：`SummaryRepository` 永远把它放进 `excluded_harnesses`，`by_harness`
  里没有它；`harnesses/<h>/sources` 的 sqlite 读取代码存在但本阶段没有任何
  summary 路径会调用。

守卫测试 `tests/test_v09_onboarding_fixtures.py` 同时断言这两半。任何一侧
的缺席（注册表删了它的行 / excluded_harnesses 漏了它）都是回归，不是清理。
