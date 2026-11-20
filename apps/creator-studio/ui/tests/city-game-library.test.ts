import test from "node:test";
import assert from "node:assert/strict";
import { buildInstallCommitRequest, buildInstallRequest, canCommitInstall, installedGamesForCity, isInstallPreviewAllowed, LIBRARY_RESOURCE_KINDS, parseCityListPage, parseInstallations, parseInstallPreview } from "../src/cityGameLibrary";

test("Studio library keeps Story unavailable until its project registry exists", () => {
  assert.deepEqual(LIBRARY_RESOURCE_KINDS.map(kind => kind.id), ["city", "story", "game"]);
  assert.deepEqual(LIBRARY_RESOURCE_KINDS.map(kind => kind.available), [true, false, true]);
  assert.match(LIBRARY_RESOURCE_KINDS[1]?.description ?? "", /Story Project Registry 未接入/);
  assert.equal(new Set(LIBRARY_RESOURCE_KINDS.map(kind => kind.label)).size, 3);
});

test("City library preserves host capabilities and explicitly represents missing metadata", () => {
  const page = parseCityListPage({ cities: [
    { cityId: "city-known", revision: 4, name: "海湾", worldRevision: "world-v2", capabilities: ["drive", "flight"], compatibilityStatus: "compatible" },
    { cityId: "city-minimal", revision: 0, name: "空地" },
  ], nextCursor: "next-1" });
  assert.deepEqual(page.cities[0]?.capabilities, ["drive", "flight"]);
  assert.equal(page.cities[0]?.compatibility, "compatible");
  assert.equal(page.cities[1]?.capabilities, null);
  assert.equal(page.cities[1]?.worldRevision, null);
  assert.equal(page.cities[1]?.compatibility, null);
  assert.equal(page.nextCursor, "next-1");
  assert.deepEqual(parseCityListPage({ cities: [], nextCursor: null }).cities, []);
  assert.throws(() => parseCityListPage({ cities: [{ cityId: "bad", revision: -1, name: "bad" }] }), /creator_city_list_invalid/);
});

test("Installation history is a separate whitelist projection with honest unknowns", () => {
  const rows = parseInstallations({ installations: [{ installationId: "install-1", cityId: "city-1", gameId: "game-1", buildId: "build-1", status: "installed", cityRevision: 7, privatePath: "/not-projected" }] });
  assert.equal(rows[0]?.status, "installed");
  assert.equal(rows[0]?.cityRevision, 7);
  assert.equal("privatePath" in rows[0]!, false);
  assert.equal(parseInstallations({ installations: [] }).length, 0);
  assert.equal(parseInstallations({ installations: [{ installationId: "i", cityId: "c", gameId: "g", buildId: "b", status: "future-status" }] })[0]?.status, "unknown");
  assert.throws(() => parseInstallations({}), /creator_code_installations_invalid/);
});

test("City instance entries include only active installations for that city", () => {
  const rows = parseInstallations({ installations: [
    { installationId: "i-1", cityId: "city-1", gameId: "game-1", buildId: "build-1", status: "installed" },
    { installationId: "i-2", cityId: "city-1", gameId: "game-2", buildId: "build-2", status: "disabled" },
    { installationId: "i-3", cityId: "city-2", gameId: "game-3", buildId: "build-3", status: "installed" },
  ] });
  assert.deepEqual(installedGamesForCity(rows, "city-1").map(item => item.installationId), ["i-1"]);
  assert.deepEqual(installedGamesForCity(rows, "missing"), []);
});

test("Install preview requires the host's explicit canInstall and a preview identity", () => {
  const preview = parseInstallPreview({ previewId: "install-preview-1", canInstall: true, diagnostics: [{ severity: "warning", code: "story_readonly", message: "Story remains read-only", path: "permissions.story" }] });
  assert.equal(preview.ok, null);
  assert.equal(preview.diagnostics[0]?.code, "story_readonly");
  assert.equal(isInstallPreviewAllowed(preview), true);
  assert.equal(canCommitInstall(preview), true);
  assert.equal(isInstallPreviewAllowed(parseInstallPreview({ canInstall: true, diagnostics: [] })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ previewId: "install-preview-1", ok: false, canInstall: true, diagnostics: [] })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ previewId: "install-preview-1", canInstall: false })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ previewId: "install-preview-1", canInstall: true, diagnostics: [{ severity: "error", code: "city_game_incompatible" }] })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ previewId: "install-preview-1", diagnostics: [] })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ canInstall: true, diagnostics: [] })), false);
  assert.equal(canCommitInstall(parseInstallPreview({ diagnostics: [] })), false);
  assert.equal(canCommitInstall(null), false);
  assert.throws(() => parseInstallPreview({ diagnostics: {} }), /creator_code_install_preview_invalid/);
});

test("Existing installations require explicit confirmation bound to the current build", () => {
  const preview = parseInstallPreview({ previewId: "install-preview-1", canInstall: true,
    requiresUpdateConfirmation: true, currentBuildId: "a".repeat(64), diagnostics: [] });
  assert.equal(preview.requiresUpdateConfirmation, true);
  assert.equal(preview.currentBuildId, "a".repeat(64));
  assert.equal(canCommitInstall(preview), false);
  assert.equal(canCommitInstall(preview, true), true);
  assert.deepEqual(buildInstallCommitRequest(preview, "b".repeat(64), "operation-1"), {
    previewId: "install-preview-1", operationId: "operation-1",
    updateConfirmation: { currentBuildId: "a".repeat(64), buildId: "b".repeat(64) },
  });
  assert.equal(canCommitInstall(parseInstallPreview({ canInstall: true, requiresUpdateConfirmation: true }), true), false);
});

test("Preview and commit share one explicit conservative installation DTO", () => {
  const request = buildInstallRequest("build-abc", "city-abc", 12, "install:operation-1");
  assert.deepEqual(request, {
    buildId: "build-abc",
    targetCityId: "city-abc",
    expectedCityRevision: 12,
    operationId: "install:operation-1",
    runAfterInstall: false,
    replaceCurrentView: false,
    allowOfficialStoryWrites: false,
  });
  assert.equal(Object.keys(request).length, 7);
});
