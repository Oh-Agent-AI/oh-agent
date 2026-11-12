# Creator 校验规则对照语料（TS 侧）

设计依据：`docs/AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md` §3.3 / §3.4 / §7 P0 第 2 项。

目的：同一份输入样例记录 city-sdk 校验器的接受/拒绝结论，作为后续 Rust↔TS 对等迁移的基线。
本轮只做 TS 侧断言；Rust 侧断言（`apps/desktop/src-tauri/tests/creator_conformance.rs`）由后续任务
**消费同一份 JSON 语料**。每个 `conformance/<规则族>.<场景>.json` 结构：

```json
{
  "ruleFamily": "game | scene | mount",
  "case": "<场景名>",
  "expectTs": "ok | error:<首诊断码>",
  "input": { "…": "校验器输入" },
  "rustNote": "Rust 侧预期行为备注（静态阅读 creator_projects.rs 得出，非运行时结论）"
}
```

TS 断言：`packages/agent-vitals-city-sdk/tests/creator-conformance.test.ts`（逐个加载本目录 JSON，
调 `validateMiniGamePack` / `validateSceneDraft` / `validateMount`，断言 `expectTs`；行为漂移时失败并打印实际首诊断码）。

## 语料清单（34 例）

`rustNote` 依据（只读静态阅读）：`apps/desktop/src-tauri/src/creator_projects.rs` 的
`validate_game`（:186）、`validate_scene_object`（:962）、`validate_mount`（:1068）、
`validate_layout_snapshot`（:275）、`apply_scene_operations`（:1178）。
Rust 返回单一粗码（`creator_*`），TS 返回 `DiagnosticV1` 细码；下表"Rust 预期"列给出粗码。

### game（validateMiniGamePack ↔ validate_game）

| 场景 | expectTs | Rust 预期（静态阅读） |
|---|---|---|
| game.valid-walk-collection | ok | 接受（walk requires、item.collected、counter.eq、字面量 durationTicks 均在白名单） |
| game.invalid-unknown-event | error:rule_invalid_event | 拒绝：creator_game_invalid（事件 type 白名单一致） |
| game.invalid-slot-kind-mismatch | error:rule_slot_kind_mismatch | 拒绝：creator_game_invalid（zone.entered 须配 zone 槽） |
| game.invalid-slot-not-found | error:rule_slot_not_found | 拒绝：creator_game_invalid（event.slot 须已声明） |
| game.invalid-guard-undeclared-counter | error:rule_invalid_guard | 拒绝：creator_game_invalid（guard.counter 须在 counters 内） |
| game.invalid-eq-event-index-on-timer | error:rule_invalid_guard | 拒绝：creator_game_invalid（eqEventIndex 限玩家输入事件） |
| game.invalid-duplicate-node-id | error:rule_duplicate_node_id | 拒绝：creator_game_invalid（node_ids 去重） |
| game.invalid-node-budget | error:rule_budget_exceeded | 拒绝：creator_game_budget_exceeded（nodes>128，阈值一致） |
| game.invalid-slot-requires-capability | error:content_invalid_slot | 拒绝：creator_game_invalid（requires 仅 drive/walk） |
| game.invalid-parameter-default-out-of-range | error:content_invalid_parameter | 拒绝：creator_game_invalid（default ∈ [min,max] ≤1e6） |
| game.invalid-schema-v2 | error:schema_unsupported | 拒绝：creator_game_invalid（version 必须 =1） |
| game.invalid-node-missing-actions | error:rule_budget_exceeded | 拒绝：creator_game_invalid（分类差异，见已知差异 #3） |

### scene（validateSceneDraft ↔ validate_scene_object）

| 场景 | expectTs | Rust 预期（静态阅读） |
|---|---|---|
| scene.valid-mixed | ok | 接受（三类对象字段白名单与 transform 边界一致） |
| scene.valid-dotted-id（重点） | ok | 预期同样接受：`valid_id` 允许点号（首字符字母数字，其余 `[alnum._:-]`，≤128） |
| scene.invalid-unknown-kind | error:scene_object_invalid | 拒绝：creator_scene_object_invalid |
| scene.invalid-transform-missing | error:scene_transform_invalid | 拒绝：creator_scene_transform_invalid（三键齐备） |
| scene.invalid-transform-bounds | error:scene_transform_invalid | 拒绝：creator_scene_transform_invalid（±100000 一致） |
| scene.invalid-asset-ref-digest | error:scene_asset_ref_invalid | 拒绝：creator_scene_asset_invalid（sha256:+64 小写 hex 一致） |
| scene.invalid-collider-shape | error:scene_collider_invalid | 拒绝：creator_scene_collider_invalid（仅 box，0.1..100） |
| scene.invalid-anchor-kind | error:layout_invalid_anchor_kind | 拒绝：creator_scene_anchor_invalid（kind 白名单一致；TS 诊断经 validateCityLayout 转发，来源不同结论一致） |
| scene.invalid-collider-budget | error:scene_collider_budget_exceeded | 拒绝：creator_scene_collider_budget_exceeded（256 阈值一致，执行时机不同：TS 校验期、Rust apply 层） |

### mount（validateMount ↔ validate_mount）

Rust 输入形态不同：`validate_mount(document, mount)` 从 project document 取 `cityLayout` 快照
（schemaVersion/worldRevision/seed/layout 信封）与 `document.game`；TS 输入是裸 layout + game + mount
（可选 resolvedRefs）。本目录 layout 采用 TS 的裸 layout 形态；Rust 侧消费时需包上快照信封。
两侧布局预算不同：TS ≤20000 anchors / ≤100000 links；Rust 快照 1..=64 anchors / ≤256 links。

| 场景 | expectTs | Rust 预期（静态阅读） |
|---|---|---|
| mount.valid-resolved-route | ok | 接受（引用 id 匹配、digest==worldRevision、BFS 可达、基数/参数一致） |
| mount.invalid-slot-count-max | error:slot_binding_count | 拒绝：creator_mount_binding_invalid（超 max；city-sdk 既有 fixture 覆盖低于下限方向） |
| mount.invalid-slot-omitted | error:slot_binding_count | 拒绝：creator_mount_binding_invalid（缺槽位键且 min>0） |
| mount.invalid-game-ref-mismatch | error:game_ref_mismatch | 拒绝：creator_mount_game_mismatch（document.game.id 绑定） |
| mount.invalid-layout-ref-id | error:layout_ref_mismatch | 拒绝：creator_mount_layout_mismatch（layout id 绑定） |
| mount.invalid-game-digest | error:content_ref_mismatch | 差异候选：Rust 不比对 game 引用 digest（见已知差异 #2） |
| mount.invalid-entry-anchor-kind | error:entry_anchor_kind_mismatch | 拒绝：creator_mount_entry_kind_mismatch |
| mount.invalid-anchor-unreachable | error:anchor_unreachable | 拒绝：creator_mount_anchor_unreachable（按 capability BFS） |
| mount.invalid-entry-capability | error:entry_capability_missing | 拒绝：creator_mount_entry_capability_missing |
| mount.invalid-slot-not-found | error:slot_not_found | 拒绝：creator_mount_slot_not_found |
| mount.invalid-parameter-not-found | error:parameter_not_found | 拒绝：creator_mount_parameter_invalid |
| mount.invalid-parameter-out-of-range | error:parameter_out_of_range | 拒绝：creator_mount_parameter_invalid |
| mount.known-diff-duplicate-bindings | ok（TS 接受） | 拒绝：creator_mount_binding_invalid（Rust 去重，见已知差异 #1） |

## 已知差异列表（静态阅读得出，均**待 Rust 运行时验证**）

1. **绑定数组重复锚点：Rust 严、TS 松。** `validate_mount` 用 HashSet 对每个绑定数组去重
   （重复 → `creator_mount_binding_invalid`）；TS `validateMount` 无去重检查，`["zone-b","zone-b"]`
   当前接受（样例 `mount.known-diff-duplicate-bindings`，expectTs=ok）。迁移时需决定以哪侧为准。
2. **game 引用 digest 检查形态不同。** TS 在提供 `resolvedRefs` 时强制 `mount.game.digest` 与
   加载器解析的内容版本精确相等（`content_ref_mismatch`）；Rust `validate_mount` 只比对 game 引用
   **id**（`creator_mount_game_mismatch`），不比对 game digest；layout digest 则绑定到快照
   `worldRevision`。样例 `mount.invalid-game-digest` 的 Rust 结论未知（可能接受）。
3. **诊断分类粒度不同（结论同向）。** 同一非法输入两侧都拒绝，但 TS 给规则级细码、Rust 给单一粗码；
   个别归属也不同：节点缺 `actions` 键，TS 归为 `rule_budget_exceeded`（走"非数组"分支），
   Rust 归为 `creator_game_invalid`（结构非法）；预算类 TS `rule_budget_exceeded` /
   `scene_collider_budget_exceeded`，Rust `creator_game_budget_exceeded` /
   `creator_scene_collider_budget_exceeded`。
4. **挂载可达性的输入边界不同（算法一致）。** TS BFS 直接作用于裸 `layout.links`（≤100000 条）；
   Rust 作用于 cityLayout 快照 links（≤256 条）且把 `mount.layout.digest` 绑到 `worldRevision`。
   两侧 BFS 均按 slot requires 的 capability 分图，`requires` 为空的槽跳过可达性检查——行为一致，
   但能覆盖的布局规模不同。
5. **Rust 有 TS 校验器没有的宿主侧检查**（记录备查，不属于本轮对等范围）：`validate_game` 序列化后
   ≤256 KiB（TS 同预算仅在 `parseMiniGamePackJson` 文本层生效）；Rust `nodes` 至少含 3 键的
   结构判断；布局快照信封（seed/worldRevision）与 anchors 1..=64 下限。

## 与 `packages/agent-vitals-city-sdk/fixtures/` 的边界（不重复）

既有 13 个 fixture 覆盖：game 合法包 + 未知动作（`rule_operation_unsupported`）+ 脚本注入
（hud.hint 附加 `script` 字段 → `rule_invalid_action`）+ 计数器越界（`initial/max` 超 1e9 →
`rule_invalid_counter`）；mount 合法挂载（无 resolvedRefs、无 route 锚点）+ 槽位低于下限 +
锚点能力缺失 + layout digest 过期（resolvedRefs.layout）+ 锚点不在布局；layout snapshot 合法 +
anchor kind/capability 非法；GLB 字节边界。

本目录全部为**新场景或对既有规则补充的新输入形状**：
- game：事件类、守卫类、重复节点、节点/参数预算、schema 版本、缺 actions——均未在既有 fixture 出现；
- scene：既有目录无任何场景草稿 fixture（scene.test.ts 用内联对象，且未覆盖未知 kind、缺失 transform、
  摘要格式、collider 形状/预算、点号 ID）；
- mount：合法样例换成 resolvedRefs 精确匹配 + route 锚点 + drive 可达链；槽位基数补"超上限/整槽缺失"
  两个方向；digest 差异换 game 引用侧；另覆盖 entry kind/capability、不可达、slot/parameter 未声明、
  重复绑定（已知差异）。
