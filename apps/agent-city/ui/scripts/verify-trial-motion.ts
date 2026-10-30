import test from "node:test";
import assert from "node:assert/strict";
import { trialMoveAlpha, trialMovementAllowed } from "../src/render/mecha/trialMotion.ts";
function simulate(fps:number, seconds:number) {
  let position=0;for(let i=0;i<fps*seconds;i++)position+=(14.4-position)*trialMoveAlpha(1/fps);return position;
}
test("trial easing matches reference 60 fps and remains time-based",()=>{
 assert.ok(Math.abs(trialMoveAlpha(1/60)-.22)<1e-12);
 for(const sec of [1,2])assert.ok(Math.abs(simulate(30,sec)-simulate(60,sec))<1e-10);
 assert.equal(trialMoveAlpha(0),0);assert.equal(trialMoveAlpha(-1),0);assert.equal(trialMoveAlpha(NaN),0);
 assert.equal(trialMoveAlpha(1),trialMoveAlpha(.1));
});

test("trial holds position during one-shot combat animations", () => {
 for (const action of ["idle", "move"] as const) assert.equal(trialMovementAllowed(action), true);
 for (const action of ["attack", "repair", "hit", "defeat"] as const) assert.equal(trialMovementAllowed(action), false);
});
