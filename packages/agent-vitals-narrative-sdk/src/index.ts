// @oh-agent/narrative-sdk — S-5 第一部分：Story Graph 纯算法 + 类型 + 验证契约。
// 纯算法、零 npm 运行时依赖；不实现 ConditionV2 求值，不含宿主/DB/Ink adapter。
export {
  narrativeErrorV1, narrativeFailureV1, storyGraphCheckStatusV1, STORY_GRAPH_CHECK_STATUSES_V1,
} from "./contracts/diagnostics";
export type {
  NarrativeDiagnosticV1, NarrativeResult, StoryGraphCheckStatusV1,
} from "./contracts/diagnostics";
export type {
  ConditionRef, ScopeRef, StoryEdgePredicateV1, StoryEdgeV2, StoryGraphV1, StoryNodeV1,
} from "./graph/types";
export {
  buildStoryGraphAdjacencyV1, requireStoryGraphV1, validateStoryGraphV1, StoryGraphStructureErrorV1,
} from "./graph/validate";
export type { StoryGraphAdjacencyV1 } from "./graph/validate";
export { conditionalReachability, reachability } from "./graph/reachability";
export { stronglyConnectedComponents } from "./graph/scc";
export { deadEnds, islands } from "./graph/topology";

// S-5 第二部分：Character Canon、Knowledge/Belief、因果与摘要降级契约
// （RFC §4.1 权威分层 + §4.2 检查 2；纯类型 + 纯校验，无宿主依赖）。
export { CANON_BACKSTORY_MAX_BYTES_V1, validateCharacterCanonV1 } from "./contracts/canon";
export type {
  CharacterCanonGrowthEdgeV1, CharacterCanonV1, CharacterCanonValidationContextV1,
} from "./contracts/canon";
export { KNOWLEDGE_CONTENT_MAX_BYTES_V1, KNOWLEDGE_VISIBILITY_V1 } from "./contracts/knowledge";
export type { KnowledgeClaimV1, KnowledgeVisibilityV1, NarrativeSummaryV1 } from "./contracts/knowledge";
export { checkCausalDependency, markStaleSummaries, validateKnowledgeClaims } from "./validate/knowledge";
