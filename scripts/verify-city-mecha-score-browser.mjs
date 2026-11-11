// Synthetic battle state, built-in planner and real UI/rules; no user browser or data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
const dir = process.env.MECHA_SCREENSHOTS_DIR;
if (dir) await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--use-angle=metal"] });
try {
  for (const [width, height] of [[1100, 700], [390, 844]]) for (const lang of ["zh", "en"]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(45000);
    const errors = []; let seams = 0; let emptyPlanner = false;
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.addInitScript(locale => { localStorage.setItem("city.seed", "4196523069"); window.__AV_PLUGIN_LOCALE__ = locale; }, lang === "zh" ? "zh-Hans" : "en");
      await page.route("**/src/game/mecha/controller.ts*", async route => {
        const response = await route.fetch(); let source = await response.text();
        const needle = "const planner = init.planner ?? planForDoctrine;";
        assert.equal(source.split(needle).length, 2);
        source = source.replace(needle, `
          if (init.site) {
            init.site.terrain = Array.from({length:10}, () => Array(10).fill("land"));
            init.site.heights = Array.from({length:10}, () => Array(10).fill(0));
            init.match = createMatch({preset:"covers_sparse_mid",script:"stationary_smash",terrain:init.site.terrain,heights:init.site.heights,covers:[],obstacles:[],buildings:[],raiders:[],boss:{x:4,y:3},mechs:[{id:"Assault",pos:{x:3,y:4}},{id:"Gunner",pos:{x:4,y:7}},{id:"Support",pos:{x:8,y:9}}]});
            bossPrepare(init.match);
            ${emptyPlanner ? "init.planner = state => ({revision:state.revision,items:[]});" : ""}
          }
          const planner = init.planner ?? planForDoctrine;`);
        seams++; await route.fulfill({ response, body: source });
      });
      const button = (zh, en) => page.getByRole("button", { name: lang === "zh" ? zh : en, exact: true });
      await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90000 });
      await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
      await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({ timeout: 90000 });
      assert.equal(seams, 1);
      await button("战场设置", "Battlefield").click();
      const field = page.locator("#mecha-battlefield-settings");
      const details = field.locator(".mecha-evaluation-details");
      await details.locator("summary").scrollIntoViewIfNeeded();
      await details.locator("summary").focus(); await page.keyboard.press("Enter");
      const result = details.locator('[data-plan-evaluation="ready"]');
      await result.waitFor();
      assert.equal(await result.locator("dl > div").count(), 6);
      const rowLayout = await result.locator("dl").evaluate(list => Array.from(list.children).map(row => {
        const rect = row.getBoundingClientRect(), value = row.querySelector("dd"), number = value.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, valueLeft: number.left, valueRight: number.right, fits: value.scrollWidth <= value.clientWidth + 1 };
      }));
      for (const [i, row] of rowLayout.entries()) {
        assert.ok(row.fits && row.valueLeft >= row.left && row.valueRight <= row.right + 1, "score values fit without splitting");
        if (i) assert.ok(row.top >= rowLayout[i - 1].bottom - 1, "score factors are in one vertical column");
      }

      assert.match(await result.innerText(), lang === "zh" ? /当前草稿评分: 235/ : /Current draft score: 235/);
      assert.match(await result.innerText(), lang === "zh" ? /不等于本回合伤害或收益/ : /not this turn's damage or gains/);
      const pack = page.locator(".mecha-pack"); const originalPack = await pack.innerText();
      const select = field.locator("select").nth(2);
      await select.scrollIntoViewIfNeeded(); await select.selectOption("peel");
      await page.waitForFunction((en) => document.querySelector('[data-plan-evaluation="ready"]')?.textContent?.includes(en ? "Hold the buildings" : "守楼"), lang === "en");
      assert.equal(await pack.innerText(), originalPack, "changing doctrine does not overwrite the current plan");
      const peelText = await result.innerText();
      assert.match(peelText, lang === "zh" ? /当前草稿评分/ : /Current draft score/);
      assert.doesNotMatch(peelText, lang === "zh" ? /当前草稿评分: 235/ : /Current draft score: 235/);
      await button("生成行动建议", "Generate suggestions").scrollIntoViewIfNeeded(); await button("生成行动建议", "Generate suggestions").click();
      await button("确认替换草稿", "Replace draft").scrollIntoViewIfNeeded(); await button("确认替换草稿", "Replace draft").click();
      await page.waitForFunction((en) => document.querySelector('[data-plan-evaluation="ready"]')?.textContent?.includes(en ? "Current draft score: 153" : "当前草稿评分: 153"), lang === "en");
      assert.notEqual(await pack.innerText(), originalPack);
      if (dir) { await result.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(dir, `${width}x${height}-${lang}-score.png`) }); }
      await button("撤回建议", "Undo suggestions").scrollIntoViewIfNeeded(); await button("撤回建议", "Undo suggestions").click();
      await page.waitForFunction((text) => document.querySelector('[data-plan-evaluation="ready"]')?.innerText === text, peelText);
      assert.equal(await pack.innerText(), originalPack);
      if (width === 390 && lang === "zh") {
        // An injected partial planner is not a completed recommendation: never
        // silently score its missing actions as waits or reuse the prior score.
        emptyPlanner = true;
        await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
        await page.locator(".city-loading").waitFor({ state: "hidden", timeout: 90000 });
        await button("城市设置", "City settings").click(); await button("机甲战棋", "Mecha tactics").click();
        await page.locator('.mecha-overlay[data-phase="player_plan"]').waitFor({ timeout: 90000 });
        await button("战场设置", "Battlefield").click();
        const incomplete = page.locator("#mecha-battlefield-settings .mecha-evaluation-details");
        await incomplete.locator("summary").scrollIntoViewIfNeeded(); await incomplete.locator("summary").click();
        await incomplete.getByText("请在本地手动规划阶段，为每台存活机甲选择行动后查看评分。", { exact: true }).waitFor();
        assert.equal(await incomplete.locator("[data-plan-evaluation]").count(), 0);
        assert.equal(seams, 2);
      }
      assert.deepEqual(errors, []);
      console.log(`score ${width}x${height} ${lang}: ok`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
