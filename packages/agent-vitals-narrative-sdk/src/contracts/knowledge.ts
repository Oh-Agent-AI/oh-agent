/**
 * Knowledge/Belief 契约（RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.1 / V3-04）。
 *
 * 权威分层（§4.1）：NPC Belief/Knowledge 是"带来源与可见性的角色认知，不等于世界事实"，
 * 低于 World/Story State（最高动态事实）与 Event Log（历史凭证）。必须允许 NPC 主观错误，
 * 但不得由未经提交的文本改写客观世界：私人事件知识必须可溯源（V3-04：NPC 不能无来源
 * 知道私人事件）。本文件是纯类型，零 npm 运行时依赖。
 *
 * Narrative Summary 同属本契约族（§4.1：派生索引，低于 State/Event）：摘要只降级不覆盖
 * （V3-06：State 优先），过期摘要由 validate/knowledge.ts 的 markStaleSummaries 标记 stale。
 */

export const KNOWLEDGE_CONTENT_MAX_BYTES_V1 = 512;

export const KNOWLEDGE_VISIBILITY_V1 = ["public", "private"] as const;
export type KnowledgeVisibilityV1 = (typeof KNOWLEDGE_VISIBILITY_V1)[number];

/**
 * 一条角色认知（belief）。语义：belief ≠ 世界事实——它是某角色在某个 Story Revision
 * 获得的认知，可以主观错误，可以过期（stale 由校验/宿主降级标记，只降级不覆盖）。
 * `sourceEventId` 指向支撑该认知的已提交事件；`visibility: "private"` 的认知（秘密、
 * 误会、私人观察）没有来源即不可验证。
 */
export interface KnowledgeClaimV1 {
  readonly claimId: string;
  readonly characterId: string;
  /** 关于谁或什么（角色、地点、事件等的引用或描述）。 */
  readonly subject: string;
  /** 认知内容，≤ 512 B（UTF-8 字节数，不是码点数）。 */
  readonly content: string;
  /** 可溯源的已提交事件 id；私人事件知识必须携带（缺省即 unverifiable）。 */
  readonly sourceEventId?: string;
  readonly visibility: KnowledgeVisibilityV1;
  readonly acquiredAtStoryRevision: number;
  /** 创建时为 false；过期摘要/认知只降级标记，绝不覆盖世界事实。 */
  readonly stale: boolean;
}

/**
 * 叙事摘要（派生索引，§4.1 权威低于 State/Event）。`revision` 是摘要生成时的
 * World/Story State revision；State 推进后旧摘要由 markStaleSummaries 标记 stale。
 */
export interface NarrativeSummaryV1 {
  readonly summaryId: string;
  readonly revision: number;
  /** 只降级不覆盖（V3-06）：一旦标记为 true 不再因 revision 追平而"复活"。 */
  readonly stale?: boolean;
}
