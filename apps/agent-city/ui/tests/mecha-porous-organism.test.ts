import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createMonsterSpeciesOrnament } from "../src/render/mecha/monsterSpeciesOrnaments.ts";

for (const role of ["Boss", "Raider"] as const) {
  test(`porous ${role}: interleaved bounded surface, stable proxy and resource ownership`, () => {
    const visual = createMonsterSpeciesOrnament("porous_shaper", role);
    const other = createMonsterSpeciesOrnament("porous_shaper", role);
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    const releases = new Map<THREE.BufferGeometry | THREE.Material, number>();
    try {
      const surface = visual.root.getObjectByName("monster-fx-organism") as THREE.Points;
      const manifold = visual.root.getObjectByName("monster-fx-manifold") as THREE.Points;
      const otherSurface = other.root.getObjectByName("monster-fx-organism") as THREE.Points;
      const proxy = visual.root.getObjectByName("species-sphere") as THREE.Mesh;
      assert.ok(surface instanceof THREE.Points && manifold instanceof THREE.Points && proxy instanceof THREE.Mesh);
      assert.notEqual(surface.geometry, otherSurface.geometry, "instances own independent geometry");
      assert.notEqual(surface.material, otherSurface.material, "instances own independent materials");
      assert.equal(surface.material, manifold.material, "interleaved batches share the same animated shader");
      assert.equal((proxy.material as THREE.Material).opacity, 0);
      assert.deepEqual(proxy.scale.toArray(), [3.6, 3.6, 3.6]);
      for (const name of ["monster-fx-core", "monster-fx-glass", "monster-fx-rim", "monster-fx-halo", "monster-fx-orbitals", "monster-fx-traces", "monster-fx-particles"]) {
        assert.equal(visual.root.getObjectByName(name)?.visible, false, `${name} must not obscure the organism`);
      }
      const rendered: string[] = [];
      visual.root.traverseVisible(node => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.LineSegments) rendered.push(node.name);
      });
      assert.deepEqual(rendered.sort(), ["monster-fx-emission", "monster-fx-manifold", "monster-fx-organism", "porous-channel-scaffold", "species-sphere"].sort(),
        "two point batches, the channel scaffold, and the existing proxy reach the renderer");
      const uvPairs = new Set<string>();
      let count = 0;
      for (const points of [surface, manifold]) {
        assert.equal(points.visible, true);
        const position = points.geometry.getAttribute("position"), uv = points.geometry.getAttribute("surfaceUv");
        assert.ok(position && uv && uv.count === position.count);
        const bound = points.geometry.boundingSphere;
        assert.ok(bound && bound.radius <= 5.5);
        for (let i = 0; i < position.count; i++) {
          const u = uv.getX(i), v = uv.getY(i);
          assert.ok(Number.isFinite(u) && Number.isFinite(v));
          uvPairs.add(`${u.toFixed(5)},${v.toFixed(5)}`);
          const radius = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
          // Conservative extrema of the breath and gyroid multipliers in the shader.
          assert.ok(radius * 1.105 * 1.24 * 2.9 <= bound.radius, "animation must fit the culling bound");
        }
        count += position.count;
      }
      assert.equal(count, 3600, "stay below the previous 2520 + 1200 point budget");
      assert.equal(uvPairs.size, count, "batches must cover distinct surface samples");
      assert.deepEqual(Array.from(surface.geometry.getAttribute("position").array), Array.from(otherSurface.geometry.getAttribute("position").array));
      assert.deepEqual(surface.rotation.toArray(), manifold.rotation.toArray());
      const surfaceMaterial = surface.material as THREE.ShaderMaterial;
      assert.equal(surfaceMaterial.uniforms.tint!.value.getHex(), 0x9ddae6);
      assert.equal(surfaceMaterial.uniforms.accent!.value.getHex(), 0xeeab66);
      const initial = Array.from(surface.geometry.getAttribute("position").array);
      visual.update(.1, false);
      assert.equal(surfaceMaterial.uniforms.phase!.value, .1);
      assert.deepEqual(surface.rotation.toArray(), manifold.rotation.toArray());
      const rotated = surface.rotation.y;
      visual.update(.1, true);
      assert.equal(surface.rotation.y, rotated, "reduced motion freezes the last orientation");
      assert.equal(surfaceMaterial.uniforms.phase!.value, .1);
      assert.deepEqual(Array.from(surface.geometry.getAttribute("position").array), initial, "animation does not rewrite samples");

      visual.root.updateMatrixWorld(true);
      const scale = role === "Boss" ? 1 : .5;
      const ray = new THREE.Raycaster(new THREE.Vector3(0, 4.5 * scale, -12), new THREE.Vector3(0, 0, 1));
      const hits = ray.intersectObject(visual.root, true);
      assert.ok(hits.length > 0 && hits.every(hit => hit.object === proxy), "only the unchanged proxy receives clicks");
      visual.root.traverse(node => {
        if (!(node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.LineSegments)) return;
        resources.add(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) resources.add(material);
      });
      for (const resource of resources) {
        releases.set(resource, 0);
        resource.addEventListener("dispose", () => releases.set(resource, releases.get(resource)! + 1));
      }
      visual.dispose(); visual.dispose();
      for (const [resource, released] of releases) assert.equal(released, 1, `${resource.type} must be released exactly once`);
    } finally { visual.dispose(); other.dispose(); }
  });
}
