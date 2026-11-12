/**
 * Creator 静态模板 pack（设计文档 §5.1.2/§6.1）：声明式小游戏定义的唯一来源。
 * 与 Rust `game_template` 逐字段一致（迁移完成后 Rust 从生成资产读取并删除字面量）。
 * pack 由 city-sdk 的 validateMiniGamePack 校验；脚本与未知动作会被拒绝。
 */

export type CreatorTemplateV1 = {
  id: string;
  label: string;
  pack: {
    schemaVersion: 1;
    id: string;
    rulesVersion: 1;
    slots: Record<string, { kind: "zone"; min: number; max: number; requires: string[] }>;
    integerParameters: Record<string, { min: number; max: number; default: number }>;
    rules: {
      counters: Record<string, { initial: number; max: number }>;
      nodes: Array<{
        id: string;
        on: { type: string; slot?: string; timerId?: string };
        when?: Array<{ op: string; counter?: string; value?: number }>;
        actions: Array<Record<string, unknown>>;
      }>;
    };
  };
};

export const CREATOR_TEMPLATES_V1: readonly CreatorTemplateV1[] = Object.freeze<CreatorTemplateV1[]>([
  {
    id: "checkpoint-race",
    label: "驾驶检查点竞速",
    pack: {
      schemaVersion: 1,
      id: "creator.checkpoint-race",
      rulesVersion: 1,
      slots: { points: { kind: "zone", min: 3, max: 8, requires: ["drive"] } },
      integerParameters: { timeLimitTicks: { min: 60, max: 36000, default: 2700 } },
      rules: {
        counters: { next: { initial: 0, max: 3 } },
        nodes: [
          { id: "start-timer", on: { type: "run.started" }, actions: [{ op: "timer.start", timerId: "timeout", durationTicks: { parameter: "timeLimitTicks" } }] },
          { id: "advance", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eqEventIndex", counter: "next" }], actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
          { id: "finish", on: { type: "zone.entered", slot: "points" }, when: [{ op: "counter.eq", counter: "next", value: 3 }], actions: [{ op: "run.finish", outcome: "success" }] },
          { id: "timeout", on: { type: "timer.expired", timerId: "timeout" }, actions: [{ op: "run.finish", outcome: "failure" }] },
        ],
      },
    },
  },
  {
    id: "collect-one",
    label: "驾驶区域收集",
    pack: {
      schemaVersion: 1,
      id: "creator.collect-one",
      rulesVersion: 1,
      slots: { targets: { kind: "zone", min: 1, max: 1, requires: ["drive"] } },
      integerParameters: {},
      rules: {
        counters: { found: { initial: 0, max: 1 } },
        nodes: [
          { id: "collect", on: { type: "zone.entered", slot: "targets" }, actions: [{ op: "counter.add", counter: "found", amount: 1 }] },
          { id: "finish", on: { type: "zone.entered", slot: "targets" }, when: [{ op: "counter.eq", counter: "found", value: 1 }], actions: [{ op: "run.finish", outcome: "success" }] },
        ],
      },
    },
  },
]);
