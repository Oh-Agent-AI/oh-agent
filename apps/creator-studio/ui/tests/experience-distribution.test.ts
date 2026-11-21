import test from "node:test";
import assert from "node:assert/strict";
import { parseExperiencePackages, validExperienceVersion } from "../src/features/distribution/experienceDistributionModel.ts";

test("Experience discovery preserves immutable identity, source and installation state", () => {
  const rows = parseExperiencePackages({ experiences: [{ experienceId: "experience-0123456789abcdef", version: "1.2.0",
    contentDigest: `sha256:${"a".repeat(64)}`, gameType: "driving", releaseId: "release-1", fileCount: 3,
    installed: true, installedAtMs: 42 }] });
  assert.equal(rows[0].installed, true);
  assert.equal(rows[0].releaseId, "release-1");
  assert.equal(rows[0].fileCount, 3);
});

test("Experience versions and host projections fail closed", () => {
  assert.equal(validExperienceVersion("1.0.0"), true);
  assert.equal(validExperienceVersion("1.0.0-beta.1"), true);
  for (const version of ["latest", "1.0", "01.0.0", "1.0.0/../../x"]) assert.equal(validExperienceVersion(version), false);
  assert.throws(() => parseExperiencePackages({ experiences: [{ experienceId: "experience-1", version: "latest" }] }), /creator_experience_list_invalid/);
  assert.throws(() => parseExperiencePackages({ experiences: [{ experienceId: "experience-1", version: "1.0.0", contentDigest: "bad", fileCount: 1, installed: false }] }), /creator_experience_list_invalid/);
});
