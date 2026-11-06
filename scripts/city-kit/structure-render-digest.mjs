// Digest of the structure meshes the road systems build (instance matrices/colours and raw
// geometry attributes), per system. Used to prove the descriptor extraction is render-neutral.
import { createHash } from "node:crypto";
export async function structureRenderDigests(kit, layout) {
  const { THREE } = kit;
  const meshes = [];
  const host = { layout, group: { add: (mesh) => meshes.push(mesh) }, disposables: [],
    positionVector: new THREE.Vector3(), euler: new THREE.Euler(), quaternion: new THREE.Quaternion(),
    scaleVector: new THREE.Vector3(), matrix: new THREE.Matrix4(), color: new THREE.Color(),
    makeInstanced(geometry, material, count) { const mesh = new THREE.InstancedMesh(geometry, material, count); meshes.push(mesh); return mesh; } };
  const out = {};
  for (const name of ["buildInfrastructure", "buildDistrictExpressways", "buildTrussBridges", "buildCulDeSacBulbs", "buildChannelizedJunctions"]) {
    meshes.length = 0;
    kit[name](host);
    const hash = createHash("sha256");
    for (const mesh of meshes) {
      hash.update(`${mesh.name}|${mesh.count ?? ""}|`);
      if (mesh.isInstancedMesh) {
        hash.update(new Uint8Array(mesh.instanceMatrix.array.buffer.slice(0, mesh.count * 64)));
        if (mesh.instanceColor) hash.update(new Uint8Array(mesh.instanceColor.array.buffer.slice(0, mesh.count * 12)));
      }
      for (const key of Object.keys(mesh.geometry.attributes).sort()) { const a = mesh.geometry.attributes[key].array; hash.update(key); hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
    }
    out[name] = hash.digest("hex");
    if (name === "buildInfrastructure") {
      // Curbs alone (colour #cbc6ba): bridge parts may change by design, curbs must not.
      const curbs = createHash("sha256"); const m = new THREE.Matrix4(); const c = new THREE.Color(); const curb = new THREE.Color("#cbc6ba");
      for (const mesh of meshes) if (mesh.isInstancedMesh && mesh.instanceColor) for (let i = 0; i < mesh.count; i++) {
        mesh.getColorAt(i, c); if (!c.equals(curb)) continue;
        mesh.getMatrixAt(i, m); curbs.update(new Uint8Array(new Float32Array(m.elements).buffer));
      }
      out["buildInfrastructure:curbs"] = curbs.digest("hex");
    }
  }
  return out;
}
