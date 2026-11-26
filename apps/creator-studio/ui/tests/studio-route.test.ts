import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_NAVIGATION, STUDIO_PROJECTS_ROUTE, STUDIO_WORKSPACE_ROUTE, studioRouteTitle } from "../src/app/studioRoute.ts";
import { creationGoalBrief, recentCreatorProjects } from "../src/features/home/workbenchModel.ts";

test("Studio puts the project library first and keeps Story in the workspace", () => {
  assert.equal(STUDIO_NAVIGATION[0].route, STUDIO_PROJECTS_ROUTE);
  assert.deepEqual(STUDIO_NAVIGATION.map(item => [item.route.section, item.label]), [
    ["projects", "项目库"], ["home", "工作台"], ["explore", "探索与素材"], ["releases", "发布管理"], ["evidence", "证据中心"],
  ]);
  assert.equal(studioRouteTitle(STUDIO_WORKSPACE_ROUTE), "作品工作区");
  assert.equal(studioRouteTitle({ section: "evidence" }), "证据中心");
  assert.equal(STUDIO_NAVIGATION.some(item => item.route.section === "workspace"), false);
});

test("recent projects use real update times without mutating the host projection", () => {
  const projects = [
    { projectId: "older", revision: 1, title: "Older", updatedAtMs: 10 },
    { projectId: "newer", revision: 2, title: "Newer", updatedAtMs: 30 },
    { projectId: "middle", revision: 3, title: "Middle", updatedAtMs: 20 },
  ];
  assert.deepEqual(recentCreatorProjects(projects, 2).map(row => row.projectId), ["newer", "middle"]);
  assert.deepEqual(projects.map(row => row.projectId), ["older", "newer", "middle"]);
  assert.deepEqual(recentCreatorProjects(projects, 0), []);
});

test("goal briefs are explicit copy-only text and never claim task execution", () => {
  assert.equal(creationGoalBrief("  "), null);
  const brief = creationGoalBrief(" 制作海湾竞速 ");
  assert.match(brief ?? "", /制作海湾竞速/);
  assert.match(brief ?? "", /尚未创建或执行 Agent Task/);
  assert.doesNotMatch(brief ?? "", /已受理|已执行/);
});
