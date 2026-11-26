/**
 * Knowledge/Causal/Staleness 校验算法（RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.2 检查 2、
 * V3-04 / V3-06 / V3-12）。
 *
 * - 因果依赖：新事件需要引用既有因果（§4.2：Event Log 是历史凭证）；缺失因果即拒绝。
 * - 知识边界：NPC 不能无来源知道私人事件（V3-04）；belief ≠ 世界事实，校验只裁可验证性，
 *   绝不把 belief 当作 State 提交。
 * - 摘要降级：过期的摘要不覆盖当前 State（V3-06：State 优先，摘要只降级不覆盖）。
 *
 * 全部为纯函数：不依赖宿主/DB/inkjs；失败时 ok=false 且 diagnostics 至少一条
 * （V3-12：失败绝不返回空成功报告），成功时输出确定性排序、输入绝不被修改。
 */
import { type NarrativeResult } from "../contracts/diagnostics";
import { type CharacterCanonV1 } from "../contracts/canon";
import { type KnowledgeClaimV1, type NarrativeSummaryV1 } from "../contracts/knowledge";
/**
 * 知识边界校验（V3-04 / §4.2 检查 2）：收集全部诊断（不做 fail-fast），顺序与输入顺序一致。
 *
 * 诊断：
 * - `knowledge_unverifiable`（error，V3-04）：`visibility: "private"` 的认知没有
 *   sourceEventId——NPC 不能无来源知道私人事件（秘密、误会、私人观察不可凭空成立）。
 *   public 认知可无来源（公共常识不要求逐条溯源）。
 * - `knowledge_source_missing`（error）：sourceEventId 引用了未提交的事件——例如
 *   Actor 声称"已约会"但 Event Log 中没有对应已提交事件，此时校验拒绝（V3-04）。
 * - `knowledge_character_mismatch`（error）：claim 的 characterId 与 canon 不符——
 *   本校验按角色针对该角色的 canon 执行，认知集不得混入其他角色（§4.1 带来源与可见性）。
 * - 结构诊断：容器/条目形状、content ≤ 512 B、visibility 枚举、revision 非负整数、stale 布尔。
 *
 * canon 先经过 validateCharacterCanonV1（其诊断以 `canon.` 前缀透传），非法即整体拒绝。
 * 合法时 ok=true 并原引用返回（认知是运行时事实，本包不做冻结/快照）；失败时绝不返回空成功。
 */
export declare function validateKnowledgeClaims(claims: readonly KnowledgeClaimV1[], committedEventIds: readonly string[] | ReadonlySet<string>, canon: CharacterCanonV1): NarrativeResult<readonly KnowledgeClaimV1[]>;
/**
 * 摘要过期降级（V3-06：State 优先，摘要只降级不覆盖）。
 *
 * 规则：`summary.revision < currentStateRevision` → stale 标记为 true；revision 等于或
 * 高于当前 State 不视为过期。降级是单调的：已有 `stale: true` 的摘要绝不因 revision
 * 追平而"复活"——摘要只能被进一步降级，永不覆盖 State。
 *
 * 输出是新数组、新对象（输入绝不被原地修改，深度冻结输入安全），元素顺序与输入一致
 * （确定性）。条目形状非法（非对象、缺失 summaryId、revision 非法）或
 * currentStateRevision 非法时 ok=false 且 diagnostics 至少一条（V3-12）。
 */
export declare function markStaleSummaries(summaries: readonly NarrativeSummaryV1[], currentStateRevision: number): NarrativeResult<readonly NarrativeSummaryV1[]>;
/**
 * 因果依赖校验（§4.2 检查 2 / V3-04）：新事件必须引用既有因果。
 *
 * 诊断：
 * - `causal_dependency_missing`（error）：依赖的事件 id 未在已提交事件集合中——
 *   新事件缺失因果，必须拒绝（先有因，后有果）。
 * - `causal_dependency_malformed`（error）：依赖条目不是非空字符串。
 * - `causal_committed_events_invalid`（error）：已提交事件集合本身非法（非字符串条目
 *   会让全部依赖"看起来缺失"，必须显式拒绝而不是掩盖坏输入）。
 *
 * 合法时 ok=true，value 是已满足依赖的确定性排序列表（去重）；缺失依赖只通过诊断报告
 * （path 携带索引与事件 id）。失败时绝不返回空成功（V3-12）。
 */
export declare function checkCausalDependency(newEventDependencies: readonly string[], committedEventIds: readonly string[] | ReadonlySet<string>): NarrativeResult<readonly string[]>;
