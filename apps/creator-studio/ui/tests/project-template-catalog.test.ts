import test from "node:test";
import assert from "node:assert/strict";
import { codeTemplateCatalog, declarativeTemplateCatalog, templateCatalog, templateRuntimeLabels } from "../src/features/project/projectCatalogModel.ts";

/**
 * PR12 统一创作模板目录（声明式 + Code Game）的 UI 投影守卫：
 * 目录条目只是创作入口元数据（runtime 徽标/题材/兼容性/创建工具），不是授权。
 */

test("template catalog unifies declarative and Code Game templates with runtime badges", () => {
  assert.equal(templateRuntimeLabels.declarative, "声明式");
  assert.equal(templateRuntimeLabels.code, "Code Game");
  assert.equal(templateCatalog.length, declarativeTemplateCatalog.length + codeTemplateCatalog.length);
  for (const entry of templateCatalog) {
    assert.ok(entry.templateId.length > 0);
    assert.ok(entry.name.length > 0);
    assert.ok(templateRuntimeLabels[entry.runtime]);
    assert.ok(entry.requiredCapabilities.length >= 1, `${entry.templateId} must declare its compatibility`);
    assert.ok(entry.createTool.length > 0);
  }
});

test("declarative templates project pack slot capabilities and the existing create flow", () => {
  const ids = declarativeTemplateCatalog.map(entry => entry.templateId);
  for (const id of ["checkpoint-race", "flight-checkpoint", "ornithopter-flight", "collect-one"]) {
    assert.ok(ids.includes(id), `declarative catalog must keep ${id}`);
  }
  const race = declarativeTemplateCatalog.find(entry => entry.templateId === "checkpoint-race")!;
  assert.equal(race.runtime, "declarative");
  assert.equal(race.createTool, "creator_project_create");
  assert.deepEqual([...race.requiredCapabilities], ["drive"]);
  const flight = declarativeTemplateCatalog.find(entry => entry.templateId === "flight-checkpoint")!;
  assert.deepEqual([...flight.requiredCapabilities], ["fly"]);
});

test("code templates carry genre/tags/compatibility and the Agent create affordance", () => {
  const ids = codeTemplateCatalog.map(entry => entry.templateId);
  assert.deepEqual(ids, ["hello-city", "tower-defense"]);
  for (const entry of codeTemplateCatalog) {
    assert.equal(entry.runtime, "code");
    assert.equal(entry.createTool, "creator_code_project_create");
    assert.ok(entry.description, `${entry.templateId} must carry a creation-entry description`);
    assert.ok(entry.genre, `${entry.templateId} must carry a genre`);
    assert.ok(entry.tags.length >= 1);
  }
  const hello = codeTemplateCatalog.find(entry => entry.templateId === "hello-city")!;
  assert.equal(hello.name, "Hello City");
  assert.ok(hello.requiredCapabilities.includes("world.read"));
  assert.ok(hello.requiredCapabilities.includes("roads.read"));
});
