import type {
  ActorIntentV1,
  CityAppearanceRefV1,
  CityEnvironmentV1,
  CityPageV1,
  CityPlaceV1,
  CityResidentV1,
  CityTargetRefV1,
  CityTemporalSnapshotV1,
  CityWorldSnapshotV4,
  PlayerScopeV1,
  RoadEdgeDtoV2,
  SiteDtoV2,
  WorldAssetV1,
  WorldCapabilityV2,
  WorldQueryV1,
} from "@oh-agent/city-sdk/contracts";
import type { GameContextV1, GameOutcomeV1, UnsubscribeV1 } from "./types";

export type GameLaunchContextV1 = Readonly<{
  launchId: string;
  cityId: string;
  worldRevision: string;
  interactionRevision: string;
  cityRevision: number;
  worldSnapshotDigest: string;
  environmentRevision?: string;
  weatherRevision?: string;
  placeRevision?: string;
  residentRevision?: string;
  playerScope: PlayerScopeV1;
  source: CityTargetRefV1;
  interactionId: string;
  entry?: string;
  presentation: "overlay" | "exclusive";
}>;

export interface WorldAPIV2 extends WorldQueryV1, WorldAssetV1 {
  capabilities(): readonly WorldCapabilityV2[];
  supports(capability: WorldCapabilityV2): boolean;
  getRoute(routeId: string): RoadEdgeDtoV2;
  listSites(query?: { kind?: string; limit?: number; cursor?: string }): CityPageV1<SiteDtoV2>;
  listResidents(query?: { limit?: number; cursor?: string }): CityPageV1<CityResidentV1>;
  getResident(id: string): CityResidentV1;
  listPlaces(query?: { kind?: string; limit?: number; cursor?: string }): CityPageV1<CityPlaceV1>;
  environment(): CityEnvironmentV1;
  appearance(): CityAppearanceRefV1;
}

export interface DialogueAPIV1 {
  open(input: {
    speaker: { residentId?: string; displayName: string; portraitAssetId?: string };
    text: string;
    choices: readonly { id: string; label: string; enabled?: boolean }[];
  }): Promise<{ choiceId: string }>;
  close(): void;
}

export interface GameStorageRecordV1<T> {
  readonly value: T | null;
  readonly revision: string;
}

export interface GameStorageAPIV1 {
  get<T>(key: string): Promise<GameStorageRecordV1<T>>;
  compareAndSet<T>(input: {
    key: string;
    expectedRevision: string;
    value: T;
    operationId: string;
  }): Promise<{ revision: string }>;
  delete(input: { key: string; expectedRevision: string; operationId: string }): Promise<void>;
}

export type StoryTriggerV1 =
  | { kind: "calendar"; recurrence: "once"; atUtcMs: number }
  | { kind: "calendar"; recurrence: "weekly"; timeZone: "city"; dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6; localTime: string }
  | { kind: "city-event"; eventType: string; targetId?: string }
  | { kind: "relationship"; residentId: string; threshold: number };

export interface StoryEventRuleV1 {
  readonly ruleId: string;
  readonly version: number;
  readonly trigger: StoryTriggerV1;
  readonly target?: CityTargetRefV1;
  readonly requirePlayerAtTarget?: boolean;
  readonly conditions: readonly { key: string; op: "eq" | "gte"; value: string | number | boolean }[];
  readonly action: { kind: "offer-dialogue" | "update-quest" | "emit-game-event"; eventId: string };
  readonly cooldownMs?: number;
  readonly missedPolicy: "skip" | "reschedule" | "expire" | "persist";
  readonly rescheduleDelayMs?: number;
  readonly maxRescheduleCount?: number;
}

export interface StoryEventAPIV1 {
  resolveLocalTime(input: { localDate: string; localTime: string }): Promise<{ atUtcMs: number; clockRevision: string }>;
  schedule(rule: StoryEventRuleV1, options: {
    expectedStoryRevision: string;
    expectedClockRevision: string;
    operationId: string;
  }): Promise<{ ruleId: string; storyRevision: string }>;
  cancel(ruleId: string, options: { expectedStoryRevision: string; operationId: string }): Promise<void>;
  list(): Promise<readonly { ruleId: string; nextDueUtcMs?: number }[]>;
}

export interface CityTimeReadAPIV1 {
  now(): Readonly<CityTemporalSnapshotV1>;
  subscribe(listener: (snapshot: Readonly<CityTemporalSnapshotV1>) => void): () => void;
}

export interface AgentActorTurnRequestV1 {
  readonly residentId: string;
  readonly interactionId: string;
  readonly playerMessage?: string;
  readonly storyRevision: string;
  readonly idempotencyKey: string;
}

export interface AgentActorTurnResponseV1 {
  readonly utterance: string;
  readonly proposedIntents: readonly ActorIntentV1[];
  readonly canonDigest: string;
  readonly baseStoryRevision: string;
  readonly auditTraceId: string;
}

export interface AgentActorAPIV1 {
  requestTurn(input: AgentActorTurnRequestV1): Promise<AgentActorTurnResponseV1>;
}

export interface GameAbortSignalV1 {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
}

export interface GameContextV2 extends Omit<GameContextV1, "world" | "onDispose"> {
  readonly world: WorldAPIV2;
  readonly signal: GameAbortSignalV1;
  onStart(handler: (context: { signal: GameAbortSignalV1 }) => Promise<void>): void;
  onDispose(handler: () => void | Promise<void>): UnsubscribeV1;
  readonly launch?: GameLaunchContextV1;
  readonly dialogue?: DialogueAPIV1;
  readonly storage?: GameStorageAPIV1;
  readonly cityTime?: CityTimeReadAPIV1;
  readonly story?: StoryEventAPIV1;
  readonly actors?: AgentActorAPIV1;
  onAppearanceChanged?(handler: (appearance: CityAppearanceRefV1) => void): () => void;
}

export type GameDefinitionV2 = Readonly<{
  id: string;
  setup(context: GameContextV2): void;
}>;

export function defineGameV2(definition: GameDefinitionV2): GameDefinitionV2 {
  if (typeof definition !== "object" || definition === null) throw new TypeError("defineGameV2() expects an object.");
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(definition.id)) throw new TypeError("Game id must be a lower-case stable identifier.");
  if (typeof definition.setup !== "function") throw new TypeError("Game definition must provide a synchronous setup(context).");
  return Object.freeze({ id: definition.id, setup: definition.setup });
}

export type GameHeadlessEvidenceV2 = Readonly<{
  buildId: string;
  cityId: string;
  cityRevision: number;
  worldRevision: string;
  snapshotDigest: string;
  interactionRevision: string;
  runId: string;
  evidenceId: string;
  outcome: GameOutcomeV1 | null;
}>;

export type { CityWorldSnapshotV4 };
