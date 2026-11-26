import { type NarrativeResult } from "./diagnostics";
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
export declare const CANON_BACKSTORY_MAX_BYTES_V1 = 2048;
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
export declare function validateCharacterCanonV1(canon: CharacterCanonV1, context?: CharacterCanonValidationContextV1): NarrativeResult<CharacterCanonV1>;
