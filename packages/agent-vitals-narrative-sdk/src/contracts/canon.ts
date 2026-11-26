import {
  narrativeErrorV1, narrativeFailureV1,
  type NarrativeDiagnosticV1, type NarrativeResult,
} from "./diagnostics";

/**
 * Character Canon 契约（RFC OH_AGENT_CITY_SDK_V3_INTEGRATION §4.1 / §2）。
 *
 * 权威分层（§4.1）：Character Canon 来自游戏作者版本化定义，权威等级"高、需受控迁移"——
 * 它声明角色相对稳定的边界（姓名、背景）与设计者允许的性格成长轨迹；它低于运行时
 * World/Story State（最高动态事实），也绝不等于 NPC 的 Belief/Knowledge（角色认知≠事实）。
 * 本文件是纯类型 + 纯校验：零 npm 运行时依赖，不引用 City/Game 类型；受控迁移的执行属宿主工作。
 *
 * 不可变资产：`validateCharacterCanonV1` 通过时对 canon 深度冻结并以同一引用返回
 * （设计者版本化资产一旦通过校验即不可变）；失败时绝不触碰输入。
 */

/** backstory 上限：2 KiB（UTF-8 字节数，不是码点数）。 */
export const CANON_BACKSTORY_MAX_BYTES_V1 = 2048;

/**
 * 允许的性格成长轨迹的单步（§4.1：角色性格变化应有 Story Event 支撑，且受设计者
 * 允许的成长轨迹约束）。`from`/`to` 是设计者词汇表内的性格状态；`requireEvent`
 * 是支撑该转变的 story 事件 id（运行时提交校验由宿主执行）。
 */
export interface CharacterCanonGrowthEdgeV1 {
  readonly from: string;
  readonly to: string;
  readonly requireEvent: string;
}

/**
 * 角色设定 Canon（设计者版本化资产）。`version` ≥ 1；受控迁移在宿主侧按版本推进。
 */
export interface CharacterCanonV1 {
  readonly storyId: string;
  readonly characterId: string;
  readonly displayName: string;
  /** 角色背景，≤ 2 KiB（UTF-8 字节）。 */
  readonly backstory?: string;
  /** 允许的性格成长轨迹；缺省表示角色性格不可变。 */
  readonly growthEdges?: readonly CharacterCanonGrowthEdgeV1[];
  readonly version: number;
}

/** canon 校验的可选引用上下文：提供已知事件全集时校验 growthEdge.requireEvent 的引用存在性。 */
export interface CharacterCanonValidationContextV1 {
  /** 已声明/已提交的 story 事件 id 全集（如 StoryEdgeV2.eventDependencies 的并集）。 */
  readonly knownEventIds?: readonly string[] | ReadonlySet<string>;
}

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

/** 深度冻结（一次性资产冻结；冻结是幂等的，重复校验同一 canon 安全）。 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
}

/**
 * Kahn 剥壳后仍残留的性格状态（自环已单独诊断，不计入）：环上的状态与环下游状态。
 * 成长轨迹必须无环——环意味着某状态引用了只能由自身链路引入的状态（引用不可解析）。
 * 输出按状态 id 升序排序（确定性）；无环返回 []。
 */
function residualCycleStates(edges: readonly CharacterCanonGrowthEdgeV1[]): readonly string[] {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  const seenTransitions = new Set<string>();
  for (const edge of edges) {
    // 自环已单独诊断（canon_growth_edge_self_loop）；重复转移是并行边，不构成环。
    if (edge.from === edge.to) continue;
    const transition = `${edge.from}\u0000${edge.to}`;
    if (seenTransitions.has(transition)) continue;
    seenTransitions.add(transition);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!indegree.has(edge.from)) indegree.set(edge.from, 0);
    const targets = successors.get(edge.from) ?? [];
    targets.push(edge.to);
    successors.set(edge.from, targets);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([state]) => state);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of successors.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  return [...indegree.entries()].filter(([, degree]) => degree > 0).map(([state]) => state).sort(compareText);
}

/**
 * 归一引用上下文的已知事件全集。调用方可传数组或 Set；内容非法时返回显式诊断
 * 而不是静默吞掉坏输入。
 */
function knownEventContext(context: CharacterCanonValidationContextV1 | undefined): {
  readonly events?: ReadonlySet<string>;
  readonly diagnostic?: NarrativeDiagnosticV1;
} {
  const known = context?.knownEventIds;
  if (known === undefined) return {};
  if (!(known instanceof Set) && !Array.isArray(known)) {
    return { diagnostic: narrativeErrorV1("canon_context_events_invalid", "context.knownEventIds", "context.knownEventIds must be an array or Set of non-empty event id strings.") };
  }
  const events = new Set<string>();
  for (const id of known) {
    if (!isNonEmptyString(id)) {
      return { diagnostic: narrativeErrorV1("canon_context_events_invalid", "context.knownEventIds", "context.knownEventIds must contain only non-empty event id strings.") };
    }
    events.add(id);
  }
  return { events };
}

/**
 * Character Canon 结构校验：收集全部诊断（不做 fail-fast），顺序与输入顺序一致（确定性）。
 * 覆盖：
 * - 容器/id 形状：storyId、characterId、displayName 非空字符串；version 为 ≥1 的整数。
 * - backstory ≤ 2 KiB（UTF-8 字节）。
 * - growthEdge 条目形状、自环（from === to）、重复 (from,to) 转移。
 * - growthEdge 引用存在性：轨迹状态图必须无环（环即引用不可解析）；提供
 *   `context.knownEventIds` 时逐条校验 requireEvent 是否引用已知事件。
 * 合法时 ok=true：对 canon 深度冻结并原引用返回（设计者版本化资产不可变）；
 * 失败时 ok=false 且 diagnostics 至少一条（V3-12：失败绝不返回空成功报告），输入不被触碰。
 */
export function validateCharacterCanonV1(
  canon: CharacterCanonV1,
  context?: CharacterCanonValidationContextV1,
): NarrativeResult<CharacterCanonV1> {
  if (!isRecord(canon)) {
    return narrativeFailureV1([narrativeErrorV1("canon_malformed", "$", "Character canon must be an object.")]);
  }
  const diagnostics: NarrativeDiagnosticV1[] = [];

  if (!isNonEmptyString(canon.storyId)) {
    diagnostics.push(narrativeErrorV1("canon_story_id_invalid", "storyId", "storyId must be a non-empty string."));
  }
  if (!isNonEmptyString(canon.characterId)) {
    diagnostics.push(narrativeErrorV1("canon_character_id_invalid", "characterId", "characterId must be a non-empty string."));
  }
  if (!isNonEmptyString(canon.displayName)) {
    diagnostics.push(narrativeErrorV1("canon_display_name_invalid", "displayName", "displayName must be a non-empty string."));
  }
  if (!isNonNegativeInteger(canon.version) || canon.version < 1) {
    diagnostics.push(narrativeErrorV1("canon_version_invalid", "version", "version must be an integer >= 1."));
  }
  if (canon.backstory !== undefined) {
    if (typeof canon.backstory !== "string") {
      diagnostics.push(narrativeErrorV1("canon_backstory_invalid", "backstory", "backstory must be a string when present."));
    } else if (utf8ByteLength(canon.backstory) > CANON_BACKSTORY_MAX_BYTES_V1) {
      diagnostics.push(narrativeErrorV1(
        "canon_backstory_too_large", "backstory",
        `backstory exceeds ${CANON_BACKSTORY_MAX_BYTES_V1} UTF-8 bytes.`,
      ));
    }
  }

  const known = knownEventContext(context);
  if (known.diagnostic) diagnostics.push(known.diagnostic);

  const growthEdges = canon.growthEdges;
  const wellFormedEdges: CharacterCanonGrowthEdgeV1[] = [];
  if (growthEdges !== undefined) {
    if (!Array.isArray(growthEdges)) {
      diagnostics.push(narrativeErrorV1("canon_growth_edges_invalid", "growthEdges", "growthEdges must be an array of growth edges."));
    } else {
      const seenTransitions = new Set<string>();
      for (const [index, edge] of growthEdges.entries()) {
        const path = `growthEdges[${index}]`;
        if (!isRecord(edge)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_malformed", path, "Growth edge entry must be an object."));
          continue;
        }
        if (!isNonEmptyString(edge.from)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_from_invalid", `${path}.from`, "Growth edge from must be a non-empty string."));
        }
        if (!isNonEmptyString(edge.to)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_to_invalid", `${path}.to`, "Growth edge to must be a non-empty string."));
        }
        if (!isNonEmptyString(edge.requireEvent)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_event_invalid", `${path}.requireEvent`, "Growth edge requireEvent must be a non-empty story event id."));
        }
        if (!isNonEmptyString(edge.from) || !isNonEmptyString(edge.to) || !isNonEmptyString(edge.requireEvent)) continue;
        if (edge.from === edge.to) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_self_loop", path, `Growth edge "${edge.requireEvent}" is a self loop on state "${edge.from}".`));
        }
        const transition = `${edge.from}\u0000${edge.to}`;
        if (seenTransitions.has(transition)) {
          diagnostics.push(narrativeErrorV1("canon_growth_edge_duplicate", path, `Growth transition "${edge.from}" -> "${edge.to}" is declared more than once.`));
        }
        seenTransitions.add(transition);
        wellFormedEdges.push(edge as unknown as CharacterCanonGrowthEdgeV1);
      }

      if (known.events !== undefined) {
        for (const [index, edge] of wellFormedEdges.entries()) {
          if (!known.events.has(edge.requireEvent)) {
            diagnostics.push(narrativeErrorV1(
              "canon_growth_edge_event_missing", `growthEdges[${index}].requireEvent`,
              `Growth edge references unknown story event "${edge.requireEvent}".`,
            ));
          }
        }
      }

      const residual = residualCycleStates(wellFormedEdges);
      if (residual.length > 0) {
        diagnostics.push(narrativeErrorV1(
          "canon_growth_edge_cycle", "growthEdges",
          `Growth trajectory contains a cycle; allowed growth must be acyclic. States involved: ${residual.join(", ")}.`,
        ));
      }
    }
  }

  if (diagnostics.length > 0) return narrativeFailureV1(diagnostics);
  deepFreeze(canon);
  return { ok: true, value: canon, diagnostics: [] };
}
