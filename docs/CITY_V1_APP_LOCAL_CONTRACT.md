# city:v1 app-local 初始契约（C3 子批次）

版本：草案1，2026-10-03。JSON schema与projection metadata在docs/schemas；
SDK类型与协商表从同一元数据生成。当前仅开放city/version1/app-local，其他face
和版本拒绝。未接入broker、真实查询或授权；合成fixture不证明生产数据安全。

## 取数与一致性

open请求选择7d/30d/90d/366d窗口和1–500页大小。执行环境计算自然日边界、时区和
固定as_of。next只携snapshot_id/cursor，不允许换窗口；recent也必须携带
同一snapshot_id，用来获取该快照内最近两个统计自然日的会话，最多500条。
recent可能与已加载会话重叠，客户端按opaque_id去重；超过限额须通过
pagination表达续页，不能静默宣称补抓完整。cursor绑定安装身份、grant、
snapshot、operation和位置；C4/C5实现并校验这些绑定，不由字符串格式授信。

主序列固定first_event_ms升序、NULL最后、opaque_id升序打平。snapshot固定
revision、as_of、window与全窗harness summaries；无法维持快照时返回
snapshot_expired，客户端丢弃该次累计并重新open，禁止拼接不同revision。
字段returned_count是当前响应会话数，不是多页或recent去重后的累计数。
sessions_state表示数据源覆盖完整性；has_more表示当前序列是否还有页，两者独立。
全窗总数/总token与执行环境计数由执行环境给出，未知返回null；不能以当前页之和冒充。
空窗口仍是成功终态；读取失败返回受控错误，不能成功返回虚构零值。

## 字段与隐私

DTO不传输Map、SessionRow、session_ref、原始锚点/标题/工作目录、错误或参数。
保留会话event_count、token五分量、peak、事件时间及成本basis/status供面板使用。
harness/model_ids仅允许执行环境公共注册目录中的规范化id，未知值映射unknown并标记
reliability。schema语法约束不能替代C4的目录成员检查与face transformer；
任意满足正则的自报字符串仍不可信。时区同样必须由执行环境验证IANA规则。
findings仅返回全窗执行环境异常数量、严重性和固定分类，缺失显式标记unavailable。
费用reason_code来自受控枚举，无原始说明；unpriced/unavailable金额必须null。
状态/依据配对：actual仅metered_actual；estimated仅metered_estimate或
api_equivalent；subscription仅fixed_subscription。这三种状态必须有金额。
reason非none当且仅当has_unresolved；未知费用必须有不确定性；
actual/subscription必须已消除来源与路线不确定性，C4必须核实显式证据。
此跨字段规则由语义校验执行，单独JSON schema只证明结构合规，不证明账单真实性。
2026-10-03独立评审修订：为实际账单增加actual状态；同步修订尚未发布的
初始兼容baseline，并新增配对与不确定性反例，未绕过已发布版本兼容门。
harness:行不能成为subscription。当前测试覆盖部分跨字段不变量；完整来源与
billing/模型成员校验必须在C4及Rust输出实例验证中落实。

opaque_id在同一安装身份稳定，跨应用/重装身份不同；不得无密钥哈希原引用。
City楼宇可使用此id，钻取权限另由broker逐次检查；app.open_session仍待C5。
schema中的fixture句柄不产生任何生产授权。错误无自由message/details，
时间可靠性配对：known要求首末时间均非null；unknown要求均null；
partial要求恰好一个有效时间，损坏的另一个时间转换为null，不能补成当前时间。
SDK使用固定code本地化；错误请求id不得包含源锚点。

## 生成与兼容门

在packages/agent-vitals-app-sdk运行npm ci和npm run verify:contracts。
只有显式npm run generate:contracts写生成物；默认检查schema、metadata、
兼容baseline和生成漂移。独立兼容门当前采取保守规则：忽略文档注释后，任何
validation关键词变动都要求版本/评审决策；它不是通用schema包含关系证明。
尤其旧响应additionalProperties:false时，新增optional输出字段也不能直接
认定兼容旧客户端。初始baseline是未发布契约参考，变更须登记评审，不能仅
重新生成baseline使测试变绿。后续Rust实例校验和客户端保留旧版仍属C3欠账。

工具采用标准schema校验器与类型生成器：
[Ajv2020](https://ajv.js.org/json-schema.html)、
[json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript)。
契约测试和CI只读取合成fixture，不连接执行环境数据或网络服务。
