import type { EntitySnapshotV1, EntityTransformV1 } from "../api/types";
import { GameSdkError } from "../protocol/errors";
import { readProps, readTransform, readVec3 } from "./json";

type EntityRecordV1 = {
  id: string;
  prefabId: string;
  transform: EntityTransformV1;
  props: Readonly<Record<string, unknown>>;
};

/**
 * Run-owned entity table. Ownership is structural: the store belongs to one
 * host, so an id from another run simply does not exist here. The store never
 * hands out its internal records — snapshots are cloned and frozen, otherwise
 * a game could mutate host state by keeping a reference.
 */
export class EntityStoreV1 {
  private readonly items = new Map<string, EntityRecordV1>();
  private counter = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.size;
  }

  spawn(prefabId: string, transform: unknown, props: unknown): EntitySnapshotV1 {
    if (this.items.size >= this.capacity) {
      throw new GameSdkError(
        "game_entity_budget_exceeded",
        `Entity budget exhausted: this game may own at most ${this.capacity} entities at once.`,
        "runtime",
        "Lower the spawn rate or destroy finished entities.",
      );
    }
    const record: EntityRecordV1 = {
      id: `e${(this.counter += 1)}`,
      prefabId,
      transform: readTransform(transform, "transform"),
      props: props === undefined ? Object.freeze({}) : readProps(props, "props"),
    };
    this.items.set(record.id, record);
    return this.snapshot(record);
  }

  update(id: string, patch: unknown): EntitySnapshotV1 {
    const record = this.items.get(id);
    if (!record) throw new GameSdkError("game_entity_unknown", `Entity ${id} does not belong to this run.`);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new GameSdkError("game_argument_invalid", "update() patch must be an object.");
    }
    const raw = patch as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!["position", "rotation", "scale", "props"].includes(key)) {
        throw new GameSdkError("game_argument_invalid", `update() does not accept "${key}".`);
      }
    }
    const nextTransform: EntityTransformV1 = Object.freeze({
      ...record.transform,
      ...(raw.position !== undefined ? { position: readVec3(raw.position, "patch.position") } : {}),
      ...(raw.rotation !== undefined ? { rotation: readVec3(raw.rotation, "patch.rotation") } : {}),
      ...(raw.scale !== undefined ? { scale: readVec3(raw.scale, "patch.scale") } : {}),
    });
    const nextProps =
      raw.props === undefined
        ? record.props
        : Object.freeze({ ...record.props, ...readProps(raw.props, "patch.props") });
    const updated: EntityRecordV1 = { ...record, transform: nextTransform, props: nextProps };
    this.items.set(id, updated);
    return this.snapshot(updated);
  }

  get(id: string): EntitySnapshotV1 {
    const record = this.items.get(id);
    if (!record) throw new GameSdkError("game_entity_unknown", `Entity ${id} does not belong to this run.`);
    return this.snapshot(record);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  query(prefabId?: string): readonly EntitySnapshotV1[] {
    const records = [...this.items.values()]
      .filter((record) => prefabId === undefined || record.prefabId === prefabId)
      .sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));
    return Object.freeze(records.map((record) => this.snapshot(record)));
  }

  destroy(id: string): boolean {
    return this.items.delete(id);
  }

  /** Removes and returns everything left. Used by the host's disposal path;
   * the render port receives one destroy per entity so no visual ghost stays
   * in the City after the run ends. */
  drain(): readonly EntitySnapshotV1[] {
    const snapshots = [...this.items.values()].map((record) => this.snapshot(record));
    this.items.clear();
    return Object.freeze(snapshots);
  }

  private snapshot(record: EntityRecordV1): EntitySnapshotV1 {
    return Object.freeze({
      id: record.id,
      prefabId: record.prefabId,
      transform: record.transform,
      props: record.props,
    });
  }
}
