import test from "node:test";
import assert from "node:assert/strict";
import {
  newStoryDocument, parseStoryDocument, storyDocumentDiagnostics, storySavePayload, testStoryConditions,
  type StoryDocument,
} from "../src/features/story/storyEditorModel.ts";

function storyWithEdge(): StoryDocument {
  const base = newStoryDocument("story.detective");
  return {
    ...base,
    graph: {
      start: "start",
      nodes: [{ id: "start", kind: "beat" }, { id: "reply", kind: "beat" }],
      edges: [{
        id: "invite", from: "start", to: "reply",
        preconditions: { op: "all", of: [{ op: "flag", key: "met", expected: true }, { op: "counter.gte", key: "affection", value: 1 }] },
        effects: [{ op: "event.append", eventId: "evt-invited", ruleId: "invite" }],
        eventDependencies: [], scope: "story",
      }],
    },
    canon: { characters: [{ storyId: "story.detective", characterId: "resident:linxia", displayName: "小夏", version: 1,
      growthEdges: [{ from: "guarded", to: "trusting", requireEvent: "evt-invited" }] }] },
  };
}

test("Story drafts validate Graph, Canon and growth event references together", () => {
  assert.deepEqual(storyDocumentDiagnostics(storyWithEdge()), []);
  const missingEvent = storyWithEdge();
  missingEvent.graph.edges[0].effects = [];
  assert.ok(storyDocumentDiagnostics(missingEvent).some(item => item.code === "canon_growth_edge_event_missing"));
});

test("Story Canon cannot cross story scope or reuse a character identity", () => {
  const story = storyWithEdge();
  const character = (story.canon.characters as Record<string, unknown>[])[0];
  const invalid = { ...story, canon: { characters: [{ ...character, storyId: "story.other" }, character] } };
  const diagnostics = storyDocumentDiagnostics(invalid);
  assert.ok(diagnostics.some(item => item.code === "canon_story_scope_mismatch"));
  assert.ok(diagnostics.some(item => item.code === "canon_character_duplicate"));
});

test("Story condition tests use explicit local snapshots rather than accepting every object condition", () => {
  const story = storyWithEdge();
  assert.deepEqual(testStoryConditions(story, { cursor: "start", committedEvents: [], flags: { met: true }, counters: { affection: 1 } }), [{ edgeId: "invite", to: "reply" }]);
  assert.deepEqual(testStoryConditions(story, { cursor: "start", committedEvents: [], flags: { met: false }, counters: { affection: 1 } }), []);
  assert.deepEqual(testStoryConditions(story, { cursor: "reply", committedEvents: [], flags: { met: true }, counters: { affection: 1 } }), []);
});

test("Story save uses Host CAS only for an existing registry revision", () => {
  const story = storyWithEdge();
  assert.equal(storySavePayload(story, true).expectedStoryRevision, undefined);
  const saved = { ...story, revision: 3 };
  assert.equal(storySavePayload(saved, false).expectedStoryRevision, 3);
});

test("Story Host DTO parsing fails closed on malformed identity or content", () => {
  const story = storyWithEdge();
  const parsed = parseStoryDocument({ ...story, revision: 1, contentDigest: "digest-1" });
  assert.equal(parsed.storyId, "story.detective");
  assert.throws(() => parseStoryDocument({ ...story, revision: 0, contentDigest: "digest-1" }), /creator_story_project_invalid/);
  assert.throws(() => parseStoryDocument({ ...story, revision: 1, contentDigest: "digest-1", canon: [] }), /creator_story_project_invalid/);
});
