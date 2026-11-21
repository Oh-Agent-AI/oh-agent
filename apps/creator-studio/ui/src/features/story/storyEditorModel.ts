import {
  eligibleEdges, validateCharacterCanonV1, validateStoryGraphV1,
  type CharacterCanonV1, type NarrativeDiagnosticV1, type NarrativeSnapshotV1,
  type StoryGraphV1,
} from "@oh-agent/narrative-sdk";

export type StoryDocument = Readonly<{
  storyId: string;
  title: string;
  schemaVersion: 1;
  storyVersion: string;
  graph: StoryGraphV1;
  canon: Readonly<Record<string, unknown>>;
  revision: number;
  contentDigest: string;
}>;

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): string | null => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;

export function parseStoryDocument(value: unknown): StoryDocument {
  const row = record(value);
  const storyId = text(row?.storyId, 128);
  const title = text(row?.title, 200);
  const storyVersion = text(row?.storyVersion, 64);
  const contentDigest = text(row?.contentDigest, 96);
  const revision = row?.revision;
  if (!row || !storyId || !title || !storyVersion || !contentDigest || row.schemaVersion !== 1
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1
    || !record(row.graph) || !record(row.canon)) throw new Error("creator_story_project_invalid");
  return Object.freeze({ storyId, title, schemaVersion: 1, storyVersion, contentDigest, revision,
    graph: row.graph as unknown as StoryGraphV1, canon: row.canon as Readonly<Record<string, unknown>> });
}

export function newStoryDocument(storyId: string): StoryDocument {
  return Object.freeze({
    storyId, title: "未命名 Story", schemaVersion: 1, storyVersion: "1.0.0", revision: 0, contentDigest: "",
    graph: { start: "start", nodes: [{ id: "start", kind: "beat", title: "开场" }], edges: [] },
    canon: { characters: [] },
  });
}

function knownEventIds(graph: StoryGraphV1): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const edge of graph.edges) {
    for (const id of edge.eventDependencies) ids.add(id);
    for (const effect of edge.effects) {
      if (effect.op === "event.append" && typeof effect.eventId === "string") ids.add(effect.eventId);
    }
  }
  return ids;
}

export function storyDocumentDiagnostics(document: StoryDocument): readonly NarrativeDiagnosticV1[] {
  const diagnostics = [...validateStoryGraphV1(document.graph).diagnostics];
  const characters = document.canon.characters;
  if (!Array.isArray(characters)) {
    return Object.freeze([...diagnostics, { code: "canon_characters_invalid", severity: "error" as const, path: "canon.characters", message: "Canon 必须包含 characters 数组。" }]);
  }
  const known = knownEventIds(document.graph);
  const characterIds = new Set<string>();
  characters.forEach((character, index) => {
    const value = record(character);
    if (value && value.storyId !== document.storyId) diagnostics.push({ code: "canon_story_scope_mismatch", severity: "error", path: `canon.characters[${index}].storyId`, message: "角色 Canon 的 storyId 必须与当前 Story 一致。" });
    if (typeof value?.characterId === "string") {
      if (characterIds.has(value.characterId)) diagnostics.push({ code: "canon_character_duplicate", severity: "error", path: `canon.characters[${index}].characterId`, message: "同一 Story 中 characterId 不能重复。" });
      characterIds.add(value.characterId);
    }
    const result = validateCharacterCanonV1(structuredClone(character) as CharacterCanonV1, { knownEventIds: known });
    for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, path: `canon.characters[${index}].${diagnostic.path}` });
  });
  return Object.freeze(diagnostics);
}

export function storySavePayload(document: StoryDocument, creating: boolean): Record<string, unknown> {
  return {
    storyId: document.storyId, title: document.title, schemaVersion: 1, storyVersion: document.storyVersion,
    graph: document.graph, canon: document.canon,
    ...(!creating ? { expectedStoryRevision: document.revision } : {}),
  };
}

export type StoryConditionInput = Readonly<{
  cursor: string;
  committedEvents: readonly string[];
  flags: Readonly<Record<string, boolean>>;
  counters: Readonly<Record<string, number>>;
}>;

export function testStoryConditions(document: StoryDocument, input: StoryConditionInput): readonly { edgeId: string; to: string }[] {
  const checked = validateStoryGraphV1(document.graph);
  if (!checked.ok) throw new Error("story_graph_invalid");
  const snapshot: NarrativeSnapshotV1 = {
    scope: { playerId: "story-editor-local", cityId: "story-editor-local", storyId: document.storyId, storyRunId: "story-editor-local" },
    contentDigest: document.contentDigest || "local-draft",
    stateVersion: `local-draft-${document.revision}`,
    cursor: input.cursor, committedEvents: input.committedEvents,
    flags: input.flags, counters: input.counters, clockTick: 0,
  };
  return Object.freeze(eligibleEdges(document.graph, snapshot));
}
