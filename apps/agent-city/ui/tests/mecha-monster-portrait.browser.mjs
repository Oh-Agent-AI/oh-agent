#!/usr/bin/env node
// Render the actual Boss rig and MonsterSpeciesPresentation in an isolated local
// Vite fixture. From any directory:
//   MECHA_MONSTER_PORTRAIT_DIR=/tmp/monster-portraits node apps/agent-city/ui/tests/mecha-monster-portrait.browser.mjs
//   MECHA_MONSTER_GRID=1 adds _grid.png and the 10-species _grid_new.png.
//   MECHA_CHROME selects a Chrome executable.
// Individual PNGs are 1440x1440; pose, lighting, camera and animation time are fixed.
// This is a presentation fixture, not a screenshot of the complete City scene.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = process.env.MECHA_MONSTER_PORTRAIT_DIR;
if (!output) throw new Error("Set MECHA_MONSTER_PORTRAIT_DIR to the output directory");
const outputDir = path.resolve(output);
const ui = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const uiRequire = createRequire(path.join(ui, "package.json"));
const desktopRequire = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"));
const { createServer } = await import(pathToFileURL(uiRequire.resolve("vite")).href);
const { chromium } = desktopRequire("playwright");
const cacheDir = await mkdtemp(path.join(os.tmpdir(), "mecha-monster-portrait-"));
const size = 1440;
let server, browser;
try {
  await mkdir(outputDir, { recursive: true });
  server = await createServer({
    configFile: false, root: ui, cacheDir, logLevel: "error",
    plugins: [{ name: "monster-portrait-fixture", configureServer(vite) {
      vite.middlewares.use("/monster-portrait-fixture", (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><html><head><meta charset='utf-8'></head><body style='margin:0;overflow:hidden'></body></html>");
      });
    } }],
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = process.env.MECHA_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ headless: true,
    ...(process.env.MECHA_CHROME || existsSync(chrome) ? { executablePath: chrome } : {}),
    args: ["--disable-background-networking", "--disable-component-update", "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  const context = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const blocked = [];
  await context.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  // Block WebSockets as well as HTTP, even if a future fixture adds one.
  assert.equal(typeof context.routeWebSocket, "function", "Playwright must support WebSocket interception");
  await context.routeWebSocket("**/*", ws => { blocked.push(ws.url()); ws.close(); });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.stack || error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${origin}/monster-portrait-fixture`, { waitUntil: "load" });
  const species = await page.evaluate(async ({ size }) => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const { createBoss, disposeMechaModel } = await import("/src/render/mecha/models.ts");
    const { createMonsterSpeciesPresentation } = await import("/src/game/mecha/presentation/monsters/MonsterSpeciesPresentation.ts");
    const { PLANNED_MONSTER_SPECIES_IDS } = await import("/src/game/mecha/monsters/contracts.ts");
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      throw new Error(`GLSL error: ${gl.getProgramInfoLog(program)}\n${gl.getShaderInfoLog(vertex)}\n${gl.getShaderInfoLog(fragment)}`);
    };
    renderer.setPixelRatio(1);
    renderer.setSize(size, size);
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#202832");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555566, 2));
    const key = new THREE.DirectionalLight(0xffffff, 1.3); key.position.set(-8, 14, -12); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9dbaff, 0.65); fill.position.set(10, 5, 8); scene.add(fill);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    let current;
    window.renderMonsterPortrait = id => {
      if (current) {
        current.visual.dispose();
        disposeMechaModel(current.rig);
        scene.remove(current.rig);
      }
      const rig = createBoss();
      scene.add(rig);
      const visual = createMonsterSpeciesPresentation(rig, id);
      current = { rig, visual };
      visual.update(0, true);
      const expected = id === "legacy_boss" ? "legacy" : "active";
      if (visual.status !== expected) throw new Error(`${id}: expected ${expected}, got ${visual.status}`);
      if (visual.root.parent !== scene || visual.pickRoot !== visual.root) {
        throw new Error(`${id}: production presentation is not attached to the scene`);
      }
      scene.updateMatrixWorld(true);
      const visibleRoot = visual.root;
      let meshCount = 0;
      visibleRoot.traverse(node => { if (node.isMesh) meshCount++; });
      if (!meshCount) throw new Error(`${id}: no presentation meshes`);
      const bounds = new THREE.Box3().setFromObject(visibleRoot);
      if (bounds.isEmpty()) throw new Error(`${id}: empty presentation bounds`);
      const center = bounds.getCenter(new THREE.Vector3());
      // Front (-Z), slightly elevated three-quarter view, preserving depth and silhouette.
      const direction = new THREE.Vector3(0.38, 0.30, -1).normalize();
      camera.position.copy(center).addScaledVector(direction, 100);
      camera.lookAt(center); camera.updateMatrixWorld(true);
      let extent = 0;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
      }
      if (!Number.isFinite(extent) || extent <= 0) throw new Error(`${id}: invalid framing`);
      extent *= 1.12;
      camera.left = camera.bottom = -extent; camera.right = camera.top = extent; camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const gl = renderer.getContext();
      if (gl.isContextLost()) throw new Error(`${id}: WebGL context lost`);
      const glError = gl.getError();
      if (glError !== gl.NO_ERROR) throw new Error(`${id}: WebGL error ${glError}`);
      // A successful render must contain more than the solid background.
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let changed = 0;
      for (let i = 4; i < pixels.length; i += 4) {
        if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) changed++;
      }
      if (changed < size * size * 0.005) throw new Error(`${id}: nearly blank render (${changed} pixels)`);
      return { id, status: visual.status, meshes: meshCount, changed };
    };
    return [...PLANNED_MONSTER_SPECIES_IDS, "legacy_boss"];
  }, { size });
  assert.equal(new Set(species).size, species.length, "species IDs must be unique");
  const images = [];
  for (const id of species) {
    assert.match(id, /^[a-z0-9_]+$/, "species IDs must be safe PNG filenames");
    const result = await page.evaluate(id => window.renderMonsterPortrait(id), id);
    const file = path.join(outputDir, `${id}.png`);
    const image = await page.screenshot({ path: file, animations: "disabled" });
    if (id === "porous_shaper") {
      // Measure the actual screenshot at overview size, not just full-size point
      // coverage: thin points can disappear when the portrait is downsampled.
      const metrics = await page.evaluate(async data => {
        const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 360;
        const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0, 360, 360);
        const px = ctx.getImageData(0, 0, 360, 360).data, bg = Array.from(px.slice(0, 3));
        let readable = 0, cyan = 0, amber = 0, clipped = 0;
        for (let i = 0; i < px.length; i += 4) {
          const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
          if (Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2])) < 20) continue;
          readable++;
          if (b - r >= 8 && g - r >= 8) cyan++;
          if (r - b >= 8 && g - b >= 3) amber++;
          if (Math.min(r, g, b) >= 240) clipped++;
        }
        return { readable, cyan, amber, clipped };
      }, image.toString("base64"));
      assert.ok(metrics.readable > 6000 && metrics.cyan > 4000 && metrics.amber > 700,
        `porous overview must retain readable cyan and amber layers: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.clipped < 32, `porous overview highlights must stay bounded: ${JSON.stringify(metrics)}`);
      console.log(`porous overview pixels: ${JSON.stringify(metrics)}`);
    }
    if (process.env.MECHA_MONSTER_GRID === "1") images.push({ id, data: image.toString("base64") });
    console.log(`${result.id}: ${file} (${result.status}, ${result.meshes} meshes)`);
  }
  if (images.length) {
    // Composite the actual screenshots, not a separately constructed approximation.
    for (const [name, items] of [["_grid.png", images], ["_grid_new.png", images.filter(item => item.id !== "legacy_boss")]]) {
      if (name === "_grid_new.png") assert.equal(items.length, 10, "new-species grid excludes legacy");
      const grid = await page.evaluate(async images => {
        const cell = 360, label = 34, cols = 4, rows = Math.ceil(images.length / cols);
        const canvas = document.createElement("canvas"); canvas.width = cols * cell; canvas.height = rows * (cell + label);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#121922"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ffffff"; ctx.font = "18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (const [i, item] of images.entries()) {
          const img = new Image(); img.src = `data:image/png;base64,${item.data}`; await img.decode();
          const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + label);
          ctx.drawImage(img, x, y, cell, cell); ctx.fillText(item.id, x + cell / 2, y + cell + label / 2);
        }
        return canvas.toDataURL("image/png").split(",")[1];
      }, items);
      const { writeFile } = await import("node:fs/promises");
      const file = path.join(outputDir, name);
      await writeFile(file, Buffer.from(grid, "base64"));
      console.log(`grid: ${file} (${items.length} species)`);
    }
  }
  assert.deepEqual(errors, [], "page, console and GLSL errors must fail the capture");
  assert.deepEqual(blocked, [], "the fixture must not attempt non-local network access");
} finally {
  await browser?.close();
  await server?.close();
  await rm(cacheDir, { recursive: true, force: true });
}
