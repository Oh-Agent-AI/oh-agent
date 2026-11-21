import test from "node:test";
import assert from "node:assert/strict";
import { archiveDependencyCounts, canCommitArchive, cityDraftValidation, DRAFT_CITY_PROFILE, parseArchivePreview, parseArchivedCities, parseCityDraft } from "../src/contracts/cityLifecycle.ts";

test("City draft validation binds name seed profile and operation", async () => {
  const validation = await cityDraftValidation("Draft City", 20261117, "draft-commit-1");
  assert.equal(validation.schemaVersion, 1);
  assert.equal(validation.ok, true);
  assert.match(String(validation.requestDigest), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual((await cityDraftValidation("Draft City", 20261117, "draft-commit-2")).requestDigest, validation.requestDigest);
  assert.equal(DRAFT_CITY_PROFILE.geography.generator, "arid-dunes-v1");
});

test("City draft projection preserves expiry and unknown status honestly", () => {
  const draft = parseCityDraft({ draftId: "city-draft-1", name: "Draft", seed: 7, contentDigest: `sha256:${"a".repeat(64)}`, status: "pending", cityId: null, expiresAtMs: 20 });
  assert.equal(draft.status, "pending");
  assert.equal(draft.cityId, null);
  assert.equal(parseCityDraft({ ...draft, status: "future" }).status, "unknown");
  assert.throws(() => parseCityDraft({ draftId: "missing-fields" }), /creator_city_draft_invalid/);
});

const preview = {
  previewId: "archive-preview-1", cityId: "city-1", revision: 2, canArchive: true, dependencyDigest: `sha256:${"b".repeat(64)}`, expiresAtMs: 30,
  installations: [{ installationId: "installation-1" }], projects: [{ projectId: "project-1" }], releases: [{ releaseId: "release-1" }], candidates: [{ candidateId: "candidate-1" }],
  worldPackage: { packageId: "world-1", version: "1" }, activeRuns: [],
};

test("Archive confirmation requires a dependency-bound preview with no active runs", () => {
  const checked = parseArchivePreview(preview);
  assert.equal(canCommitArchive(checked, false), false);
  assert.equal(canCommitArchive(checked, true), true);
  assert.equal(canCommitArchive(parseArchivePreview({ ...preview, activeRuns: [{ runId: "run-1" }] }), true), false);
  assert.deepEqual(archiveDependencyCounts(checked), { installations: 1, projects: 1, releases: 1, candidates: 1, activeRuns: 0 });
});

test("Archived City list keeps the original dependency evidence", () => {
  const cities = parseArchivedCities({ cities: [{ cityId: "city-1", name: "Archived", archivedAtMs: 10, dependencies: preview }] });
  assert.equal(cities[0]?.name, "Archived");
  assert.equal(archiveDependencyCounts(cities[0]!.dependencies).projects, 1);
  assert.throws(() => parseArchivedCities({ cities: [{ cityId: "invalid" }] }), /creator_archive_list_invalid/);
});
