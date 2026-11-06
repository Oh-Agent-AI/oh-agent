import * as THREE from "three";
import type { LandmarkCtx } from "../../models/landmarkContext";
import { createRenderCanvas } from "../../renderCanvas";
import { hashSeed } from "../../../cityModel";

/** 地标「twist-tower」的程序化造型（从 cityParts.buildLandmarks 的 if 链原样搬出，行为不变）。 */
export function drawTwistTower({ group, landmark, material, cap, host }: LandmarkCtx): void {
  const h = Math.min(cap, 66);
  const floors = 22;
  const floorGeometry = new THREE.BoxGeometry(1, 1, 1);
  // 每层一条窗带（白墙上的深色玻璃带），夜里换成暖色亮窗——曾是纯色楼板，夜里整栋漆黑（真机夜景截图）。
  const bandDay = createRenderCanvas(); bandDay.width = 64; bandDay.height = 16;
  const dctx = bandDay.getContext("2d");
  if (dctx) { dctx.fillStyle = "#ffffff"; dctx.fillRect(0, 0, 64, 16); dctx.fillStyle = "#3f5662"; dctx.fillRect(0, 4, 64, 8); dctx.fillStyle = "#ffffff"; for (let x = 0; x < 64; x += 8) dctx.fillRect(x, 4, 1, 8); }
  const bandLit = createRenderCanvas(); bandLit.width = 64; bandLit.height = 16;
  const lctx = bandLit.getContext("2d");
  if (lctx) { lctx.fillStyle = "#000000"; lctx.fillRect(0, 0, 64, 16); for (let x = 0; x < 64; x += 8) { const on = hashSeed(`twist-window:${x}`); if (on < 0.25) continue; lctx.fillStyle = on > 0.85 ? "#bfe9ff" : "#ffd89a"; lctx.fillRect(x + 1, 4, 7, 8); } }
  const dayTex = new THREE.CanvasTexture(bandDay as HTMLCanvasElement); const litTex = new THREE.CanvasTexture(bandLit as HTMLCanvasElement);
  for (const t of [dayTex, litTex]) { t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.repeat.set(1, 1); } // 64px = 8 扇窗/面
  const floorMaterial = new THREE.MeshLambertMaterial({ color: "#ffffff", map: dayTex, emissive: new THREE.Color("#000000"), emissiveMap: dayTex });
  host.landmarkWindows.push({ material: floorMaterial, day: dayTex, lit: litTex, dayEmissive: new THREE.Color("#000000") });
  host.disposables.push(floorMaterial, dayTex, litTex);
  const floorMesh = new THREE.InstancedMesh(floorGeometry, floorMaterial, floors);
  const palette = ["#68c9d0", "#d78db3", "#9b9be0"];
  for (let i = 0; i < floors; i += 1) {
    host.compose(0, ((i + 0.5) * h) / floors, 0, (i / floors) * Math.PI * 0.5, 12, (h / floors) * 0.9, 12);
    floorMesh.setMatrixAt(i, host.matrix);
    floorMesh.setColorAt(i, host.color.set(palette[i % palette.length]));
  }
  floorMesh.instanceMatrix.needsUpdate = true;
  if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
  floorMesh.castShadow = floorMesh.receiveShadow = true;
  floorMesh.name = "city-landmark-twisting-deco-tower";
  group.add(floorMesh);
  host.disposables.push(floorGeometry, floorMaterial);
}
