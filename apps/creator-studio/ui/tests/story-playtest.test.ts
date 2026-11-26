import assert from "node:assert/strict";
import test from "node:test";
import { parseCityListPage } from "../src/features/library/cityGameLibraryModel";
import { parseStoryInstallation, parseStoryInstallPreview, readExistingStoryRunId, readStoryRunId } from "../src/features/story/storyPlaytestModel";

const target = { storyId: "story.detective", storyVersion: "2.0.0", contentDigest: "sha256:new" };
const city = parseCityListPage({ cities: [{ cityId: "test-city", name: "测试城", revision: 7 }] }).cities[0];
const scope = { storyId: target.storyId, cityId: city.cityId };
const preview = {
  storyId: target.storyId, storyVersion: target.storyVersion,
  targetPackageDigest: target.contentDigest, targetCityId: city.cityId, expectedCityRevision: city.revision,
  previewId: "story-preview-1", canInstall: true, diagnostics: [], expiresAtMs: 2_000,
  requiresUpdateConfirmation: true, currentStoryVersion: "1.0.0", currentPackageDigest: "sha256:old",
};

test("Story installation confirmation is bound to the checked City revision and both content digests", () => {
  const checked = parseStoryInstallPreview(preview, target, city);
  assert.deepEqual(checked.updateConfirmation, {
    currentStoryVersion: "1.0.0", currentPackageDigest: "sha256:old",
    targetStoryVersion: "2.0.0", targetPackageDigest: "sha256:new",
  });
  assert.throws(() => parseStoryInstallPreview({ ...preview, expectedCityRevision: 8 }, target, city), /story_install_digest_conflict/);
  assert.throws(() => parseStoryInstallPreview({ ...preview, targetPackageDigest: "sha256:other" }, target, city), /story_install_digest_conflict/);
});

test("Story playtest recovers only the selected Story Run and requires the installed content digest", () => {
  assert.equal(parseStoryInstallation({ installations: [{ ...scope, status: "installed", ...target }] }, target.storyId, city.cityId)?.contentDigest, target.contentDigest);
  const run = { ...scope, storyRunId: "run-1", status: "active", contentDigest: target.contentDigest };
  assert.equal(readStoryRunId(run, target, city.cityId), "run-1");
  assert.equal(readExistingStoryRunId({ ...scope, run }, target.storyId, city.cityId), "run-1");
  assert.equal(readExistingStoryRunId({ ...scope, run: null }, target.storyId, city.cityId), "");
  assert.throws(() => readStoryRunId({ ...run, contentDigest: "sha256:old" }, target, city.cityId), /story_run_scope_mismatch/);
  assert.throws(() => readExistingStoryRunId({ ...scope, cityId: "other-city", run }, target.storyId, city.cityId), /story_run_scope_mismatch/);
});
