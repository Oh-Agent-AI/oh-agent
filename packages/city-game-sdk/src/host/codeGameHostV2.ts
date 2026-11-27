import type {
  PlayerScopeV1,
  RoadEdgeDtoV2,
} from "@oh-agent/city-sdk/contracts";
import { defineGameV2, type DialogueAPIV1, type GameAbortSignalV1, type GameContextV2, type GameDefinitionV2, type StoryEventAPIV1, type WorldAPIV2 } from "../api/v2";
import type { GameContextV1, WorldAnchorV1, WorldBoundsV1 } from "../api/types";
import { evaluateGameInvocation, type GameAccessV1, type HostGrantV1 } from "../protocol/access";
import { GameSdkError } from "../protocol/errors";
import type { GamePermissionV2 } from "../protocol/permissions";
import { validateCodeGameManifestV2, type CodeGameManifestV2 } from "../protocol/manifestV2";
import { CodeGameHostV1, createCodeGameHostV1 } from "./codeGameHost";
import type { CodeGameHostOptionsV1, GameTelemetryV1 } from "./types";

export type CodeGameHostStatusV2 =
  | "created" | "preparing" | "ready" | "running" | "paused"
  | "stopping" | "stopped" | "finished" | "failed" | "cancelled" | "disposed";

export type CodeGameHostOptionsV2 = Readonly<{
  manifest: CodeGameManifestV2;
  world: WorldAPIV2;
  seed: number;
  runId: string;
  access: GameAccessV1;
  grant: HostGrantV1<PlayerScopeV1>;
  playerScope?: PlayerScopeV1;
  fixedDtSeconds?: number;
  nowMs?: () => number;
  render?: CodeGameHostOptionsV1["render"];
  hudByteLimit?: number;
  cleanupTimeoutMs?: number;
  story?: StoryEventAPIV1;
  dialogue?: DialogueAPIV1;
}>;

export class CodeGameHostV2 {
  readonly manifest: CodeGameManifestV2;
  readonly runId: string;

  private readonly options: CodeGameHostOptionsV2;
  private readonly inner: CodeGameHostV1;
  private readonly controller = new RunAbortController();
  private readonly disposers: Array<() => void | Promise<void>> = [];
  private startHandler: ((context: { signal: GameAbortSignalV1 }) => Promise<void>) | null = null;
  private startPromise: Promise<void> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private dialogueOpen = false;
  private statusValue: CodeGameHostStatusV2 = "created";

  constructor(options: CodeGameHostOptionsV2) {
    this.options = options;
    this.manifest = options.manifest;
    this.runId = options.runId;
    this.inner = createCodeGameHostV1(v1Manifest(options.manifest), {
      world: createV1WorldFromV2(options.world),
      seed: options.seed,
      runId: options.runId,
      fixedDtSeconds: options.fixedDtSeconds,
      nowMs: options.nowMs,
      render: options.render,
      hudByteLimit: options.hudByteLimit,
    });
  }

  get status(): CodeGameHostStatusV2 {
    return this.statusValue;
  }

  async prepare(definition: GameDefinitionV2): Promise<void> {
    if (this.statusValue !== "created") throw new GameSdkError("game_argument_invalid", "prepare() requires a new V2 host.", "prepare");
    const checked = defineGameV2(definition);
    if (checked.id !== this.manifest.gameId) throw new GameSdkError("game_entry_invalid", "The V2 bundle id does not match the manifest.", "prepare");
    this.statusValue = "preparing";
    const context = this.createContext();
    await this.inner.prepare({
      id: checked.id,
      setup: (_legacyContext: GameContextV1) => {
        checked.setup(context);
      },
    });
    if (this.controller.signal.aborted) throw new GameSdkError("game_run_cancelled", "The V2 run was cancelled during prepare.", "prepare");
    this.statusValue = "ready";
  }

  async start(): Promise<void> {
    if (this.statusValue !== "ready") throw new GameSdkError("game_argument_invalid", "start() requires a prepared V2 host.", "prepare");
    this.statusValue = "running";
    this.inner.start();
    const handler = this.startHandler;
    if (!handler) return;
    this.startPromise = handler({ signal: this.controller.signal });
    try {
      await this.startPromise;
      if (this.statusValue === "running" || this.statusValue === "paused") this.statusValue = "finished";
    } catch (error) {
      this.statusValue = this.controller.signal.aborted ? "cancelled" : "failed";
      await this.cleanup();
      throw error;
    }
    await this.cleanup();
  }

  step(): void {
    if (this.statusValue !== "running") return;
    this.inner.step();
    if (this.inner.status === "finished") this.statusValue = "finished";
    else if (this.inner.status === "failed") this.statusValue = "failed";
  }

  pause(): void {
    if (this.statusValue !== "running") return;
    this.statusValue = "paused";
    this.inner.pause();
  }

  resume(): void {
    if (this.statusValue !== "paused") return;
    this.statusValue = "running";
    this.inner.resume();
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped" || this.statusValue === "disposed") return;
    this.controller.abort();
    this.statusValue = "stopping";
    if (this.startPromise) await settleWithTimeout(this.startPromise, this.options.cleanupTimeoutMs ?? 1_000);
    await this.cleanup();
    this.statusValue = "stopped";
  }

  async dispose(): Promise<void> {
    if (this.statusValue === "disposed") return;
    this.controller.abort();
    if (this.startPromise) await settleWithTimeout(this.startPromise, this.options.cleanupTimeoutMs ?? 1_000);
    await this.cleanup();
    this.statusValue = "disposed";
  }

  telemetry(): Omit<GameTelemetryV1, "status"> & { status: CodeGameHostStatusV2 } {
    return Object.freeze({ ...this.inner.telemetry(), status: this.statusValue });
  }

  /** Host-side input push (PR08 automated playtest). Delegates to the V1 host's
   * bounded normalization (≤32 scalar keys, run-scoped, cleared on dispose) —
   * only the preview host that owns this run may call it; games still read the
   * snapshot through ctx.input.actions() and can never mutate it. */
  setInput(next: Readonly<Record<string, number | boolean>>): void {
    this.inner.setInput(next);
  }

  private checkPermission(permission: GamePermissionV2): void {
    const decision = evaluateGameInvocation(permission, {
      runId: this.runId,
      ...(this.options.playerScope ? { playerScope: this.options.playerScope } : {}),
    }, this.options.access, this.options.grant);
    if (!decision.ok) throw new GameSdkError("game_permission_denied", `V2 capability access denied: ${decision.reason}.`, "runtime");
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      for (const disposer of this.disposers.splice(0).reverse()) {
        try {
          await settleWithTimeout(Promise.resolve().then(disposer), this.options.cleanupTimeoutMs ?? 1_000);
        } catch {
          // Cleanup is best effort after cancellation; the inner host still releases its resources.
        }
      }
      if (this.dialogueOpen) {
        this.dialogueOpen = false;
        try { this.options.dialogue?.close(); } catch { /* dialogue cleanup remains best effort */ }
      }
      this.inner.dispose();
    })();
    return this.cleanupPromise;
  }

  private createContext(): GameContextV2 {
    const legacy = this.inner.api;
    const world = grantCheckedWorld(this.options);
    const story = this.options.story;
    const dialogue = this.options.dialogue;
    const checkedDialogue: DialogueAPIV1 | undefined = dialogue ? {
      open: async (input) => {
        this.checkPermission("ui.dialogue");
        validateDialogueInput(input);
        if (this.dialogueOpen) throw new GameSdkError("game_dialogue_busy", "Only one dialogue may be open per run.", "runtime");
        this.dialogueOpen = true;
        try { return await dialogue.open(input); } finally { this.dialogueOpen = false; }
      },
      close: () => {
        this.checkPermission("ui.dialogue");
        this.dialogueOpen = false;
        dialogue.close();
      },
    } : undefined;
    const checkedStory: StoryEventAPIV1 | undefined = story ? {
      resolveLocalTime: (input) => {
        this.checkPermission("time.read");
        return story.resolveLocalTime(input);
      },
      schedule: (rule, options) => {
        this.checkPermission("story.schedule");
        return story.schedule(rule, options);
      },
      cancel: (ruleId, options) => {
        this.checkPermission("story.schedule");
        return story.cancel(ruleId, options);
      },
      list: () => {
        this.checkPermission("story.schedule");
        return story.list();
      },
    } : undefined;
    return Object.freeze({
      ...legacy,
      world,
      signal: this.controller.signal,
      onStart: (handler: (context: { signal: GameAbortSignalV1 }) => Promise<void>) => {
        if (this.startHandler) throw new GameSdkError("game_argument_invalid", "A V2 game can register only one onStart handler.", "prepare");
        this.startHandler = handler;
      },
      onDispose: (handler: () => void | Promise<void>) => {
        this.disposers.push(handler);
        return () => {
          const index = this.disposers.indexOf(handler);
          if (index >= 0) this.disposers.splice(index, 1);
        };
      },
      ...(checkedDialogue ? { dialogue: checkedDialogue } : {}),
      ...(checkedStory ? { story: checkedStory } : {}),
    }) as GameContextV2;
  }
}

export function createCodeGameHostV2(
  manifestInput: unknown,
  options: Omit<CodeGameHostOptionsV2, "manifest">,
): CodeGameHostV2 {
  const parsed = validateCodeGameManifestV2(manifestInput);
  if (!parsed.ok) {
    throw new GameSdkError("game_manifest_invalid", parsed.diagnostics[0]?.message ?? "Invalid V2 manifest.", "static");
  }
  return new CodeGameHostV2({ ...options, manifest: parsed.value });
}

class RunAbortController {
  private readonly listeners = new Set<() => void>();
  readonly signal: GameAbortSignalV1 = {
    aborted: false,
    addEventListener: (_type: "abort", listener: () => void, options?: { once?: boolean }) => {
      if (!options?.once) {
        this.listeners.add(listener);
        return;
      }
      const wrapped = () => {
        this.listeners.delete(wrapped);
        listener();
      };
      this.listeners.add(wrapped);
    },
  };

  abort(): void {
    if (this.signal.aborted) return;
    (this.signal as { aborted: boolean }).aborted = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

async function settleWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: unknown;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = hostTimers.setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) hostTimers.clearTimeout(timer);
  }
}

function validateDialogueInput(input: Parameters<DialogueAPIV1["open"]>[0]): void {
  const validText = (value: string, max: number) => value.trim().length > 0 && [...value].length <= max;
  if (!input || typeof input !== "object" || !input.speaker || !validText(input.speaker.displayName, 80) || !validText(input.text, 4_000)
    || (input.speaker.residentId !== undefined && !validText(input.speaker.residentId, 128))
    || (input.speaker.portraitAssetId !== undefined && !validText(input.speaker.portraitAssetId, 128))
    || !Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 8) {
    throw new GameSdkError("game_argument_invalid", "Dialogue content is missing or exceeds its bounded contract.", "runtime");
  }
  const ids = new Set<string>();
  for (const choice of input.choices) {
    if (!choice || !validText(choice.id, 64) || !validText(choice.label, 160) || ids.has(choice.id)
      || (choice.enabled !== undefined && typeof choice.enabled !== "boolean")) {
      throw new GameSdkError("game_argument_invalid", "Dialogue choices must have unique IDs and bounded labels.", "runtime");
    }
    ids.add(choice.id);
  }
}

function grantCheckedWorld(options: CodeGameHostOptionsV2): WorldAPIV2 {
  const check = (permission: GamePermissionV2): void => {
    const decision = evaluateGameInvocation(permission, {
      runId: options.runId,
      ...(options.playerScope ? { playerScope: options.playerScope } : {}),
    }, options.access, options.grant);
    if (!decision.ok) throw new GameSdkError("game_permission_denied", `V2 world access denied: ${decision.reason}.`, "runtime");
  };
  const target = options.world;
  const call = <T>(permission: GamePermissionV2, operation: () => T): T => {
    check(permission);
    return operation();
  };
  const open = (permission: GamePermissionV2, operation: () => Promise<{ read(): Promise<Uint8Array> }>) => {
    check(permission);
    return operation().then((reader) => {
      check(permission);
      return Object.freeze({
        ...reader,
        read: async () => {
          check(permission);
          return reader.read();
        },
      });
    });
  };
  return Object.freeze({
    header: () => call("world.read", target.header),
    capabilities: () => call("world.read", target.capabilities),
    supports: (capability: Parameters<WorldAPIV2["supports"]>[0]) => call("world.read", () => target.supports(capability)),
    roads: (input: Parameters<WorldAPIV2["roads"]>[0]) => call("roads.read", () => target.roads(input)),
    getRoute: (routeId: string) => call("roads.read", () => target.getRoute(routeId)),
    objects: (input: Parameters<WorldAPIV2["objects"]>[0]) => call("objects.read", () => target.objects(input)),
    anchors: (input: Parameters<WorldAPIV2["anchors"]>[0]) => call("world.read", () => target.anchors(input)),
    volumes: (input: Parameters<WorldAPIV2["volumes"]>[0]) => call("volumes.read", () => target.volumes(input)),
    listSites: (input: Parameters<WorldAPIV2["listSites"]>[0] = {}) => call("sites.read", () => target.listSites(input)),
    listResidents: (input: Parameters<WorldAPIV2["listResidents"]>[0] = {}) => call("residents.read", () => target.listResidents(input)),
    getResident: (id: string) => call("residents.read", () => target.getResident(id)),
    listPlaces: (input: Parameters<WorldAPIV2["listPlaces"]>[0] = {}) => call("places.read", () => target.listPlaces(input)),
    terrainSample: (x: number, z: number) => call("terrain.sample", () => target.terrainSample(x, z)),
    environment: () => call("environment.read", target.environment),
    appearance: () => call("appearance.read", target.appearance),
    openTerrainTile: (id: Parameters<WorldAPIV2["openTerrainTile"]>[0], digest: Parameters<WorldAPIV2["openTerrainTile"]>[1]) =>
      open("world.read", () => target.openTerrainTile(id, digest)),
    openModel: (digest: Parameters<WorldAPIV2["openModel"]>[0]) => open("world.read", () => target.openModel(digest)),
  }) as WorldAPIV2;
}

function v1Manifest(manifest: CodeGameManifestV2) {
  const worldPermissions = new Set<string>(["world.read"]);
  if (manifest.world.requiredCapabilities.includes("roads.graph")) worldPermissions.add("roads.read");
  if (manifest.world.requiredCapabilities.includes("terrain.heightfield")) worldPermissions.add("terrain.sample");
  for (const permission of manifest.permissions) {
    if (["world.read", "roads.read", "terrain.sample", "entities.write.owned", "input.read", "ui.hud", "audio.play.assets"].includes(permission)) {
      worldPermissions.add(permission);
    }
  }
  return {
    schemaVersion: 1 as const,
    kind: "code-game" as const,
    gameId: manifest.gameId,
    displayName: manifest.displayName,
    version: manifest.version,
    entry: manifest.entry,
    sdk: { name: "@oh-agent/city-game-sdk" as const, apiMajor: 1 as const },
    world: { requiredCapabilities: [...worldPermissions].filter((value) => ["world.read", "roads.read", "terrain.sample"].includes(value)) },
    permissions: [...worldPermissions],
    limits: manifest.limits,
    assets: manifest.assets,
  };
}

export function createV1WorldFromV2(world: WorldAPIV2): CodeGameHostOptionsV1["world"] {
  return {
    city: () => {
      const header = world.header();
      return { cityId: header.cityId, seed: header.seed, worldRevision: header.revisions.worldRevision, layoutId: null };
    },
    listRoutes: () => allPages((cursor) => world.roads({ limit: 64, ...(cursor ? { cursor } : {}) })).map((road) => ({
      id: road.id,
      points: road.centerline,
    })),
    getRoute: (routeId: string) => {
      try {
        const road: RoadEdgeDtoV2 = world.getRoute(routeId);
        return { id: road.id, points: road.centerline };
      } catch {
        return null;
      }
    },
    sampleTerrain: (x: number, z: number) => {
      try {
        return world.terrainSample(x, z);
      } catch {
        return null;
      }
    },
    listAnchors: () => allPages((cursor) => world.anchors({ limit: 64, ...(cursor ? { cursor } : {}) })).map((anchor) => ({
      id: anchor.id,
      kind: anchor.kind === "checkpoint" ? "zone" : anchor.kind,
      position: anchor.position,
      ...(anchor.radiusMeters !== undefined ? { radiusMeters: anchor.radiusMeters } : {}),
    })) as readonly WorldAnchorV1[],
    queryObjects: (bounds: WorldBoundsV1) => allPages((cursor) => world.objects({ bounds, limit: 64, ...(cursor ? { cursor } : {}) })).map((object) => ({
      id: object.id,
      kind: object.kind,
      position: object.transform.position,
      bounds: object.bounds,
    })),
  };
}

function allPages<T>(read: (cursor?: string) => { items: readonly T[]; nextCursor?: string }): readonly T[] {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page = read(cursor);
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return Object.freeze(result);
}

const hostTimers = globalThis as unknown as {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(timer: unknown): void;
};
