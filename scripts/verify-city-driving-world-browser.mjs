#!/usr/bin/env node
// Synthetic host-only fixture. Never mounts CityApp, data providers or plugin IPC.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadCity } from "./city-kit/index.mjs";
import { sessionModel } from "./city-kit/session-models.mjs";
const require = createRequire(new URL("../apps/desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const { buildCityModel } = await loadCity({ "cityModel.ts": ["buildCityModel"] });
const model = sessionModel(buildCityModel, 90), base = process.argv[2] ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--use-angle=metal"] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.route(new URL("/__driving-world-test", base).href, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><canvas width='800' height='600'></canvas>" }));
  await page.goto(new URL("/__driving-world-test", base).href);
  const result = await page.evaluate(async (model) => {
    const { CityEngine } = await import("/src/engine/CityEngine.ts");
    const { captureRenderedSolids } = await import("/src/engine/surface/renderedSolids.ts");
    const { createCityCarSession, createCityCarDiagnosticSession } = await import("/src/game/runtime/createCityCarSession.ts");
    const { GameRuntime } = await import("/src/game/runtime/GameRuntime.ts");
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const engine = new CityEngine({ canvas: document.querySelector("canvas"), headless: true });
    const leases = [];
    const acquire = async () => { const c = await engine.captureDrivingWorld(); check(c.status === "ready", "world lease ready"); leases.push(c); return c; };
    const matchActual = (lease) => {
      const actual = captureRenderedSolids(engine.parts.drivingRoots).solids, owned = lease.readWorld().renderedSolids;
      check(actual.length === owned.length, "registered render mesh count matches");
      for (let i = 0; i < owned.length; i++) check(actual[i].id === owned[i].id && same(actual[i].positions, owned[i].positions) && same(actual[i].indices, owned[i].indices) && same(actual[i].transforms, owned[i].transforms), "exact current geometry and world instance matrices");
      return owned;
    };
    try {
      engine.setSeed(1); engine.applyModel(model);
      const [a, b] = await Promise.all([acquire(), acquire()]);
      check(a.worldRevision === b.worldRevision && engine.parts.drivingFreezeCount === 2, "shared freeze, independent leases");
      const solids = matchActual(a), roles = new Set(solids.map((s) => s.role));
      check(roles.has("building") && roles.has("landmark") && solids.some((s) => s.transforms.length > 16), "actual buildings, landmarks and instanced geometry present");
      check(a.readWorld().obstacleCoverage === "structures-and-rendered-buildings", "bounded coverage explicit");
      const currentStarted = performance.now();
      for (let i = 0; i < 1000; i++) check(a.isLeaseCurrent(), "fast frozen lease remains current");
      check(performance.now() - currentStarted < 250, "per-frame lease checks avoid rescanning mesh buffers");
      check(a.verifyCurrent(), "explicit deep validation at audit/session boundary");
      const mutatedCopy = a.readWorld(); mutatedCopy.renderedSolids[0].positions.fill(123);
      check(a.isCurrent() && a.readWorld().renderedSolids[0].positions[0] !== 123, "defensive typed array ownership");
      engine.parts.update(1, 10); check(a.isCurrent(), "frame cannot change frozen displayed geometry");
      engine.setTimeCursor(model.windowStartMs, { playing: false }); engine.parts.update(1, 11);
      check(a.isCurrent() && b.isCurrent(), "time jump queues while freeze held"); matchActual(a);
      // Read-only audit captures cannot claim frames/cameras. Interactive games
      // acquire the same exclusive tokenized host port, independently of readers.
      check(!("setFrameHook" in a) && !("setFrameHook" in b), "audit leases are read-only");
      let framesA = 0, framesB = 0;
      const firstAdmission = await engine.gameScenePort.acquireResult({ vehicle: "car", activity: "free" }, 1, new AbortController().signal);
      check(firstAdmission.status === "ready", `real car scene lease capture (${firstAdmission.status}${firstAdmission.status === "ready" ? "" : ":" + firstAdmission.reason})`);
      const firstScene = firstAdmission.lease;
      leases.push(firstScene);
      const staticSnapshot = firstScene.snapshot.staticWorld.readWorld();
      const drivingSnapshot = firstScene.snapshot.drivingWorld.readWorld();
      check(staticSnapshot && drivingSnapshot && JSON.stringify(staticSnapshot.obstacles) === JSON.stringify(drivingSnapshot.obstacles),
        "car static and driving snapshots share identical structural descriptors from one freeze");
      firstScene.setFrameHook(() => framesA++);
      let refused = false;
      const refusedAdmission = await engine.gameScenePort.acquireResult({ vehicle: "plane", activity: "practice" }, 2, new AbortController().signal);
      refused = refusedAdmission.status === "busy";
      check(refused, "second interactive owner refused"); engine.updateScene(0.02);
      check(framesA === 1 && framesB === 0, "single host frame callback");
      const afterFrame = captureRenderedSolids(engine.parts.drivingRoots).solids;
      for (let i=0;i<solids.length;i++) check(afterFrame[i] && same(solids[i].positions,afterFrame[i].positions) && same(solids[i].indices,afterFrame[i].indices) && same(solids[i].transforms,afterFrame[i].transforms), `freeze changed on host frame at ${solids[i].id}`);
      a.release(); a.release(); check(!a.isCurrent() && a.readWorld() === null && b.isCurrent(), "releasing one reader keeps peers and the active game frozen");
      firstScene.release();
      const nextAdmission = await engine.gameScenePort.acquireResult({ vehicle: "plane", activity: "practice" }, 3, new AbortController().signal);
      check(nextAdmission.status === "ready", `released scene slot admits next plane lease (${nextAdmission.status}${nextAdmission.status === "ready" ? "" : ":" + nextAdmission.reason})`);
      const nextScene = nextAdmission.lease;
      leases.push(nextScene); nextScene.setFrameHook(() => framesB++);
      firstScene.setFrameHook(null); firstScene.release(); engine.updateScene(0.02);
      check(framesA === 1 && framesB === 1, "old interactive lease cannot clear new frame owner");
      nextScene.release();
      b.release(); check(engine.parts.drivingFreezeCount === 0 && !b.isCurrent(), "last release restores time changes");
      const atStart = await acquire(); check(atStart.worldRevision !== b.worldRevision, "actual displayed height participates in identity"); matchActual(atStart);
      atStart.release();
      const repeated = await acquire(); check(repeated.worldRevision === atStart.worldRevision, "lease token does not change content identity"); repeated.release();
      const controller = new AbortController(); const cancelled = engine.captureDrivingWorld(controller.signal); controller.abort();
      check((await cancelled).status === "cancelled" && engine.parts.drivingFreezeCount === 0, "cancelled hash releases freeze");
      const tampered = await acquire();
      const shaft = engine.parts.shaftMeshes.find((m) => m.count > 0), value = shaft.instanceMatrix.array[13];
      shaft.instanceMatrix.array[13] = value + 1;
      check(tampered.readWorld() === null && !tampered.isLeaseCurrent(), "reading detects unexpected live geometry mutation and retires fast lease");
      shaft.instanceMatrix.array[13] = value; check(!tampered.isCurrent(), "restoring geometry cannot revive handle"); tampered.release();
      const disposedGeometry = await acquire(); shaft.geometry.dispose(); check(!disposedGeometry.isCurrent(), "geometry dispose invalidates frozen mesh"); disposedGeometry.release();
      const originalInfluences = shaft.morphTargetInfluences; shaft.morphTargetInfluences = [1];
      check((await engine.captureDrivingWorld()).status === "unavailable" && engine.parts.drivingFreezeCount === 0, "unsupported geometry releases acquired freeze"); shaft.morphTargetInfluences = originalInfluences;
      const originalCount = shaft.count; shaft.count = 100001;
      check((await engine.captureDrivingWorld()).status === "unavailable" && engine.parts.drivingFreezeCount === 0, "instance budget fails closed without retained freeze"); shaft.count = originalCount;
      const old = await acquire(); engine.applyModel(model, true); check(!old.isCurrent(), "rebuild invalidates lease"); old.release();
      const runtime = new GameRuntime();
      // Formal entry requires a current verified-spawn credential before it reserves the host.
      const invalid = await createCityCarSession(engine, runtime, { x: 0, z: 0, heading: 0, layerId: "ground",
        collider: { dimensions: { halfWidth: 0.9, halfLength: 2, halfHeight: 0.75 }, centerHeight: 0.75, vehicleConfigHash: "" }, present() {} });
      check(invalid.status === "unavailable" && invalid.reason === "validated-spawn-required", "bare formal coordinates fail closed");
      check(engine.parts.drivingFreezeCount === 0 && engine.gameFrame === null, "refused entry releases freeze and frame ownership");
      const beforeCamera = engine.renderCamera.position.clone();
      const cameraNear = engine.renderCamera.near;
      const entry = await createCityCarDiagnosticSession(engine, runtime, { collider: { dimensions: { halfWidth: 0.9, halfLength: 2, halfHeight: 0.75 }, centerHeight: 0.75, vehicleConfigHash: "synthetic-browser-car" }, present(frame, scene) {
          engine.presentDrivingCamera(frame.state, frame.frameSeconds, frame.cameraSweep, scene);
        } });
      check(entry.status === "ready" && entry.coverage.includes("buildings"), `real city diagnostic session enters with rendered-building collision (got ${entry.status}${entry.status === "unavailable" ? ":" + entry.reason : ":" + entry.coverage})`);
      check(engine.gameFrame !== null && engine.owner === "game", "session owns the host frame");
      check(engine.renderCamera.position.distanceTo(beforeCamera) > 1, "actual car camera moved to the diagnostic spawn");
      check(engine.renderCamera.near < cameraNear, "gameplay near plane calibrated for camera volume");
      runtime.resume(); runtime.setInput({ forward: true });
      for (let tick = 0; tick < 60; tick++) engine.updateScene(1 / 60);
      check([engine.renderCamera.position.x, engine.renderCamera.position.y, engine.renderCamera.position.z].every(Number.isFinite), "real camera sweep remains finite during city motion");
      runtime.dispose();
      check(engine.parts.drivingFreezeCount === 0 && engine.gameFrame === null, "runtime disposal releases freeze and frame ownership");
      check(engine.renderCamera.near === cameraNear, "release restores the original near plane");
      const { GameSession } = await import("/src/game/GameSession.ts");
      const flight = new GameSession(engine, { onState() {}, onExited() {} });
      const actualStaticSource = engine.parts.staticSource;
      engine.parts.staticSource = { ...actualStaticSource,
        ground: { ...actualStaticSource.ground, input: { ...actualStaticSource.ground.input, roadEdges: [] } } };
      const flying = await flight.enter({ mode: "practice" }, { cityReady: true, cinemaActive: false, filmActive: false, busy: false });
      check(flying.ok, `actual road-unavailable static flight admission: ${flying.reason ?? "ready"}`);
      check(flight.sceneLease?.snapshot.staticWorld.readWorld() && !flight.sceneLease.snapshot.drivingWorld,
        "plane host lease contains road-neutral static capture without a driving capture");
      for (let tick = 0; tick < 30; tick++) engine.updateScene(1 / 60);
      check(!!flight.snapshot().telemetry, "actual city flight has live telemetry");
      flight.exit(); flight.dispose();
      check(engine.parts.drivingFreezeCount === 0 && engine.gameFrame === null && engine.owner === "orbit", "flight releases shared frame and static pin");
      const carWithoutRoads = await engine.gameScenePort.acquireResult({ vehicle: "car", activity: "free" }, 10, new AbortController().signal);
      check(carWithoutRoads.status === "unavailable", "car still requires the road compiler when that capability is unavailable");
      engine.parts.staticSource = actualStaticSource;
      const fresh = await acquire(); matchActual(fresh); engine.dispose(); check(!fresh.isCurrent(), "dispose invalidates lease"); fresh.release();
      check((await engine.captureDrivingWorld()).status === "unavailable", "disposed world unavailable");
      return { meshes: solids.length, roles: [...roles], instances: solids.reduce((n, s) => n + s.transforms.length / 16, 0) };
    } finally { for (const lease of leases) lease.release(); engine.dispose(); }
  }, model);
  assert.deepEqual(errors, []);
  console.log(`Driving world browser: ${result.meshes} registered meshes / ${result.instances} instances (${result.roles.join(", ")}); exact render buffers/matrices, independent freeze leases, deferred timeline, token frame hook, cancellation, mutation, rebuild, disposal and real-city diagnostic entry passed.`);
} finally { await browser.close(); }
