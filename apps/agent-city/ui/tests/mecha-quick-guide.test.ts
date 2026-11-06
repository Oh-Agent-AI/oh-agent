import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// The desktop test tooling supplies Playwright. This fixture mounts only the
// guide, never a City, real battle, native host, or user data.
const { chromium } = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url))("playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MechaQuickGuide } from '/src/game/MechaQuickGuide.tsx';
window.closeCount = 0;
window.sideEffects = [];
for (const method of ['setItem', 'removeItem', 'clear']) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function (...args) { window.sideEffects.push('storage:' + method); return original.apply(this, args); };
}
window.fetch = (...args) => { window.sideEffects.push('fetch'); throw new Error('unexpected fetch'); };
navigator.sendBeacon = () => { window.sideEffects.push('beacon'); return false; };
function Fixture() {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState('zh-Hans');
  const [menuVisible, setMenuVisible] = useState(true);
  const [useFallback, setUseFallback] = useState(false);
  const outsideRef = useRef(null);
  window.setGuideLocale = setLocale;
  window.setGuideOpen = setOpen;
  return React.createElement(React.Fragment, null,
    React.createElement('button', { id: 'open-guide', onClick: () => setOpen(true) }, 'Open guide'),
    React.createElement('button', { id: 'outside', ref: outsideRef }, 'Outside'),
    menuVisible && React.createElement('button', { id: 'menu-item', onClick: () => { setUseFallback(true); setMenuVisible(false); setOpen(true); } }, 'Open from menu'),
    open && React.createElement(MechaQuickGuide, { locale, returnFocusRef: useFallback ? outsideRef : undefined, onClose: () => { window.closeCount++; setOpen(false); } }));
}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(Fixture)));
`;

let server: Awaited<ReturnType<typeof createServer>>;
let browser: any;
let base: string;

before(async () => {
  server = await createServer({
    root, configFile: false, logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "quick-guide-test-fixture",
      resolveId(id) { if (id === "virtual:mecha-quick-guide-test") return "\0virtual:mecha-quick-guide-test"; },
      load(id) { if (id === "\0virtual:mecha-quick-guide-test") return fixture; },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/__quick-guide-test__") return next();
          res.setHeader("Content-Type", "text/html");
          res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:mecha-quick-guide-test"></script></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const locale of ["zh-Hans", "en"] as const) {
  test(`${locale}: on-demand guide, keyboard dismissal, focus return and local-only behavior`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("request", (request: any) => { if (!request.url().startsWith(base)) external.push(request.url()); });
    try {
      await page.goto(`${base}/__quick-guide-test__`);
      await page.locator("#open-guide").waitFor();
      await page.evaluate((lang: string) => (window as any).setGuideLocale(lang), locale);
      assert.equal(await page.locator("dialog").count(), 0, "guide must not open itself");
      await page.locator("#open-guide").focus();
      await page.keyboard.press("Enter");
      const guide = page.getByRole("dialog", { name: locale === "en" ? "Quick battle guide" : "战斗快速指南" });
      await guide.waitFor();
      assert.equal(await guide.getAttribute("data-mecha-quick-guide"), "");
      assert.equal(await guide.getAttribute("lang"), locale);
      assert.equal(await guide.evaluate((element: HTMLDialogElement) => element.matches(":modal")), true);
      const close = guide.getByRole("button", { name: locale === "en" ? "Close guide" : "关闭指南" });
      assert.equal(await close.evaluate((element: Element) => element === document.activeElement), true);
      assert.deepEqual(await guide.locator("ol > li h3").allTextContents(), locale === "en"
        ? ["Deploy", "Read the telegraph", "Plan", "Submit", "Replay and records"]
        : ["部署", "查看预告", "规划", "提交", "回放与记录"]);
      const text = await guide.innerText();
      for (const rule of locale === "en"
        ? [/after confirmation/, /unknown prediction does not mean safety/, /each surviving mech/, /does not submit/, /if rejected/, /actual events, not predictions/, /Remote matches do not support local replay/]
        : [/确认后才出现首回合敌意/, /预测未知不等于安全/, /每台存活机甲/, /不等于提交整队/, /若被拒绝，局面不变/, /实际事件，不是预测/, /远程对局不支持本机回放/]) {
        assert.match(text, rule);
      }
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest("dialog")), true, "modal must not focus background controls");
      }
      await page.keyboard.press("Escape");
      assert.equal(await guide.count(), 0);
      assert.equal(await page.locator("#open-guide").evaluate((element: Element) => element === document.activeElement), true);
      assert.equal(await page.evaluate(() => (window as any).closeCount), 1);
      await page.keyboard.press("Enter");
      await guide.waitFor();
      await close.click();
      assert.equal(await guide.count(), 0);
      assert.equal(await page.locator("#open-guide").evaluate((element: Element) => element === document.activeElement), true);
      assert.equal(await page.evaluate(() => (window as any).closeCount), 2);
      assert.deepEqual(await page.evaluate(() => (window as any).sideEffects), []);
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

for (const locale of ["zh-Hans", "en"] as const) {
  test(`${locale}: locale changes in an open dialog and content remains reachable on a narrow viewport`, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 480 } });
    try {
      await page.goto(`${base}/__quick-guide-test__`);
      await page.locator("#open-guide").click();
      await page.evaluate((lang: string) => (window as any).setGuideLocale(lang), locale === "en" ? "zh-Hans" : "en");
      await page.getByRole("dialog", { name: locale === "en" ? "战斗快速指南" : "Quick battle guide" }).waitFor();
      await page.evaluate((lang: string) => (window as any).setGuideLocale(lang), locale);
      const guide = page.getByRole("dialog", { name: locale === "en" ? "Quick battle guide" : "战斗快速指南" });
      await guide.waitFor();
      const geometry = await guide.evaluate((element: HTMLElement) => ({
        width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
      }));
      assert.ok(geometry.width <= 390 && geometry.height <= 480);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, "guide must not require horizontal scrolling");
      assert.ok(geometry.scrollHeight > geometry.clientHeight, "fixture should exercise vertical scrolling");
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => document.querySelector("[data-mecha-quick-guide]")!.scrollTop > 0);
      const last = guide.locator("ol > li").last();
      await last.scrollIntoViewIfNeeded();
      assert.equal(await last.isVisible(), true);
      assert.equal(await last.evaluate((element: HTMLElement) => {
        const item = element.getBoundingClientRect();
        const dialog = element.closest("dialog")!.getBoundingClientRect();
        return item.bottom <= dialog.bottom && item.top >= dialog.top;
      }), true, "last step can be scrolled fully into view");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#open-guide").evaluate((element: Element) => element === document.activeElement), true);
    } finally { await page.close(); }
  });

}

test("a host focus target works when the opening menu item unmounts", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/__quick-guide-test__`);
    await page.locator("#menu-item").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "战斗快速指南" }).waitFor();
    assert.equal(await page.locator("#menu-item").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#outside").evaluate((element: Element) => element === document.activeElement), true);
  } finally { await page.close(); }
});

test("parent-initiated unmount also restores focus without calling onClose", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/__quick-guide-test__`);
    await page.locator("#open-guide").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "战斗快速指南" }).waitFor();
    await page.evaluate(() => (window as any).setGuideOpen(false));
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(await page.locator("#open-guide").evaluate((element: Element) => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => (window as any).closeCount), 0);
  } finally { await page.close(); }
});
