import test from "node:test";
import assert from "node:assert/strict";
import { inspectGlbBytes } from "../src/model";

function makeGlb(document: Record<string, unknown>, binaryLength = 40): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(jsonBytes.byteLength / 4) * 4;
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(jsonBytes, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true); view.setUint32(binaryHeader + 4, 0x004e4942, true);
  return bytes;
}

const triangle = {
  asset: { version: "2.0" },
  buffers: [{ byteLength: 40 }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
    { buffer: 0, byteOffset: 36, byteLength: 4, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: 1, componentType: 5121, count: 3, type: "SCALAR" },
  ],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  nodes: [{ mesh: 0 }],
};

test("inspects bounded GLB geometry and derives mesh bounds", () => {
  const result = inspectGlbBytes(makeGlb(triangle));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.vertexCount, 3);
    assert.equal(result.value.triangleCount, 1);
    assert.deepEqual(result.value.boundsMeters, { x: 1, y: 1, z: 0 });
  }
});

test("rejects accessors whose computed byte range escapes their buffer view", () => {
  const document = structuredClone(triangle);
  document.accessors[0] = { ...document.accessors[0], count: 4 };
  const result = inspectGlbBytes(makeGlb(document));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "gltf_accessor_bounds_invalid");
});

test("rejects buffer views that escape the embedded buffer", () => {
  const document = structuredClone(triangle);
  document.bufferViews[1] = { ...document.bufferViews[1], byteOffset: 39, byteLength: 4 };
  const result = inspectGlbBytes(makeGlb(document));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "gltf_buffer_view_invalid");
});

test("fails explicitly on GLB extensions the bounded inspector does not resolve", () => {
  const result = inspectGlbBytes(makeGlb({ ...triangle, extensionsUsed: ["EXT_meshopt_compression"], extensionsRequired: ["EXT_meshopt_compression"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.diagnostics[0]?.code, "gltf_extension_unsupported");
});
