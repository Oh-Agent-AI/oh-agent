# 自动审计的本地失败证据

2026-10-16。实现入口：`apps/agent-city/ui/src/game/driving/audit/AuditEvidenceStore.ts`。

此实现是 D2 的证据存储基础，尚不包含 `ReleasedDrivingGraph`、故障分解出生路线或审计界面。摘要及片段是诊断材料，不能作为道路开放证明。

## 范围与接线

证据仅在当前 JS 运行时的内存中保留，不写磁盘，不提供 IPC、MCP、导出或网络接口，也不录制手动驾驶。创建新 store 会清除上一 epoch。宿主调用方持有 owner 对象，并提供 `isCurrent()` 与完整 `currentKey()`；读取和写入均检查 owner、场景有效性及审计 key。

通过 `store.sink(owner)` 获得只写能力，再作为 `PassabilityOptions.evidence` 传入 `auditRoute` 或 `executeAuditPlan`。`DrivingRouteRunner` 在内核完成每步后、观察器判断前记录输入和前后状态；证据故障不改变模拟或审计结论。调度器也接受 evidence，用于在用例间取消、预算中断或 key 过期时清除证据。正式界面的 store 生命周期和消费仍需 E 接入。

## 上限与失效

默认每个失败片段保留最后 600 tick，最多 32 个失败片段、4096 条摘要、4 个活动用例、16 个 key 变体，保留数据预算为 8 MiB。字符串按 `6 × JSON 字符数 + 256` 计费，另计环形槽位与 key 元数据；该上限约束保留的诊断记录，不代表整个 JS 堆或临时读取副本的内存上限。

成功用例丢弃状态帧，仅保留摘要。容量不足时依次淘汰旧失败片段、旧摘要及活动用例的旧帧；摘要明确返回 `retained`、`evicted` 或 `not-recorded`，并标记截断。取消、场景/key 过期、主动 dispose 或新 epoch 都会使旧句柄不可读取。

只复制已声明的输入布尔值与车辆状态字段，不接收附加属性；非法或非有限状态记为 null 并标记 invalidState，不保留原始异常文本。句柄只对当前 owner 和 epoch 有效，不是宿主授权或外部安全边界的替代品。

## 诊断变体

同 key、同用例在摘要保留期间不覆盖首次结果。替代控制器、降速及最终边界复跑通过 `variantSink` 使用独立完整 key 与类型标签；替代控制器和降速必须关联已存在的失败用例。物理世界和复核器身份必须一致，边界复跑必须携带不同且非空的边界 hash。诊断成功不能改写原 mandatory 失败或释放道路。

## 验证

`node scripts/verify-city-audit-evidence.mjs` 覆盖同内核结果一致性、有界环形记录与字节预算、淘汰、首次失败与变体隔离、字段投影、owner/key/epoch/取消失效，以及 `auditRoute` 连续内核的真实接线路径（合成世界）。城市全量结果和原生界面验收仍需单独运行。
