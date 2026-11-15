import test from "node:test";
import assert from "node:assert/strict";
import { releaseIdForOpenRevision, resolveSceneCaptureRevision, type ProjectPublicationV1 } from "../src/publicationSync.ts";

const published: ProjectPublicationV1 = { projectId: "project-1", revision: 2, releaseId: "release-1", status: "published" };

test("publication status follows the authoritative revision", () => {
  assert.equal(releaseIdForOpenRevision(published, "project-1", 2), "release-1");
  assert.equal(releaseIdForOpenRevision({ ...published, status: "unpublished", releaseId: null }, "project-1", 2), null);
  assert.equal(releaseIdForOpenRevision(published, "project-1", 1), null);
  assert.equal(releaseIdForOpenRevision(published, "project-2", 2), null);
  assert.equal(releaseIdForOpenRevision({ ...published, releaseId: "" }, "project-1", 2), null);
});

test("scene capture conflicts only when the stored revision moved", () => {
  const staleViewport = resolveSceneCaptureRevision({
    projectOpen: true, projectMatches: true, requestedRevision: 2, authoritativeRevision: 2, viewportRevision: 1,
  });
  assert.deepEqual(staleViewport, { ok: true, revision: 2, refreshViewport: true });
  const current = resolveSceneCaptureRevision({
    projectOpen: true, projectMatches: true, requestedRevision: undefined, authoritativeRevision: 2, viewportRevision: 2,
  });
  assert.deepEqual(current, { ok: true, revision: 2, refreshViewport: false });
  const moved = resolveSceneCaptureRevision({
    projectOpen: true, projectMatches: true, requestedRevision: 2, authoritativeRevision: 3, viewportRevision: 3,
  });
  assert.deepEqual(moved, { ok: false, code: "revision_conflict" });
  const closed = resolveSceneCaptureRevision({
    projectOpen: false, projectMatches: false, requestedRevision: 2, authoritativeRevision: null, viewportRevision: null,
  });
  assert.deepEqual(closed, { ok: false, code: "creator_capture_requires_project" });
  const otherProject = resolveSceneCaptureRevision({
    projectOpen: true, projectMatches: false, requestedRevision: 2, authoritativeRevision: 2, viewportRevision: 2,
  });
  assert.deepEqual(otherProject, { ok: false, code: "creator_capture_requires_project" });
});
