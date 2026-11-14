# Creator 校验规则对照语料（TS 语义基线）

设计依据：[Creator Rust / City 边界优化方案](../../docs/AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md) §3.3 / §3.4 / §7 P0。

## 用途

同一份输入样例记录 **city-sdk** 校验器的接受/拒绝结论（`expectTs`），由
`packages/agent-vitals-city-sdk/tests/creator-conformance.test.ts` 逐个加载并断言。
它是语义迁移的回归基线：sdk 校验行为变化时必须显式更新语料。

## 2026-11-12 之后的归属（重要）

P2 已把 game/scene/mount 的**语义**校验从 Rust 移除；Rust 只保留结构、预算、引用形状
与资产字节检查（`structural_game_check` / `structural_mount_check` /
`validate_scene_object` 的结构部分）。因此：

- `expectTs` 是当前唯一可执行的期望；`rustNote` 是 **P2 之前** Rust 语义实现的
  历史记录，仅用于迁移对照，不再有对应代码，也不会被任何测试消费。
- 不存在“两边结论必须一致”的约束：Rust 可能接受语义非法输入，由 Studio 的
  validation 信封在 preview/commit 闸门拒绝。
- Rust 结构侧的守卫由 `apps/desktop/src-tauri/src/creator_projects.rs` 内的
  `creator_*` 单元测试覆盖，不读取本目录。

## 文件格式

```json
{
  "ruleFamily": "game | scene | mount",
  "case": "<场景名>",
  "expectTs": "ok | error:<首诊断码>",
  "input": { "…": "校验器输入" },
  "rustNote": "历史记录：P2 前 Rust 的预期粗码（不作为断言）"
}
```

## 语料清单（34 例）

- `game.*`：11 例（合法 walk 收集、未知事件、槽位/守卫/预算/版本等）
- `scene.*`：9 例（混合合法、点号 ID、未知 kind、transform、资产摘要、碰撞预算等）
- `mount.*`：14 例（合法路由、槽位数量/遗漏、引用不匹配、入口能力、可达性、
  参数越界；`mount.known-diff-duplicate-bindings` 是已知 TS 行为差异记录）

## 运行

```bash
cd packages/agent-vitals-city-sdk
node --experimental-transform-types --import ../../scripts/mecha-ts-register.mjs \
  --test tests/creator-conformance.test.ts
```

## 新增样例

1. 在 `conformance/` 增加 `<family>.<场景>.json`，填写 `expectTs` 与 `input`；
2. 重跑上面的命令；失败时打印实际首诊断码，按预期修正 `expectTs` 或校验器；
3. 若涉及新的 Rust 结构不变量，另外在 desktop crate 的单元测试中钉住，不要写回
   `rustNote` 当作跨语言断言。
