import assert from "node:assert/strict";
import test from "node:test";
import { AssaultTurnPlayer, assaultSequenceWaiting } from "../apps/agent-city/ui/src/game/mecha/assaultTurnPlayer.ts";
const a = {x:0,y:0,z:0}, b={x:2,y:0,z:0}, c={x:2,y:0,z:2};
const turn1={id:1,points:[a,b],action:"attack" as const,actionDuration:1,hp:14,target:"boss"};
const turn2={id:2,points:[b,c],action:"attack" as const,actionDuration:1,hp:12,target:"boss"};
test("accepted turns retain order and attacks start only on arrival",()=>{
 const player=new AssaultTurnPlayer(a,2);player.enqueue(turn1);player.enqueue(turn2);
 let f=player.advance(.5);assert.equal(f.phase,"moving");assert.equal(f.started,undefined);assert.equal(f.position.x,1);
 player.setPaused(true);f=player.advance(20);assert.equal(f.position.x,1);assert.equal(f.pending,2);player.setPaused(false);
 f=player.advance(.5);assert.equal(f.started?.id,1);assert.equal(f.position.x,2);assert.equal(f.pending,2);
 f=player.advance(1);assert.equal(f.completed,1);assert.equal(f.pending,1);
 f=player.advance(.5);assert.equal(f.started,undefined);assert.equal(f.position.z,1);
 f=player.advance(.5);assert.equal(f.started?.id,2);assert.equal(f.position.z,2);
 f=player.advance(1);assert.equal(f.completed,2);assert.equal(f.pending,0);
});
test("sequence gaps and route discontinuity fail without moving or dropping queued work",()=>{
 const player=new AssaultTurnPlayer(a,2);player.enqueue(turn1);
 assert.throws(()=>player.enqueue({...turn2,id:3}));assert.throws(()=>player.enqueue({...turn2,points:[a,c]}));assert.equal(player.pending,1);
 const f=player.advance(.5);assert.equal(f.position.x,1);assert.equal(f.started,undefined);
});
test("a stationary turn still emits its cue and resolves once",()=>{
 const player=new AssaultTurnPlayer(a,2);player.enqueue({id:1,points:[a],actionDuration:0,hp:14});
 const f=player.advance(.1);assert.equal(f.started?.id,1);assert.equal(f.completed,1);assert.equal(f.pending,0);
 assert.equal(player.advance(.1).started,undefined);
});

test("turn gate only releases the current completed cue and resets immediately",()=>{
 const cue={id:4};
 assert.equal(assaultSequenceWaiting(true,cue,null),true);
 assert.equal(assaultSequenceWaiting(true,cue,{id:3,state:"done"}),true);
 assert.equal(assaultSequenceWaiting(true,cue,{id:4,state:"fault"}),true);
 assert.equal(assaultSequenceWaiting(true,cue,{id:4,state:"done"}),false);
 assert.equal(assaultSequenceWaiting(true,{id:5,reset:true},{id:4,state:"fault"}),false);
 assert.equal(assaultSequenceWaiting(false,cue,null),false);
});
