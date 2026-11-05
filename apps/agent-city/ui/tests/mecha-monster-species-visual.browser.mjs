#!/usr/bin/env node
// Synthetic WebGL smoke test, not CityMechaWorld integration or device acceptance.
// node tests/mecha-monster-species-visual.browser.mjs (from the UI directory)
// Optional MONSTER_VISUAL_SCREENSHOT writes the last synthetic view for inspection.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ui = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const uiRequire = createRequire(path.join(ui, "package.json"));
const desktopRequire = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { createServer } = await import(pathToFileURL(uiRequire.resolve("vite")).href);
const { chromium } = desktopRequire("playwright");
const cacheDir = await mkdtemp(path.join(os.tmpdir(), "mecha-species-visual-"));
let server, browser;
try {
  server = await createServer({ configFile: false, root: ui, cacheDir, logLevel: "error",
    plugins: [{ name: "visual-fixture", configureServer(vite) {
      vite.middlewares.use("/visual-fixture", (_req, res) => {
        res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><html><body style='margin:0'></body></html>");
      });
    } }],
    server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.MECHA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--disable-background-networking", "--disable-component-update"] });
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /THREE\.WebGLProgram|shader error/i.test(message.text())) errors.push(message.text());
  });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/visual-fixture`);
  const results = await page.evaluate(async () => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const { createBoss, createRaider, disposeMechaModel } = await import("/src/render/mecha/models.ts");
    const { createMonsterSpeciesPresentation } = await import("/src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts");
    const { PLANNED_MONSTER_SPECIES_IDS } = await import("/src/game/mecha/monsters/contracts.ts");
    const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(512, 512); document.body.append(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color("#202832");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 2));
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 150);
    const pixels = () => {
      renderer.render(scene, camera);
      const gl = renderer.getContext(), data = new Uint8Array(512 * 512 * 4);
      gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const result = [];
    for (const [role, make] of [["Boss", createBoss], ["Raider", createRaider]]) {
      for (const id of PLANNED_MONSTER_SPECIES_IDS) {
        const rig = make(); scene.add(rig);
        const visual = createMonsterSpeciesPresentation(rig, id);
        for (const side of ["city", "front"]) {
          camera.position.set(18, 25, side === "city" ? 30 : -30); camera.lookAt(0, 4, 0);
          visual.root.visible = false; const before = pixels();
          visual.update(0, true); const after = pixels();
          let changed = 0;
          for (let i = 0; i < before.length; i += 4) {
            if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++;
          }
          result.push({ role, id, side, changed });
        }
        visual.dispose(); disposeMechaModel(rig); scene.remove(rig);
      }
    }
    for (const id of PLANNED_MONSTER_SPECIES_IDS) {
      const rig = createBoss(); scene.add(rig);
      const visual = createMonsterSpeciesPresentation(rig, id);
      camera.position.set(18, 25, 30); camera.lookAt(0, 4, 0);
      visual.update(0, false); const initial = pixels();
      for (let frame = 0; frame < 30; frame++) visual.update(.1, false);
      const animated = pixels();
      visual.update(.1, true); const frozen = pixels();
      visual.update(.1, true); const frozenAgain = pixels();
      let changed = 0, drift = 0;
      for (let i = 0; i < initial.length; i += 4) {
        if (initial[i] !== animated[i] || initial[i+1] !== animated[i+1] || initial[i+2] !== animated[i+2]) changed++;
        if (frozen[i] !== frozenAgain[i] || frozen[i+1] !== frozenAgain[i+1] || frozen[i+2] !== frozenAgain[i+2]) drift++;
      }
      result.push({ role: "motion", id, side: "front", changed, drift });
      visual.dispose(); disposeMechaModel(rig); scene.remove(rig);
    }
    // Keep a final synthetic model visible for the optional screenshot.
    const rig = createBoss(); scene.add(rig);
    const visual = createMonsterSpeciesPresentation(rig, "field_sovereign");
    visual.update(0, true); camera.position.set(18, 25, 30); camera.lookAt(0, 4, 0); renderer.render(scene, camera);
    return result;
  });
  console.log(JSON.stringify(results));
  for (const result of results) assert.ok(result.changed >= 40, `${result.role} ${result.id} ${result.side} has only ${result.changed} visible pixels`);
  for (const result of results.filter(result => result.role === "motion")) assert.equal(result.drift, 0, `${result.id} must freeze in reduced motion`);
  if (process.env.MONSTER_VISUAL_SCREENSHOT) {
    await page.setViewportSize({ width: 2000, height: 1000 });
    await page.evaluate(async () => {
      const THREE = await import("/node_modules/three/build/three.module.js");
      const { createBoss } = await import("/src/render/mecha/models.ts");
      const { createMonsterSpeciesPresentation } = await import("/src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts");
      const { PLANNED_MONSTER_SPECIES_IDS } = await import("/src/game/mecha/monsters/contracts.ts");
      document.body.replaceChildren(); document.body.style.background = "#202832";
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(2000, 1000); renderer.setScissorTest(true); document.body.append(renderer.domElement);
      for (const [i, id] of PLANNED_MONSTER_SPECIES_IDS.entries()) {
        const scene = new THREE.Scene(); scene.background = new THREE.Color("#202832");
        scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 2));
        const rig = createBoss(); scene.add(rig);
        const visual = createMonsterSpeciesPresentation(rig, id); visual.update(0, true);
        const camera = new THREE.OrthographicCamera(-10, 10, 12.5, -12.5, 0.1, 150);
        camera.position.set(18, 25, 30); camera.lookAt(0, 4, 0);
        const x = (i % 5) * 400, y = (1 - Math.floor(i / 5)) * 500;
        renderer.setViewport(x, y, 400, 500); renderer.setScissor(x, y, 400, 500); renderer.render(scene, camera);
        const label = document.createElement("div"); label.textContent = id;
        Object.assign(label.style, { position: "absolute", left: `${x}px`, top: `${Math.floor(i / 5) * 500 + 466}px`,
          width: "400px", textAlign: "center", color: "white", font: "20px sans-serif" });
        document.body.append(label);
      }
    });
    await page.screenshot({ path: process.env.MONSTER_VISUAL_SCREENSHOT });
  }
  assert.deepEqual(errors, [], "browser and shader compilation must be error-free");
} finally {
  await browser?.close(); await server?.close(); await rm(cacheDir, { recursive: true, force: true });
}
