/** 夜景机坪：点偏机甲不得锁机场地标；外扩只包住小队，不包航站楼。 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimParkedMechaClick, PARKED_MECHA_PICK_PAD, parkedMechaPickBoxes } from "../apps/agent-city/ui/src/engine/render/mechaPick.ts";

const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const THREE = require("three") as typeof import("three");

function rayThrough(origin: InstanceType<typeof THREE.Vector3>, target: InstanceType<typeof THREE.Vector3>) {
  return new THREE.Ray(origin.clone(), target.clone().sub(origin).normalize());
}

test("apron clicks beside a mech enter battle; the terminal and a nearer building do not", () => {
  const box = new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 10, 2));
  const beside = new THREE.Vector3(2 + PARKED_MECHA_PICK_PAD - 0.2, 0, 0);
  const farApron = new THREE.Vector3(2 + PARKED_MECHA_PICK_PAD + 3, 0, 0);
  const eyeBeside = beside.clone().add(new THREE.Vector3(0, 30, 12));
  assert.equal(claimParkedMechaClick({
    boxes: [box],
    ray: rayThrough(eyeBeside, beside),
    hit: { distance: eyeBeside.distanceTo(beside), point: beside, airportLandmark: true },
  }), true, "a click on the apron just off the body is the mecha, not the airport landmark");
  const eyeFar = farApron.clone().add(new THREE.Vector3(0, 40, 0));
  assert.equal(claimParkedMechaClick({
    boxes: [box],
    ray: rayThrough(eyeFar, farApron),
    hit: { distance: eyeFar.distanceTo(farApron), point: farApron, airportLandmark: true },
  }), false, "apron well outside the pad still selects the landmark");

  // 射线从身体空当穿到背后更远的机坪：命中点可以在外扩之外，仍然开战。
  const behind = new THREE.Vector3(0, 0, -2 - PARKED_MECHA_PICK_PAD - 6);
  const eyeFront = new THREE.Vector3(0, 5, 24);
  assert.equal(claimParkedMechaClick({
    boxes: [box],
    ray: rayThrough(eyeFront, behind),
    hit: { distance: eyeFront.distanceTo(behind), point: behind, airportLandmark: true },
  }), true, "a ray through the body silhouette still enters battle when the thin mesh is missed");

  // 更近的非机场命中（会话楼、飞机）挡在身体前面：不抢。
  const front = new THREE.Vector3(0, 5, 16);
  const eyeFarther = new THREE.Vector3(0, 5, 40);
  assert.equal(claimParkedMechaClick({
    boxes: [box],
    ray: rayThrough(eyeFarther, front),
    hit: { distance: eyeFarther.distanceTo(front), point: front, airportLandmark: false },
  }), false, "a closer non-airport hit keeps its own click");

  // 航站楼在身体前方、射线不穿过身体：直上直下打在楼顶。
  const terminal = new THREE.Vector3(0, 8, 30);
  const aboveTerminal = new THREE.Vector3(0, 40, 30);
  assert.equal(claimParkedMechaClick({
    boxes: [box],
    ray: rayThrough(aboveTerminal, terminal),
    hit: { distance: aboveTerminal.distanceTo(terminal), point: terminal, airportLandmark: true },
  }), false, "the terminal is the same landmark id but is not the mecha pad");

  const sky = rayThrough(new THREE.Vector3(0, 5, 20), new THREE.Vector3(0, 5, 0));
  assert.equal(claimParkedMechaClick({ boxes: [box], ray: sky, hit: null }), true, "a miss that still passes through the body halo starts battle");
  const skyMiss = rayThrough(new THREE.Vector3(40, 20, 40), new THREE.Vector3(40, 0, 40));
  assert.equal(claimParkedMechaClick({ boxes: [box], ray: skyMiss, hit: null }), false);
});

test("the parked squad pad joins the mechs and does not swallow the terminal", async () => {
  const { parkedMechaSquad } = await import("../apps/agent-city/ui/src/engine/render/playableVehicles.ts");
  const squad = parkedMechaSquad([]);
  // 与 cityAirport 相同的局部落点：东侧机坪，脚在平台顶面。
  squad.position.set(40, 1.4, 14);
  const boxes = parkedMechaPickBoxes(squad);
  assert.equal(boxes.length, 3, "one pick volume per mech");
  const ordered = [...boxes].sort((a, b) => a.min.x - b.min.x);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const gap = ordered[i + 1]!.min.x - ordered[i]!.max.x;
    assert.ok(gap < PARKED_MECHA_PICK_PAD * 2, `pad must close the ${gap.toFixed(2)} gap between parked mechs`);
    const mid = new THREE.Vector3((ordered[i]!.max.x + ordered[i + 1]!.min.x) / 2, ordered[i]!.min.y, (ordered[i]!.min.z + ordered[i]!.max.z) / 2);
    const eye = mid.clone().add(new THREE.Vector3(0, 36, 18));
    assert.equal(claimParkedMechaClick({
      boxes,
      ray: rayThrough(eye, mid),
      hit: { distance: eye.distanceTo(mid), point: mid, airportLandmark: true },
    }), true, "clicking the apron between two mechs enters battle");
  }
  // 航站楼壳片大约在局部 x=-36..36、z=30（见 cityAirport）。从正上方点，不穿过小队。
  const terminal = new THREE.Vector3(0, 8, 30);
  const above = new THREE.Vector3(0, 50, 30);
  assert.equal(claimParkedMechaClick({
    boxes,
    ray: rayThrough(above, terminal),
    hit: { distance: above.distanceTo(terminal), point: terminal, airportLandmark: true },
  }), false, "clicking the terminal from above still locks the airport landmark");
  for (const box of boxes) box.expandByScalar(PARKED_MECHA_PICK_PAD);
  assert.equal(boxes.some((box) => box.containsPoint(terminal)), false);
});
