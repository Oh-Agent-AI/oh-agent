#!/usr/bin/env node
// Synthetic Chromium and rule fixture: not a native-device or Tauri acceptance test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const screenshots = process.env.MECHA_SCREENSHOTS_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  for (const lang of ["zh", "en"]) {
    const zh = lang === "zh";
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: zh ? "zh-CN" : "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/src/engine/CityEngine.ts*", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const needle = "if (this.documentHidden) return;";
      assert.ok(body.includes(needle), "engine throttle fixture changed");
      await route.fulfill({ response, body: body.replace(needle, "if (this.documentHidden || window.__pauseFixtureDraw) return;") });
    });
    await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const needle = 'controllerRef.current = createMechaController({ animate: true, locale, site, preset: "covers_sparse_mid", script: "siege", stake: shapeId === "alley" ? "frontage" : "all" });';
      assert.ok(body.includes(needle), "controller fixture changed");
      body = `import { createMatch as fixtureMatch, bossPrepare as prepareFixture, living as fixtureLiving } from "/src/game/mecha/rules.ts";\n` + body;
      body = body.replace(needle, `const fixture = fixtureMatch({ preset: "covers_sparse_mid", script: "cadence_ssw", covers: [], buildings: [{ id: "fixture-building", cells: [{ x: 4, y: 2 }] }], boss: { x: 4, y: 0 },
        raiders: [{ id: "raider-w", pos: { x: 4, y: 4 } }, { id: "raider-e", pos: { x: 6, y: 4 } }],
        mechs: [{ id: "Assault", pos: { x: 5, y: 2 } }, { id: "Gunner", pos: { x: 2, y: 8 } }, { id: "Support", pos: { x: 7, y: 2 } }] });
        fixture.boss.cadence = 2; prepareFixture(fixture);
        fixture.mechs.find((m) => m.id === "Assault").pos = { x: 6, y: 3 };
        controllerRef.current = createMechaController({ animate: true, locale, site, match: fixture,
          planner: (state) => ({ revision: state.revision, items: fixtureLiving(state).map((m) => ({ mechId: m.id, moveTo: null, action: { kind: "skip" } })) }) });
        window.__turnStagesController = controllerRef.current;`);
      await route.fulfill({ response, body });
    });
    await page.addInitScript((locale) => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, zh ? "zh-Hans" : "en");
    await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
    await page.locator(".city-loading").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: zh ? "城市设置" : "City settings", exact: true }).click();
    await page.getByRole("button", { name: zh ? "机甲战棋" : "Mecha tactics", exact: true }).click();
    await page.waitForFunction(() => window.__turnStagesController?.getState().preview.ok);
    await page.evaluate(() => { window.__pauseFixtureDraw = true; });
    const order = page.getByRole("button", { name: zh ? "结算顺序" : "Attack order", exact: true });
    assert.equal(await order.getAttribute("aria-expanded"), "false");
    await order.click();
    assert.equal(await order.getAttribute("aria-expanded"), "true");
    const summary = page.locator(".mecha-turn-summary");
    const stages = summary.getByRole("list", { name: zh ? "回合阶段" : "Turn stages", exact: true });
    assert.equal(await stages.count(), 1);
    assert.deepEqual(await stages.locator(":scope > li").allTextContents(), zh
      ? ["全队移动", "我方行动", "敌方行动", "下一回合"]
      : ["Team moves", "Mechs act", "Enemies act", "Next turn"]);
    const explanations = zh ? [
      "移动完成后，突击、射手、支援按顺序行动。",
      "伤害、击退及损毁在行动中即时结算；目标位移或消失可能导致落空，落空不消耗冷却。",
      "战斗结束则跳过后续阶段；否则准备下一回合敌意。",
    ] : [
      "After all moves, Assault, Gunner and Support act in order.",
      "Damage, knockback and destruction resolve during each action. A moved or lost target may cause a fizzle, which consumes no cooldown.",
      "If the battle ends, later stages are skipped; otherwise, enemy intents are prepared for the next turn.",
    ];
    for (const text of explanations) assert.equal(await summary.getByText(text, { exact: true }).count(), 1, `${lang}: missing ${text}`);
    const rules = summary.locator("details.mecha-order-rules");
    assert.equal(await rules.evaluate((el) => el.open), false, `${lang}: rule details start compact`);
    await rules.locator("summary").click();
    assert.equal(await rules.evaluate((el) => el.open), true);
    assert.equal(await summary.getByText(explanations[1], { exact: true }).isVisible(), true);
    await rules.locator("summary").click();
    assert.equal(await rules.evaluate((el) => el.open), false);
    for (const viewport of [{ width: 1100, height: 700 }, { width: 640, height: 480 }]) {
      await page.setViewportSize(viewport);
      await stages.scrollIntoViewIfNeeded();
      const geometry = await stages.evaluate((el) => {
        const r = el.getBoundingClientRect(), rail = el.closest(".mecha-turn-summary"), b = rail.getBoundingClientRect();
        return { width: el.clientWidth, scrollWidth: el.scrollWidth, rect: r.toJSON(), clip: { left: b.left + rail.clientLeft, right: b.left + rail.clientLeft + rail.clientWidth, top: b.top + rail.clientTop, bottom: b.top + rail.clientTop + rail.clientHeight },
          items: [...el.children].map((item) => ({ size: parseFloat(getComputedStyle(item).fontSize), rect: item.getBoundingClientRect().toJSON() })) };
      });
      assert.ok(geometry.scrollWidth <= geometry.width + 1 && geometry.rect.left >= geometry.clip.left - 1 && geometry.rect.right <= geometry.clip.right + 1 && geometry.rect.top >= geometry.clip.top - 1 && geometry.rect.bottom <= geometry.clip.bottom + 1 && geometry.items.every((item) => item.size >= 12 && item.rect.left >= geometry.rect.left - 1 && item.rect.right <= geometry.rect.right + 1), `${lang} ${viewport.width}: clipped or unreadable stages: ${JSON.stringify(geometry)}`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `order-stages-${lang}-${viewport.width}x${viewport.height}.png`) });
    }
    const enemyButtons = summary.locator(".mecha-order ol:not(.mecha-order-stages) button");
    assert.ok(await enemyButtons.count() > 0, `${lang}: fixture must provide enemy predictions`);
    await enemyButtons.first().scrollIntoViewIfNeeded();
    await enemyButtons.first().focus();
    await page.keyboard.press("Enter");
    assert.equal(await enemyButtons.first().getAttribute("aria-pressed"), "true");
    await order.click();
    assert.equal(await stages.count(), 0, `${lang}: collapsed stages leave accessibility tree`);
    assert.deepEqual(errors, [], `${lang}: browser page errors`);
    console.log(`${lang}: stage order, explanations, desktop/small layout, keyboard enemy selection and disclosure passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
