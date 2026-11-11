#!/usr/bin/env node
// 机场岛（2026-10-22 起是可行驶的地标平台；堤道是路网里的一段桥面，不再由 buildAirport 画）：
//   (a) 平台顶面 = AIRPORT_PLATFORM.top，跑道 / 滑行道 / 航站楼 / 塔台都立在这一层——曾经平台顶 0.4、它们底在 1.4，整组悬空 1；
//   (b) 跑道、滑行道、标线是贴面薄层（cityDrivingNonSolid）：车从平台上横穿跑道不撞；航站楼等建筑仍是实体；
//   (c) buildAirport 不再画装饰堤道（台阶状水平箱体，顶面 2.9→4.2、起点高出岸上路面近 2，车开不上去）。
import assert from 'node:assert/strict';
import {loadCity} from './city-kit/index.mjs';
const k=await loadCity({'engine/cityAirport.ts':['buildAirport','AIRPORT_PLATFORM'],'engine/surface/sceneSolids.ts':['collectSceneSolids'],
  'game/driving/CollisionIndex.ts':['buildCollisionIndex'],'game/driving/DrivingCollision.ts':['sweepBody'],'pkg:three':['* as THREE']});
const {THREE}=k; const TOP=k.AIRPORT_PLATFORM.top;
const plan={shore:{x:0,z:-200},centre:{x:0,z:0},outward:{x:0,z:1},yaw:0};
const disposables=[],root=k.buildAirport(plan,disposables,null);
root.updateMatrixWorld(true);
const meshes=[];root.traverse((o)=>{if(o.isMesh)meshes.push(o);});
const bounds=(m)=>new THREE.Box3().setFromObject(m);
const platform=meshes.find((m)=>{const b=bounds(m);return Math.abs(b.max.x-b.min.x-240)<0.01&&Math.abs(b.max.z-b.min.z-110)<0.01;});
assert.ok(platform,'the reclaimed platform is drawn');
assert.ok(Math.abs(bounds(platform).max.y-TOP)<1e-6,`platform top is the apron level ${TOP} (was 0.4 under items at 1.4)`);
const flats=meshes.filter((m)=>m.userData.cityDrivingNonSolid===true);
assert.ok(flats.length>=30,'runway, taxiway and markings are flagged as drive-over skins');
for(const m of flats){const b=bounds(m);assert.ok(b.min.y>=TOP-1e-6&&b.max.y<=TOP+0.04,`skin sits on the apron (${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)})`);}
const standing=meshes.filter((m)=>m!==platform&&!m.userData.cityDrivingNonSolid&&bounds(m).min.y>-1);
for(const m of standing){const b=bounds(m);assert.ok(b.min.y>=TOP-1e-6,`nothing on the island sinks below the apron (${b.min.y.toFixed(2)})`);}
assert.ok(standing.some((m)=>Math.abs(bounds(m).min.y-TOP)<1e-6),'terminal and tower stand on the apron, not floating');
assert.ok(!meshes.some((m)=>{const b=bounds(m);return b.min.z<-60&&b.max.y>TOP+0.5;}),'no decorative causeway is drawn off the island any more');
const solids=k.buildCollisionIndex(k.collectSceneSolids(root)).solids();
assert.ok(solids.length>10,'terminal, fingers and tower are still physical solids');
// 车（标定整车尺寸）沿平台在跑道 / 滑行道之间横穿：贴面薄层不挡车。
const dims={halfLength:1.5,halfWidth:1.032,halfHeight:.575};
const pose=(z)=>({x:-60,y:TOP+0.04+.675,z,heading:Math.PI/2,pitch:0,roll:0});
const across=k.sweepBody(solids,pose(-40),pose(10),dims);
assert.equal(across.status,'clear',`a car crosses the runway and taxiway on the apron: ${across.reason}`);
const intoTerminal=k.sweepBody(solids,{...pose(10),x:0},{...pose(30),x:0},dims);
assert.equal(intoTerminal.status,'contact','…and the terminal is a real obstacle');
for(const d of disposables)d.dispose();
console.log('Airport island: apron at the platform top (no floating terminal), runway/taxiway are drive-over skins, terminal and tower stay solid, no decorative stepped causeway.');
