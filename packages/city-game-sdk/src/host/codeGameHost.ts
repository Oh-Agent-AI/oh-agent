import type {
  AudioAPIV1,
  CitySnapshotV1,
  EntityAPIV1,
  EntityPatchV1,
  EntitySnapshotV1,
  EntityTransformV1,
  EventAPIV1,
  GameContextV1,
  GameEventMapV1,
  GameEventTypeV1,
  GameOutcomeV1,
  InputAPIV1,
  RouteV1,
  UiAPIV1,
  UnsubscribeV1,
  WorldAnchorV1,
  WorldAPIV1,
  WorldBoundsV1,
  WorldObjectV1,
} from "../api/types";
import { isGameDefinitionV1, type GameDefinitionV1 } from "../api/defineGame";
import type { GameDiagnosticV1 } from "../protocol/diagnostics";
import { GameSdkError, asGameSdkError } from "../protocol/errors";
import type { GamePermissionV1 } from "../protocol/permissions";
import {
  validateCodeGameManifestV1,
  type CodeGameAssetV1,
  type CodeGameManifestV1,
} from "../protocol/manifest";
import { EntityStoreV1 } from "./entities";
import { cloneJson, isPlainRecord, readBounds } from "./json";
import { SeededRandomV1, normalizeSeed } from "./random";
import type {
  CodeGameHostOptionsV1,
  CodeGameHostStatusV1,
  GameTelemetryV1,
  RenderPortV1,
  WorldSourceV1,
} from "./types";

type EventHandlerV1 = (payload: unknown) => void;

const EVENT_TYPES: readonly GameEventTypeV1[] = ["entity.clicked", "zone.entered", "ui.action"];
const isEventType = (value: unknown): value is GameEventTypeV1 =>
  typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);

const OBJECT_QUERY_LIMIT = 64;
const MAX_INPUT_KEYS = 32;
const MAX_AUDIO_KEYS = 16;

/**
 * One host owns exactly one run. The public game context is a facade over a
 * permission-checked world source, a run-scoped entity table and a seeded
 * random stream; nothing here knows about Three.js, React, Tauri or the City
 * engine, which is what lets the same host run headless in tests.
 *
 * The lifecycle is deliberately explicit rather than promise-shaped:
 *
 *   created → preparing → ready → running ⇄ paused → finished
 *                                ↘ failed
 *
 * Every terminal transition funnels through `disposeInternal`, which runs game
 * cleanups (LIFO, then the setup-returned disposer), destroys every entity
 * through the render port and clears listeners/input/audio exactly once. That
 * single path is the only defense against AC-05 ghost entities.
 */
export class CodeGameHostV1 {
  readonly manifest: CodeGameManifestV1;
  readonly runId: string;
  readonly seed: number;
  readonly fixedDtSeconds: number;

  private readonly worldSource: WorldSourceV1;
  private readonly now: () => number;
  private readonly render: RenderPortV1 | null;
  private readonly hudByteLimit: number;
  private readonly permissions: ReadonlySet<GamePermissionV1>;
  private readonly assets: ReadonlyMap<string, CodeGameAssetV1>;
  private readonly entities: EntityStoreV1;
  private readonly rng: SeededRandomV1;
  private readonly context: GameContextV1;

  private readonly fixedHandlers: Array<(dtSeconds: number) => void> = [];
  private readonly disposers: Array<() => void> = [];
  private readonly listeners = new Map<GameEventTypeV1, Set<EventHandlerV1>>();
  private readonly audioState = new Map<string, Readonly<{ volume: number; loop: boolean }>>();
  private readonly diagnosticsList: GameDiagnosticV1[] = [];
  private readonly counters = {
    spawns: 0,
    destroys: 0,
    fixedUpdates: 0,
    hudUpdates: 0,
    audioPlays: 0,
    events: 0,
    errors: 0,
  };

  private cityCache: CitySnapshotV1 | null = null;
  private routesCache: readonly RouteV1[] | null = null;
  private anchorsCache: readonly WorldAnchorV1[] | null = null;

  private statusValue: CodeGameHostStatusV1 = "created";
  private tickCount = 0;
  private outcomeValue: GameOutcomeV1 | null = null;
  private reasonValue: string | null = null;
  private hudValue: Readonly<Record<string, unknown>> | null = null;
  private inputValue: Readonly<Record<string, number | boolean>> = Object.freeze({});
  private finalDisposer: (() => void) | null = null;
  private disposed = false;
  private disposing = false;

  constructor(options: CodeGameHostOptionsV1) {
    this.manifest = options.manifest;
    this.worldSource = options.world;
    this.seed = normalizeSeed(options.seed);
    this.fixedDtSeconds = validateFixedDt(options.fixedDtSeconds ?? 1 / 60);
    this.runId = validateRunId(options.runId, this.seed);
    this.now = options.nowMs ?? (() => 0);
    if (typeof this.now !== "function") {
      throw new GameSdkError("game_argument_invalid", "nowMs must be a function.");
    }
    this.render = options.render ?? null;
    this.hudByteLimit = validateHudLimit(options.hudByteLimit ?? 8192);
    this.permissions = new Set(this.manifest.permissions);
    this.assets = new Map(this.manifest.assets.map((asset) => [asset.id, asset]));
    this.entities = new EntityStoreV1(this.manifest.limits.maxEntities);
    this.rng = new SeededRandomV1(this.seed);
    this.context = this.createContext();
  }

  get status(): CodeGameHostStatusV1 {
    return this.statusValue;
  }

  get tick(): number {
    return this.tickCount;
  }

  get api(): GameContextV1 {
    return this.context;
  }

  get entityCount(): number {
    return this.entities.size;
  }

  async prepare(definition: GameDefinitionV1): Promise<void> {
    if (this.statusValue !== "created") {
      throw new GameSdkError(
        "game_argument_invalid",
        `prepare() requires a freshly created host (status ${this.statusValue}).`,
      );
    }
    if (!isGameDefinitionV1(definition)) {
      throw new GameSdkError(
        "game_entry_invalid",
        "The bundle must export a GameDefinitionV1 with an id and setup().",
        "prepare",
      );
    }
    if (definition.id !== this.manifest.gameId) {
      throw new GameSdkError(
        "game_entry_invalid",
        `Bundle exports "${definition.id}" but the manifest declares "${this.manifest.gameId}".`,
        "prepare",
      );
    }
    this.statusValue = "preparing";
    try {
      const returned = await definition.setup(this.context);
      if (this.disposed || this.disposing) return;
      if (typeof returned === "function") this.finalDisposer = returned;
      this.statusValue = "ready";
    } catch (error) {
      if (this.disposed || this.disposing) return;
      throw this.fail(error, "prepare");
    }
  }

  start(): void {
    this.requireStatus("start", ["ready"]);
    this.statusValue = "running";
  }

  pause(): void {
    this.requireStatus("pause", ["running"]);
    this.statusValue = "paused";
  }

  resume(): void {
    this.requireStatus("resume", ["paused"]);
    this.statusValue = "running";
  }

  /** Exactly one authoritative fixed step. Paused, finished and disposed hosts
   * ignore it so a City frame hook can call step() unconditionally. */
  step(): void {
    if (this.statusValue !== "running") return;
    this.tickCount += 1;
    this.counters.fixedUpdates += 1;
    for (const handler of [...this.fixedHandlers]) {
      if (this.statusValue !== "running") break;
      try {
        handler(this.fixedDtSeconds);
      } catch (error) {
        throw this.fail(error);
      }
    }
  }

  finish(outcome: GameOutcomeV1, reason?: string): void {
    if (this.statusValue !== "running" && this.statusValue !== "ready") {
      throw new GameSdkError(
        "game_argument_invalid",
        `finish() requires a running game (status ${this.statusValue}).`,
      );
    }
    if (outcome !== "success" && outcome !== "failure") {
      throw new GameSdkError("game_argument_invalid", 'finish() outcome must be "success" or "failure".');
    }
    this.outcomeValue = outcome;
    this.reasonValue = reason === undefined ? null : boundReason(reason);
    this.statusValue = "finished";
    this.disposeInternal("finished");
  }

  stop(reason = "stopped"): void {
    if (this.disposed || this.disposing) return;
    if (this.statusValue === "finished" || this.statusValue === "failed") return;
    this.statusValue = "finished";
    this.reasonValue = boundReason(reason);
    this.disposeInternal("stopped");
  }

  dispose(): void {
    if (this.disposed || this.disposing) return;
    if (this.statusValue !== "finished" && this.statusValue !== "failed") {
      this.statusValue = "disposed";
    }
    this.disposeInternal("disposed");
  }

  telemetry(): GameTelemetryV1 {
    return Object.freeze({
      runId: this.runId,
      status: this.statusValue,
      disposed: this.disposed,
      tick: this.tickCount,
      outcome: this.outcomeValue,
      reason: this.reasonValue,
      entities: this.entities.size,
      hud: this.hudValue,
      counters: Object.freeze({ ...this.counters }),
      diagnostics: this.diagnosticsList.length,
    });
  }

  hud(): Readonly<Record<string, unknown>> | null {
    return this.hudValue;
  }

  diagnostics(): readonly GameDiagnosticV1[] {
    return Object.freeze([...this.diagnosticsList]);
  }

  /** Host-side input push. Normalized scalars only; a game can never mutate the
   * snapshot it reads back. */
  setInput(next: Readonly<Record<string, number | boolean>>): void {
    if (!isPlainRecord(next)) {
      throw new GameSdkError("game_argument_invalid", "setInput() expects a plain object.");
    }
    const normalized: Record<string, number | boolean> = {};
    let count = 0;
    for (const [key, value] of Object.entries(next)) {
      if (count >= MAX_INPUT_KEYS) {
        throw new GameSdkError("game_argument_invalid", `setInput() accepts at most ${MAX_INPUT_KEYS} keys.`);
      }
      if (key.length === 0 || key.length > 64) {
        throw new GameSdkError("game_argument_invalid", "Input keys must be 1..64 characters.");
      }
      if (typeof value === "boolean") normalized[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
      else throw new GameSdkError("game_argument_invalid", `Input "${key}" must be a boolean or a finite number.`);
      count += 1;
    }
    this.inputValue = Object.freeze(normalized);
  }

  /** Host-side event delivery (pointer picking, zones, HUD buttons). */
  emit<K extends GameEventTypeV1>(type: K, payload: GameEventMapV1[K]): void {
    if (this.disposed || this.disposing) return;
    if (!isEventType(type)) {
      throw new GameSdkError("game_argument_invalid", `Unknown event "${String(type)}".`);
    }
    const handlers = this.listeners.get(type);
    if (!handlers || handlers.size === 0) return;
    const cloned = cloneJson(payload, `event "${type}"`, 4096, "game_argument_invalid");
    this.counters.events += 1;
    for (const handler of [...handlers]) {
      try {
        handler(cloned);
      } catch (error) {
        throw this.fail(error);
      }
    }
  }

  private createContext(): GameContextV1 {
    const world: WorldAPIV1 = Object.freeze({
      city: () => this.readCity(),
      listRoutes: () => this.readRoutes(),
      getRoute: (routeId: string) => this.readRoute(routeId),
      sampleTerrain: (x: number, z: number) => this.readTerrain(x, z),
      listAnchors: () => this.readAnchors(),
      queryObjects: (bounds: WorldBoundsV1) => this.readObjects(bounds),
    });

    const entities: EntityAPIV1 = Object.freeze({
      spawn: (prefabId: string, transform: EntityTransformV1, props?: Readonly<Record<string, unknown>>) =>
        this.spawnEntity(prefabId, transform, props),
      update: (entityId: string, patch: EntityPatchV1) => this.updateEntity(entityId, patch),
      get: (entityId: string) => this.getEntity(entityId),
      query: (filter?: Readonly<{ prefabId?: string }>) => this.queryEntities(filter),
      destroy: (entityId: string) => this.destroyEntity(entityId),
    });

    const events: EventAPIV1 = Object.freeze({
      on: <K extends GameEventTypeV1>(type: K, handler: (payload: GameEventMapV1[K]) => void) =>
        this.subscribe(type, handler),
    });

    const input: InputAPIV1 = Object.freeze({
      actions: () => {
        this.require("input.read");
        return this.inputValue;
      },
    });

    const ui: UiAPIV1 = Object.freeze({
      setHud: (snapshot: Readonly<Record<string, unknown>>) => this.setHud(snapshot),
    });

    const audio: AudioAPIV1 = Object.freeze({
      play: (assetId: string, options?: Readonly<{ volume?: number; loop?: boolean }>) =>
        this.playAudio(assetId, options),
      stop: (assetId: string) => this.stopAudio(assetId),
    });

    const clock = Object.freeze({
      fixedDtSeconds: this.fixedDtSeconds,
      nowMs: () => this.now(),
    });

    const random = Object.freeze({
      next: () => this.rng.next(),
      int: (minInclusive: number, maxExclusive: number) => this.rng.int(minInclusive, maxExclusive),
    });

    return Object.freeze({
      world,
      entities,
      events,
      input,
      ui,
      audio,
      clock,
      random,
      onFixedUpdate: (fn: (dtSeconds: number) => void) => this.addFixedHandler(fn),
      onDispose: (fn: () => void) => this.addDisposer(fn),
      finish: (outcome: GameOutcomeV1, reason?: string) => this.finish(outcome, reason),
    });
  }

  private addFixedHandler(fn: (dtSeconds: number) => void): UnsubscribeV1 {
    if (typeof fn !== "function") {
      throw new GameSdkError("game_argument_invalid", "onFixedUpdate() expects a function.");
    }
    if (this.disposed || this.disposing) return () => {};
    this.fixedHandlers.push(fn);
    return () => {
      const index = this.fixedHandlers.indexOf(fn);
      if (index >= 0) this.fixedHandlers.splice(index, 1);
    };
  }

  private addDisposer(fn: () => void): UnsubscribeV1 {
    if (typeof fn !== "function") {
      throw new GameSdkError("game_argument_invalid", "onDispose() expects a function.");
    }
    if (this.disposed || this.disposing) return () => {};
    this.disposers.push(fn);
    return () => {
      const index = this.disposers.indexOf(fn);
      if (index >= 0) this.disposers.splice(index, 1);
    };
  }

  private subscribe<K extends GameEventTypeV1>(
    type: K,
    handler: (payload: GameEventMapV1[K]) => void,
  ): UnsubscribeV1 {
    if (!isEventType(type)) {
      throw new GameSdkError("game_argument_invalid", `Unknown event "${String(type)}".`);
    }
    if (typeof handler !== "function") {
      throw new GameSdkError("game_argument_invalid", "events.on() expects a handler function.");
    }
    if (this.disposed || this.disposing) return () => {};
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set<EventHandlerV1>();
      this.listeners.set(type, handlers);
    }
    const wrapped: EventHandlerV1 = (payload) => handler(payload as GameEventMapV1[K]);
    handlers.add(wrapped);
    return () => {
      handlers.delete(wrapped);
    };
  }

  private require(permission: GamePermissionV1): void {
    if (this.disposed) {
      throw new GameSdkError("game_runtime_fault", "The run is already disposed.");
    }
    if (!this.permissions.has(permission)) {
      throw new GameSdkError(
        "game_permission_denied",
        `The manifest does not grant "${permission}".`,
        "runtime",
        "Declare the permission in game.manifest.json, rebuild, and re-run.",
      );
    }
  }

  private readCity(): CitySnapshotV1 {
    this.require("world.read");
    if (this.cityCache === null) this.cityCache = cloneJson(this.worldSource.city(), "city", 8192, "game_runtime_fault");
    return this.cityCache;
  }

  private readRoutes(): readonly RouteV1[] {
    this.require("roads.read");
    if (this.routesCache === null) this.routesCache = cloneJson(this.worldSource.listRoutes(), "routes", 65536, "game_runtime_fault");
    return this.routesCache;
  }

  private readRoute(routeId: string): RouteV1 {
    this.require("roads.read");
    if (typeof routeId !== "string" || routeId.length === 0) {
      throw new GameSdkError("game_argument_invalid", "getRoute() expects a route id.");
    }
    const route = this.worldSource.getRoute(routeId);
    if (!route) {
      throw new GameSdkError(
        "game_world_object_missing",
        `Route "${routeId}" does not exist in this City revision.`,
        "runtime",
        "List routes with world.listRoutes() instead of assuming an id.",
      );
    }
    return cloneJson(route, `route "${routeId}"`, 65536, "game_runtime_fault");
  }

  private readTerrain(x: number, z: number): { height: number; normal: readonly [number, number, number]; walkable: boolean } {
    this.require("terrain.sample");
    for (const [label, value] of [
      ["x", x],
      ["z", z],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new GameSdkError("game_argument_invalid", `sampleTerrain() expects a finite ${label}.`);
      }
    }
    const sample = this.worldSource.sampleTerrain(x, z);
    if (!sample) {
      throw new GameSdkError("game_world_object_missing", "Terrain is unavailable at this position.");
    }
    return cloneJson(sample, "terrain sample", 1024, "game_runtime_fault");
  }

  private readAnchors(): readonly WorldAnchorV1[] {
    this.require("world.read");
    if (this.anchorsCache === null) this.anchorsCache = cloneJson(this.worldSource.listAnchors(), "anchors", 65536, "game_runtime_fault");
    return this.anchorsCache;
  }

  private readObjects(bounds: WorldBoundsV1): readonly WorldObjectV1[] {
    this.require("world.read");
    const checked = readBounds(bounds, "bounds");
    const objects = this.worldSource.queryObjects(checked);
    if (!Array.isArray(objects)) {
      throw new GameSdkError("game_runtime_fault", "World source returned a non-array object query.");
    }
    return cloneJson(objects.slice(0, OBJECT_QUERY_LIMIT), "world objects", 65536, "game_runtime_fault");
  }

  private spawnEntity(
    prefabId: string,
    transform: EntityTransformV1,
    props?: Readonly<Record<string, unknown>>,
  ): string {
    this.require("entities.write.owned");
    if (typeof prefabId !== "string" || prefabId.length === 0) {
      throw new GameSdkError("game_argument_invalid", "spawn() expects a prefab id.");
    }
    const asset = this.assets.get(prefabId);
    if (!asset || asset.type !== "model/glb") {
      throw new GameSdkError(
        "game_asset_invalid",
        `Prefab "${prefabId}" is not a model/glb asset declared by the manifest.`,
        "runtime",
        "Declare the prefab under assets[] with type model/glb.",
      );
    }
    const snapshot = this.entities.spawn(prefabId, transform, props);
    this.counters.spawns += 1;
    this.render?.spawn(snapshot);
    return snapshot.id;
  }

  private updateEntity(entityId: string, patch: EntityPatchV1): EntitySnapshotV1 {
    this.require("entities.write.owned");
    const snapshot = this.entities.update(entityId, patch);
    this.render?.update(snapshot);
    return snapshot;
  }

  private getEntity(entityId: string): EntitySnapshotV1 {
    this.require("entities.write.owned");
    return this.entities.get(entityId);
  }

  private queryEntities(filter?: Readonly<{ prefabId?: string }>): readonly EntitySnapshotV1[] {
    this.require("entities.write.owned");
    let prefabId: string | undefined;
    if (filter !== undefined) {
      if (!isPlainRecord(filter)) {
        throw new GameSdkError("game_argument_invalid", "query() filter must be an object.");
      }
      if (filter.prefabId !== undefined && typeof filter.prefabId !== "string") {
        throw new GameSdkError("game_argument_invalid", "query() prefabId must be a string.");
      }
      prefabId = filter.prefabId;
    }
    return this.entities.query(prefabId);
  }

  private destroyEntity(entityId: string): boolean {
    this.require("entities.write.owned");
    if (typeof entityId !== "string" || entityId.length === 0) {
      throw new GameSdkError("game_argument_invalid", "destroy() expects an entity id.");
    }
    const destroyed = this.entities.destroy(entityId);
    if (destroyed) {
      this.counters.destroys += 1;
      this.render?.destroy(entityId);
    }
    return destroyed;
  }

  private setHud(snapshot: Readonly<Record<string, unknown>>): void {
    this.require("ui.hud");
    if (!isPlainRecord(snapshot)) {
      throw new GameSdkError("game_argument_invalid", "setHud() expects a plain object.");
    }
    const next = cloneJson(snapshot, "hud", this.hudByteLimit);
    const previous = this.hudValue === null ? "" : JSON.stringify(this.hudValue);
    if (previous === JSON.stringify(next)) return;
    this.hudValue = next;
    this.counters.hudUpdates += 1;
  }

  private playAudio(assetId: string, options?: Readonly<{ volume?: number; loop?: boolean }>): void {
    this.require("audio.play.assets");
    const asset = this.assets.get(assetId);
    if (!asset || asset.type !== "audio") {
      throw new GameSdkError(
        "game_asset_invalid",
        `Audio "${assetId}" is not an audio asset declared by the manifest.`,
      );
    }
    const volume = options?.volume ?? 1;
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new GameSdkError("game_argument_invalid", "audio.play() volume must be between 0 and 1.");
    }
    const loop = options?.loop ?? false;
    if (typeof loop !== "boolean") {
      throw new GameSdkError("game_argument_invalid", "audio.play() loop must be a boolean.");
    }
    if (!this.audioState.has(assetId) && this.audioState.size >= MAX_AUDIO_KEYS) {
      throw new GameSdkError("game_argument_invalid", `At most ${MAX_AUDIO_KEYS} audio assets may play at once.`);
    }
    this.audioState.set(assetId, Object.freeze({ volume, loop }));
    this.counters.audioPlays += 1;
  }

  private stopAudio(assetId: string): void {
    this.require("audio.play.assets");
    this.audioState.delete(assetId);
  }

  private requireStatus(action: string, allowed: readonly CodeGameHostStatusV1[]): void {
    if (!allowed.includes(this.statusValue)) {
      throw new GameSdkError(
        "game_argument_invalid",
        `${action}() requires status ${allowed.join(" or ")} (current: ${this.statusValue}).`,
      );
    }
  }

  private fail(error: unknown, stage: "prepare" | "runtime" = "runtime"): GameSdkError {
    const sdkError = asGameSdkError(error, "game_runtime_fault", stage);
    this.counters.errors += 1;
    this.diagnosticsList.push(sdkError.toDiagnostic(this.runId));
    if (this.statusValue !== "failed" && this.statusValue !== "disposed") this.statusValue = "failed";
    this.disposeInternal("failed");
    return sdkError;
  }

  /**
   * Single cleanup path. Game cleanups run before the host destroys entities so
   * a disposer can still read its own entities; the setup-returned disposer runs
   * last, after every individual onDispose handler.
   */
  private disposeInternal(reason: string): void {
    if (this.disposed || this.disposing) return;
    this.disposing = true;
    this.reasonValue = this.reasonValue ?? reason;

    for (const disposer of this.disposers.splice(0).reverse()) {
      this.runCleanup(disposer);
    }
    this.disposers.length = 0;
    if (this.finalDisposer !== null) {
      const final = this.finalDisposer;
      this.finalDisposer = null;
      this.runCleanup(final);
    }

    for (const snapshot of this.entities.drain()) {
      try {
        this.render?.destroy(snapshot.id);
      } catch (error) {
        this.counters.errors += 1;
        this.diagnosticsList.push(
          asGameSdkError(error, "game_runtime_fault").toDiagnostic(this.runId),
        );
      }
    }

    this.fixedHandlers.length = 0;
    this.listeners.clear();
    this.audioState.clear();
    this.inputValue = Object.freeze({});
    this.disposing = false;
    this.disposed = true;
  }

  private runCleanup(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.counters.errors += 1;
      this.diagnosticsList.push(asGameSdkError(error, "game_runtime_fault").toDiagnostic(this.runId));
    }
  }
}

function validateFixedDt(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 0.25) {
    throw new GameSdkError("game_argument_invalid", "fixedDtSeconds must be a finite number in (0, 0.25].");
  }
  return value;
}

function validateHudLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 256 || value > 65536) {
    throw new GameSdkError("game_argument_invalid", "hudByteLimit must be an integer from 256 to 65536.");
  }
  return value;
}

function validateRunId(value: string | undefined, seed: number): string {
  if (value === undefined) return `run-${seed.toString(16)}`;
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new GameSdkError("game_argument_invalid", "runId must be a non-empty string of at most 64 characters.");
  }
  return value;
}

function boundReason(value: string): string {
  if (typeof value !== "string") {
    throw new GameSdkError("game_argument_invalid", "reason must be a string.");
  }
  const trimmed = value.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** Manifest-validating factory. MCP receives JSON, so the unknown input must be
 * checked here rather than trusted through a type assertion. */
export function createCodeGameHostV1(
  manifestInput: unknown,
  options: Omit<CodeGameHostOptionsV1, "manifest">,
): CodeGameHostV1 {
  const parsed = validateCodeGameManifestV1(manifestInput);
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    throw new GameSdkError(
      first?.code ?? "game_manifest_invalid",
      first?.message ?? "Invalid code game manifest.",
      "static",
    );
  }
  return new CodeGameHostV1({ ...options, manifest: parsed.value });
}
