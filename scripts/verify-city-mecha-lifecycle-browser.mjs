#!/usr/bin/env node
// Synthetic fixture + Vite in-memory instrumentation only. Start the City UI Vite
// server first; pass its URL as argv[2]. This does not test native lifecycle,
// GPU-driver reclamation, garbage collection, or real-device input.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url))("playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5178";
function replaceOnce(body, needle, replacement) {
  assert.equal(body.split(needle).length - 1, 1, `instrumentation point must occur exactly once: ${needle}`);
  return body.replace(needle, replacement);
}
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, locale: "en-US" });
  page.setDefaultTimeout(240_000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("pageerror:", error.message); });
  await page.addInitScript(() => {
    localStorage.setItem("city.seed", "4196523069");
    window.__AV_PLUGIN_LOCALE__ = "en";
    const registrations = [];
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const capture = (options) => typeof options === "boolean" ? options : Boolean(options?.capture);
    const relevant = (target, type) => (target === window && (type === "keydown" || type === "resize")) || (target instanceof HTMLCanvasElement && type.startsWith("pointer"));
    EventTarget.prototype.addEventListener = function(type, handler, options) {
      if (handler && relevant(this, type) && !registrations.some((r) => r.active && r.target === this && r.type === type && r.handler === handler && r.capture === capture(options))) {
        registrations.push({ target: this, type, handler, capture: capture(options), active: true });
      }
      return add.call(this, type, handler, options);
    };
    EventTarget.prototype.removeEventListener = function(type, handler, options) {
      for (const r of registrations) if (r.active && r.target === this && r.type === type && r.handler === handler && r.capture === capture(options)) r.active = false;
      return remove.call(this, type, handler, options);
    };
    const life = window.__mechaLife = {
      registrations, worlds: [], keys: [], resizes: [], controllers: [], timers: [],
      active: (target, type, handler, captureFlag = false) => registrations.some((r) => r.active && r.target === target && r.type === type && r.handler === handler && r.capture === captureFlag),
      track: (group, object) => {
        const entry = { object, count: 0 };
        object.addEventListener("dispose", () => entry.count++);
        group.push(entry);
      },
      world: (item) => {
        item.statics = []; item.order = []; item.players = [];
        for (const object of item.resources) life.track(item.statics, object);
        delete item.resources;
        life.worlds.push(item);
        return item;
      },
      trackOrder: (world, sprite, texture, material) => {
        const item = { sprite, resources: [] };
        life.track(item.resources, texture); life.track(item.resources, material);
        world.order.push(item);
      },
      trackPlayer: (world, player) => {
        const item = { player, resources: [] };
        for (const obj of [player.tracer.geometry, player.tracer.material, player.impact.geometry, player.impact.material]) life.track(item.resources, obj);
        world.players.push(item);
      }
    };
  });
  await page.route("**/src/game/CityMechaWorld.tsx*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const listeners = '    canvas.addEventListener("pointerleave", onLeave);';
    body = replaceOnce(body, listeners, `${listeners}
    const lifeWorld = window.__mechaLife.world({ engine, root, canvas,
      handlers: [["pointerdown", onDown], ["pointerup", onUp], ["pointermove", onMove], ["pointerleave", onLeave]],
      models: [assault, gunner, support, boss, raiderWest, raiderEast],
      resources: [gridGeo, grid.material, padGeo, threatGeo, targetGeo, focusGeo, moveGeo,
        threatMat, subduedThreatMat, focusThreatMat, targetMat, focusMat, moveMat,
        warningMat, subduedWarningMat, focusWarningMat, warningTexture, pickGeo, pickMat,
        barGeo, barBg, buildingMarkerGeo, buildingMarkerMat, ...padMat.values(),
        ...Array.from(bars.values(), bar => bar.fillMat),
        ...Object.values(markers).flatMap(ring => [ring.geo, ring.mat])] });`);
    const order = '        orderMarkers.push({ sprite, texture, material, actor: event.actor, origin, slot: count, slots: totals.get(cellKey(cell)) });';
    body = replaceOnce(body, order, `${order}\n        window.__mechaLife.trackOrder(lifeWorld, sprite, texture, material);`);
    const player = '        if (playing) player = new MechaPerformancePlayer(actors, playing.events, resolveCell, root, () => onPerformanceCompleteRef.current());';
    body = replaceOnce(body, player, `${player}\n        if (playing) window.__mechaLife.trackPlayer(lifeWorld, player);`);
    await route.fulfill({ response, body });
  });
  await page.route("**/src/game/MechaBoard.tsx*", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    const key = '    window.addEventListener("keydown", onKey, true);';
    body = replaceOnce(body, key, `${key}\n    window.__mechaLife.keys.push(onKey);`);
    const observer = '    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);';
    body = replaceOnce(body, observer, `${observer}\n    const resizeRecord = { handler: update, disconnected: !observer }; window.__mechaLife.resizes.push(resizeRecord);`);
    const cleanup = '      observer?.disconnect();';
    body = replaceOnce(body, cleanup, `${cleanup}\n      resizeRecord.disconnected = true;`);
    const controller = '  const controller = controllerRef.current;';
    body = replaceOnce(body, controller, `${controller}\n  if (controller && !window.__mechaLife.controllers.includes(controller)) window.__mechaLife.controllers.push(controller);`);
    const tick = '      if (!remoteLocked.current) controller.tick();';
    body = replaceOnce(body, tick, '      timerRecord.fired = true;\n' + tick);
    const timer = '    }, 700);\n    return () => window.clearTimeout(timer);';
    body = replaceOnce(body, timer, '    }, 700);\n    const timerRecord = { timer, controller, cleared: false, fired: false }; window.__mechaLife.timers.push(timerRecord);\n    return () => { timerRecord.cleared = true; window.clearTimeout(timer); };');
    await route.fulfill({ response, body });
  });
  await page.goto(new URL("/?fixtureSessions=30", base).href, { waitUntil: "domcontentloaded", timeout: 240_000 });
  await page.locator(".city-loading").waitFor({ state: "hidden" });
  const enter = async () => {
    await page.getByRole("button", { name: "City settings" }).click();
    const button = page.getByRole("button", { name: "Mecha tactics" });
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.locator(".mecha-turn-summary").waitFor();
  };
  const snapshot = () => page.evaluate(() => {
    const life = window.__mechaLife;
    return {
      keys: life.keys.map((handler) => life.active(window, "keydown", handler, true)),
      resizes: life.resizes.map((r) => ({ active: life.active(window, "resize", r.handler), disconnected: r.disconnected })),
      worlds: life.worlds.map((w) => ({ attached: Boolean(w.root.parent), busy: w.engine.modeLeases.busy, frame: Boolean(w.engine.gameFrame),
        listeners: w.handlers.map(([type, handler]) => life.active(w.canvas, type, handler)), models: w.models.map((m) => Boolean(m.userData.disposed)),
        statics: w.statics.map((r) => r.count), order: w.order.map((m) => ({ attached: Boolean(m.sprite.parent), counts: m.resources.map((r) => r.count) })),
        players: w.players.map((p) => ({ attached: [Boolean(p.player.tracer.parent), Boolean(p.player.impact.parent)], counts: p.resources.map((r) => r.count) })) }))
    };
  });
  const checkResizes = (snapshot, expectedActive) => {
    assert.equal(snapshot.resizes.filter((r) => r.active).length, expectedActive, "settings resize handlers must not accumulate");
    assert.ok(snapshot.resizes.filter((r) => !r.active).every((r) => r.disconnected), "inactive settings observers must disconnect");
  };
  const settings = () => page.getByText("Battlefield settings and rules", { exact: true });
  const checkInactive = (w) => {
    assert.equal(w.attached, false);
    assert.ok(w.listeners.every((active) => !active)); assert.ok(w.models.every(Boolean));
    assert.ok(w.statics.length > 20 && w.statics.every((count) => count === 1), `static dispose counts ${JSON.stringify(w.statics)}`);
    assert.ok(w.order.every((m) => !m.attached && m.counts.every((count) => count === 1)), `order dispose ${JSON.stringify(w.order)}`);
    assert.ok(w.players.every((p) => p.attached.every((attached) => !attached) && p.counts.every((count) => count === 1)), `player dispose ${JSON.stringify(w.players)}`);
  };
  await enter();
  await page.getByRole("button", { name: "Attack order", exact: true }).click();
  await page.waitForFunction(() => window.__mechaLife.worlds.some((w) => w.root.parent && w.order.length > 0), null, { timeout: 30000 });
  let before = await snapshot();
  checkResizes(before, 1);
  const firstIndex = before.worlds.findIndex((w) => w.attached);
  assert.ok(firstIndex >= 0 && before.worlds.filter((w) => w.attached).length === 1);
  for (const w of before.worlds.filter((w) => !w.attached)) checkInactive(w);
  assert.ok(before.worlds[firstIndex].order.length > 0);
  assert.ok(before.worlds[firstIndex].listeners.every(Boolean));
  assert.equal(before.keys.filter(Boolean).length, 1);
  console.log(`First battle: ${before.worlds.length} world instance(s), ${before.worlds[firstIndex].order.length} live order markers`);
  await settings().click();
  await page.getByRole("button", { name: "New match", exact: true }).click();
  let afterRestart = await snapshot();
  checkResizes(afterRestart, 1);
  assert.equal(afterRestart.worlds.length, before.worlds.length, "restart unexpectedly recreated the world");
  assert.ok(afterRestart.worlds[firstIndex].attached && afterRestart.worlds[firstIndex].busy && afterRestart.worlds[firstIndex].frame);
  assert.ok(afterRestart.worlds[firstIndex].listeners.every(Boolean));
  assert.ok(afterRestart.worlds[firstIndex].statics.every((count) => count === 0), "restart disposed a live resource");
  assert.equal(afterRestart.keys.filter(Boolean).length, 1);
  await settings().click(); // Close settings after testing restart.
  await page.getByRole("button", { name: "Attack order", exact: true }).click();

  // Ensure a performance player is created, then exit during playback. Pause
  // immediately on detection so that the slow software renderer cannot finish it.
  await page.locator(".mecha-submit-primary").click();
  await page.getByRole("button", { name: "Submit anyway" }).click();
  await page.waitForFunction((index) => window.__mechaLife.worlds[index].players.length > 0, firstIndex);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await snapshot();
  assert.ok(paused.worlds[firstIndex].players.at(-1).attached.every(Boolean), "player must still be alive before exit");
  await page.getByRole("button", { name: "Exit battle", exact: true }).click();
  await page.locator(".mecha-overlay").waitFor({ state: "detached" });
  let exited = await snapshot();
  checkResizes(exited, 0);
  for (const w of exited.worlds) checkInactive(w);
  assert.equal(exited.worlds[firstIndex].busy, false); assert.equal(exited.worlds[firstIndex].frame, false);
  assert.ok(exited.keys.every((active) => !active));
  console.log("First exit: world, listeners, order markers, and paused player released");

  await enter();
  let reentered = await snapshot();
  checkResizes(reentered, 1);
  const secondIndex = reentered.worlds.findIndex((w) => w.attached);
  assert.ok(secondIndex >= before.worlds.length, "reentry must use a fresh world");
  assert.equal(reentered.worlds.filter((w) => w.attached).length, 1);
  for (const w of reentered.worlds.filter((w) => !w.attached)) checkInactive(w);
  assert.ok(reentered.worlds[secondIndex].busy && reentered.worlds[secondIndex].frame);
  assert.ok(reentered.worlds[secondIndex].listeners.every(Boolean));
  assert.equal(reentered.keys.filter(Boolean).length, 1);
  await settings().click();
  await page.getByRole("button", { name: "Auto battle", exact: true }).click();
  await page.waitForFunction(() => window.__mechaLife.timers.some((t) => !t.cleared && !t.fired));
  // Exit in the same browser task once the effect's timer exists. This avoids
  // measuring slow Playwright round trips against the 700ms timer.
  const oldState = await page.evaluate(() => {
    const life = window.__mechaLife;
    const timer = life.timers.findLast((item) => !item.cleared && !item.fired);
    if (!timer) throw new Error("no pending auto timer before exit");
    const controller = timer.controller;
    const before = JSON.stringify(controller.getState());
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "Exit battle");
    if (!button || button.disabled) throw new Error("exit button unavailable");
    button.click();
    return { before, timerIndex: life.timers.indexOf(timer), controllerIndex: life.controllers.indexOf(controller) };
  });
  await page.locator(".mecha-overlay").waitFor({ state: "detached" });
  await page.waitForTimeout(1000);
  const timerResult = await page.evaluate(({ timerIndex, controllerIndex }) => ({ cleared: window.__mechaLife.timers[timerIndex].cleared, fired: window.__mechaLife.timers[timerIndex].fired, state: JSON.stringify(window.__mechaLife.controllers[controllerIndex].getState()) }), oldState);
  assert.equal(timerResult.cleared, true);
  assert.equal(timerResult.fired, false, "pending auto timer fired despite leaving");
  assert.equal(timerResult.state, oldState.before, "auto controller advanced after leaving");
  exited = await snapshot();
  checkResizes(exited, 0);
  for (const w of exited.worlds) checkInactive(w);
  assert.equal(exited.worlds[secondIndex].busy, false); assert.equal(exited.worlds[secondIndex].frame, false);
  assert.ok(exited.keys.every((active) => !active));
  assert.deepEqual(errors, []);
  console.log(`Synthetic lifecycle passed: restart preserved world; two enter/exit cycles; ${exited.worlds.length} world instances, static disposals ${exited.worlds.map((w) => w.statics.length).join("/")}, order markers ${exited.worlds[firstIndex].order.length}, playback players ${exited.worlds[firstIndex].players.length}; pending auto timer cancelled; settings resize observers and handlers cleaned up.`);
  console.log("Not native-device, physical-input, GC, driver-memory, or user acceptance.");
} finally { await browser.close(); }
