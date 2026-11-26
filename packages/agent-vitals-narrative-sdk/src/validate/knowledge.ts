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

import {
  narrativeErrorV1, narrativeFailureV1,
  type NarrativeDiagnosticV1, type NarrativeResult,
} from "../contracts/diagnostics";
import { validateCharacterCanonV1, type CharacterCanonV1 } from "../contracts/canon";
import {
  KNOWLEDGE_CONTENT_MAX_BYTES_V1, KNOWLEDGE_VISIBILITY_V1,
  type KnowledgeClaimV1, type NarrativeSummaryV1,
} from "../contracts/knowledge";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * UTF-8 字节数（与 TextEncoder 语义一致：孤立代理项按 U+FFFD 的 3 字节计）。
 * 不依赖 TextEncoder 全局——本包 tsconfig lib 仅 ES2022，且需保持 platform neutral。
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) { bytes += 1; continue; }
    if (code < 0x800) { bytes += 2; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; continue; }
      bytes += 3;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 3; continue; }
    bytes += 3;
  }
  return bytes;
}

/**
 * 归一已提交事件集合。调用方可传数组（事件日志顺序）或 Set（去重视图）；
 * 集合内容非法时返回显式诊断而不是让全部引用"看起来缺失"（那会掩盖坏输入）。
 */
function committedEventSet(
  committedEventIds: readonly string[] | ReadonlySet<string>,
  invalidCode: string,
): { readonly events: ReadonlySet<string>; readonly diagnostic?: NarrativeDiagnosticV1 } {
  if (committedEventIds instanceof Set) {
    for (const id of committedEventIds) {
      if (!isNonEmptyString(id)) {
        return { events: new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must contain only non-empty event id strings.") };
      }
    }
    return { events: committedEventIds };
  }
  if (!Array.isArray(committedEventIds)) {
    return { events: new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must be an array of non-empty event id strings or a Set.") };
  }
  const events = new Set<string>();
  for (const id of committedEventIds) {
    if (!isNonEmptyString(id)) {
      return { events: new Set(), diagnostic: narrativeErrorV1(invalidCode, "committedEventIds", "committedEventIds must contain only non-empty event id strings.") };
    }
    events.add(id);
  }
  return { events };
}

function withCanonPrefix(diagnostics: readonly NarrativeDiagnosticV1[]): NarrativeDiagnosticV1[] {
  return diagnostics.map(diagnostic => ({
    ...diagnostic,
    path: diagnostic.path === "$" ? "canon" : `canon.${diagnostic.path}`,
  }));
}

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
export function validateKnowledgeClaims(
  claims: readonly KnowledgeClaimV1[],
  committedEventIds: readonly string[] | ReadonlySet<string>,
  canon: CharacterCanonV1,
): NarrativeResult<readonly KnowledgeClaimV1[]> {
  const canonCheck = validateCharacterCanonV1(canon);
  if (!canonCheck.ok) return narrativeFailureV1(withCanonPrefix(canonCheck.diagnostics));

  const committed = committedEventSet(committedEventIds, "knowledge_committed_events_invalid");
  if (committed.diagnostic) return narrativeFailureV1([committed.diagnostic]);

  if (!Array.isArray(claims)) {
    return narrativeFailureV1([narrativeErrorV1("knowledge_claims_invalid", "claims", "claims must be an array of KnowledgeClaimV1.")]);
  }
  const diagnostics: NarrativeDiagnosticV1[] = [];
  for (const [index, entry] of claims.entries()) {
    const path = `claims[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_malformed", path, "Claim entry must be an object."));
      continue;
    }
    const claim = entry as unknown as KnowledgeClaimV1;
    if (!isNonEmptyString(claim.claimId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_id_invalid", `${path}.claimId`, "claimId must be a non-empty string."));
    }
    if (!isNonEmptyString(claim.characterId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_character_invalid", `${path}.characterId`, "characterId must be a non-empty string."));
    }
    if (!isNonEmptyString(claim.subject)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_subject_invalid", `${path}.subject`, "subject must be a non-empty string (who or what the belief is about)."));
    }
    if (typeof claim.content !== "string" || claim.content.length === 0) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_content_invalid", `${path}.content`, "content must be a non-empty string."));
    } else if (utf8ByteLength(claim.content) > KNOWLEDGE_CONTENT_MAX_BYTES_V1) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_claim_content_too_large", `${path}.content`,
        `content exceeds ${KNOWLEDGE_CONTENT_MAX_BYTES_V1} UTF-8 bytes.`,
      ));
    }
    if (claim.sourceEventId !== undefined && !isNonEmptyString(claim.sourceEventId)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_source_invalid", `${path}.sourceEventId`, "sourceEventId must be a non-empty string when present."));
    }
    if (!(KNOWLEDGE_VISIBILITY_V1 as readonly string[]).includes(claim.visibility)) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_claim_visibility_invalid", `${path}.visibility`,
        `visibility must be one of ${KNOWLEDGE_VISIBILITY_V1.map(v => `"${v}"`).join(" | ")}.`,
      ));
    }
    if (!isNonNegativeInteger(claim.acquiredAtStoryRevision)) {
      diagnostics.push(narrativeErrorV1("knowledge_claim_revision_invalid", `${path}.acquiredAtStoryRevision`, "acquiredAtStoryRevision must be a non-negative integer."));
    }
    if (typeof claim.stale !== "boolean") {
      diagnostics.push(narrativeErrorV1("knowledge_claim_stale_invalid", `${path}.stale`, "stale must be a boolean."));
    }
    const shapeValid = isNonEmptyString(claim.claimId)
      && isNonEmptyString(claim.characterId)
      && isNonEmptyString(claim.subject)
      && typeof claim.content === "string" && claim.content.length > 0
      && (claim.sourceEventId === undefined || isNonEmptyString(claim.sourceEventId))
      && (KNOWLEDGE_VISIBILITY_V1 as readonly string[]).includes(claim.visibility)
      && isNonNegativeInteger(claim.acquiredAtStoryRevision)
      && typeof claim.stale === "boolean";
    if (!shapeValid) continue;
    if (claim.characterId !== canon.characterId) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_character_mismatch", `${path}.characterId`,
        `Claim "${claim.claimId}" belongs to character "${claim.characterId}", but this validation covers "${canon.characterId}".`,
      ));
      continue;
    }
    if (claim.visibility === "private" && claim.sourceEventId === undefined) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_unverifiable", `${path}.sourceEventId`,
        `Private knowledge claim "${claim.claimId}" has no sourceEventId; an NPC cannot know about a private event without a committed source (V3-04).`,
      ));
    }
    if (claim.sourceEventId !== undefined && !committed.events.has(claim.sourceEventId)) {
      diagnostics.push(narrativeErrorV1(
        "knowledge_source_missing", `${path}.sourceEventId`,
        `Claim "${claim.claimId}" cites source event "${claim.sourceEventId}" which is not committed to the event log (V3-04).`,
      ));
    }
  }

  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  return { ok: true, value: claims, diagnostics: [] };
}

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
export function markStaleSummaries(
  summaries: readonly NarrativeSummaryV1[],
  currentStateRevision: number,
): NarrativeResult<readonly NarrativeSummaryV1[]> {
  if (!isNonNegativeInteger(currentStateRevision)) {
    return narrativeFailureV1([narrativeErrorV1("summary_state_revision_invalid", "currentStateRevision", "currentStateRevision must be a non-negative integer.")]);
  }
  if (!Array.isArray(summaries)) {
    return narrativeFailureV1([narrativeErrorV1("summaries_invalid", "summaries", "summaries must be an array of NarrativeSummaryV1.")]);
  }
  const diagnostics: NarrativeDiagnosticV1[] = [];
  for (const [index, summary] of summaries.entries()) {
    const path = `summaries[${index}]`;
    if (!isRecord(summary)) {
      diagnostics.push(narrativeErrorV1("summary_malformed", path, "Summary entry must be an object."));
      continue;
    }
    if (!isNonEmptyString(summary.summaryId)) {
      diagnostics.push(narrativeErrorV1("summary_id_invalid", `${path}.summaryId`, "summaryId must be a non-empty string."));
    }
    if (!isNonNegativeInteger(summary.revision)) {
      diagnostics.push(narrativeErrorV1("summary_revision_invalid", `${path}.revision`, "revision must be a non-negative integer (State revision at summary time)."));
    }
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  const value = summaries.map(summary => ({
    ...summary,
    stale: summary.stale === true || summary.revision < currentStateRevision,
  }));
  return { ok: true, value, diagnostics: [] };
}

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
export function checkCausalDependency(
  newEventDependencies: readonly string[],
  committedEventIds: readonly string[] | ReadonlySet<string>,
): NarrativeResult<readonly string[]> {
  const committed = committedEventSet(committedEventIds, "causal_committed_events_invalid");
  if (committed.diagnostic) return narrativeFailureV1([committed.diagnostic]);

  if (!Array.isArray(newEventDependencies)) {
    return narrativeFailureV1([narrativeErrorV1("causal_dependencies_invalid", "newEventDependencies", "newEventDependencies must be an array of non-empty event id strings.")]);
  }
  const diagnostics: NarrativeDiagnosticV1[] = [];
  const satisfied = new Set<string>();
  for (const [index, dependency] of newEventDependencies.entries()) {
    const path = `newEventDependencies[${index}]`;
    if (!isNonEmptyString(dependency)) {
      diagnostics.push(narrativeErrorV1("causal_dependency_malformed", path, "Causal dependency must be a non-empty event id string."));
      continue;
    }
    if (!committed.events.has(dependency)) {
      diagnostics.push(narrativeErrorV1(
        "causal_dependency_missing", path,
        `New event depends on "${dependency}" which is not committed to the event log.`,
      ));
      continue;
    }
    satisfied.add(dependency);
  }
  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  return { ok: true, value: [...satisfied].sort(compareText), diagnostics: [] };
}
