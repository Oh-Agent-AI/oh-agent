# Extension authority schema v28

实现对应扩展架构 §5.5。五张关联表进入既有 `agent-vitals.sqlite3`，fact JSONL 和 billing/behavior fact 列保持原契约。

`extension_revisions` 持久化独立 revision_id、slot、完整内容 sha256、来源、vendor repository identity / 完整 commit / index sha256、schema、capabilities 和安装时间。同内容的本地与目录来源使用不同 revision_id；哈希不推导 origin。API 无 payload 反序列化能力。`RevisionOrigin::VendorCatalog` 是内部安装器验证结果的类型化声明，当前 storage API 本身无法证明 vendor 审核、签名或对象内容与哈希一致；后续安装器只能在校验 index 与对象后构造它，不能映射 manifest 自报 origin。

`extension_activations` 保留 generation、previous_generation、动作、preview sha256 与提交时间，`extension_activation_slots` 保存每一 generation 的完整 slot→revision 映射。`extension_active` 的 singleton 指针是唯一当前选择。generation 0 为空映射。调用者传完整替换映射：省略旧 slot 就表示停用，回滚生成新的 generation 指向保留的 revision，旧映射不会覆盖。

`activate` 使用既有 `begin_immediate` / `commit_advancing_revision`，同事务写 revision、映射、activation 和 CAS 指针，并推进 authority revision 使 ReadMemo 失效。expected generation 不一致时整事务回滚。调用者必须预先持久化对象、验证 preview 输入与 dependency closure；本轮仅实现 SQL 基础，不宣称文件/网络安装生命周期完成。

`extension_fact_provenance` 关联 fact_id、generation、revision_id 与 engine_version；复合外键保证 revision 属于 pinned generation。`link_fact_in_transaction` 必须置于现有 fact 写事务中，API 拒绝 autocommit，但不会自行开启/提交事务。调用者负责在对应 fact 写入的同一事务内调用，不得以事后单独补写替代该边界。删除 fact 时级联删除其关联，兼容既有用户数据删除/retention；revision 与历史 activation 保留。

迁移保留旧分支的 v27 提交边界，然后在共同 `BEGIN IMMEDIATE` 事务内完成补齐既有增量 DDL、v28 DDL 和 v28 版本戳。失败回滚时不会留下“版本已是 v28、扩展表尚不存在”的状态；新库同样经过这个最终事务。Python compatibility 实现只读 authority，没有维护独立 authority DDL，本轮不新增另一套 SQL writer。

本轮尚未接入 generic ingest、分类结果 provenance、对象保留/回收、导出重建与安装器验证。旧事实没有关联时不得追认 vendor 来源，后续 serving face 要明确显示未知来源并保持 unresolved。
