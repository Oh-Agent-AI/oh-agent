import type { DiagnosticV1, Result } from "./types";

export interface GlbModelInspectionV1 {
  format: "glb-v2";
  byteLength: number;
  meshCount: number;
  primitiveCount: number;
  nodeCount: number;
  vertexCount: number;
  triangleCount: number;
  boundsMeters?: Readonly<{ x: number; y: number; z: number }>;
}

const fail = (code: string, path: string, message: string): Result<GlbModelInspectionV1> => ({
  ok: false,
  diagnostics: [{ code, severity: "error", path, message }],
});
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const MAX_GLB_BYTES = 64 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** Inspect an in-memory GLB v2 container. Filesystem reads and digest/signature checks belong to the trusted importer. */
export function inspectGlbBytes(input: unknown): Result<GlbModelInspectionV1> {
  if (!(input instanceof Uint8Array)) return fail("model_input_invalid", "$", "Model input must be GLB bytes.");
  if (input.byteLength < 20 || input.byteLength > MAX_GLB_BYTES) return fail("model_size_invalid", "$", "GLB size must be between 20 bytes and 64 MiB.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return fail("glb_magic_invalid", "header.magic", "Input does not have the GLB magic value.");
  if (view.getUint32(4, true) !== 2) return fail("glb_version_unsupported", "header.version", "Only GLB version 2 is supported.");
  if (view.getUint32(8, true) !== input.byteLength) return fail("glb_length_mismatch", "header.length", "Declared GLB length must match the supplied byte length.");

  let offset = 12;
  let jsonChunk: Uint8Array | null = null;
  let binaryLength = 0;
  let binarySeen = false;
  while (offset < input.byteLength) {
    if (offset + 8 > input.byteLength) return fail("glb_chunk_truncated", `chunks@${offset}`, "GLB chunk header is truncated.");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (length === 0 || length % 4 !== 0 || end > input.byteLength || end < start) return fail("glb_chunk_invalid", `chunks@${offset}`, "GLB chunks must be aligned and contained within the file.");
    if (type === JSON_CHUNK) {
      if (jsonChunk || offset !== 12) return fail("glb_json_chunk_invalid", `chunks@${offset}`, "GLB must begin with exactly one JSON chunk.");
      jsonChunk = input.subarray(start, end);
    } else if (type === BIN_CHUNK) {
      if (!jsonChunk || binarySeen) return fail("glb_binary_chunk_invalid", `chunks@${offset}`, "GLB may contain one binary chunk after its JSON chunk.");
      binarySeen = true;
      binaryLength = length;
    } else return fail("glb_chunk_unsupported", `chunks@${offset}`, "Unsupported GLB chunk type.");
    offset = end;
  }
  if (!jsonChunk || offset !== input.byteLength) return fail("glb_json_missing", "chunks", "GLB must contain a complete JSON chunk.");

  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonChunk).replace(/[\u0000\u0020]+$/g, "");
    document = JSON.parse(text);
  } catch {
    return fail("glb_json_invalid", "chunks.json", "GLB JSON chunk is not valid UTF-8 JSON.");
  }
  if (!object(document) || !object(document.asset) || document.asset.version !== "2.0") return fail("gltf_asset_invalid", "asset", "GLB JSON must declare glTF asset version 2.0.");
  const extensionsUsed = document.extensionsUsed === undefined ? [] : document.extensionsUsed;
  const extensionsRequired = document.extensionsRequired === undefined ? [] : document.extensionsRequired;
  if (!array(extensionsUsed) || !array(extensionsRequired) || extensionsUsed.length > 64 || extensionsRequired.length > 64
    || [...extensionsUsed, ...extensionsRequired].some(extension => typeof extension !== "string" || extension.length === 0 || extension.length > 128)) {
    return fail("gltf_extensions_invalid", "extensionsUsed", "GLB extension declarations are malformed or exceed inspection limits.");
  }
  if (extensionsUsed.length > 0 || extensionsRequired.length > 0) return fail("gltf_extension_unsupported", "extensionsUsed", "This bounded inspector does not resolve glTF extensions; use an asset importer that supports the declared extensions.");
  const buffersValue = document.buffers === undefined ? [] : document.buffers;
  const imagesValue = document.images === undefined ? [] : document.images;
  const accessorsValue = document.accessors === undefined ? [] : document.accessors;
  const bufferViewsValue = document.bufferViews === undefined ? [] : document.bufferViews;
  const meshesValue = document.meshes === undefined ? [] : document.meshes;
  const nodesValue = document.nodes === undefined ? [] : document.nodes;
  if (![buffersValue, imagesValue, accessorsValue, bufferViewsValue, meshesValue, nodesValue].every(array)) {
    return fail("gltf_structure_invalid", "$", "GLB model arrays must be arrays.");
  }
  const buffers = buffersValue as unknown[];
  const images = imagesValue as unknown[];
  const accessors = accessorsValue as unknown[];
  const bufferViews = bufferViewsValue as unknown[];
  const meshes = meshesValue as unknown[];
  const nodes = nodesValue as unknown[];
  if (images.length > 4_096 || meshes.length > 4_096 || nodes.length > 20_000 || accessors.length > 50_000 || bufferViews.length > 50_000) {
    return fail("gltf_structure_invalid", "$", "GLB model arrays are invalid or exceed inspection limits.");
  }
  if (buffers.length > 1) return fail("gltf_buffer_count_unsupported", "buffers", "Only one embedded GLB buffer is supported by this inspector.");
  if (buffers.some(buffer => !object(buffer) || buffer.uri !== undefined || !Number.isSafeInteger(buffer.byteLength) || (buffer.byteLength as number) < 0 || (buffer.byteLength as number) > binaryLength)) {
    return fail("gltf_external_buffer", "buffers", "Buffers must be embedded in the GLB binary chunk and fit within its declared length.");
  }
  if (buffers.length > (binarySeen ? 1 : 0) || (buffers.length === 1 && !binarySeen)) return fail("gltf_buffer_missing", "buffers", "GLB buffer declaration does not match its binary chunk.");
  const declaredBufferLength = buffers.length === 1 && object(buffers[0]) ? buffers[0].byteLength as number : 0;
  for (const [index, raw] of bufferViews.entries()) {
    const path = `bufferViews[${index}]`;
    if (!object(raw)) return fail("gltf_buffer_view_invalid", path, "Buffer view must be an object.");
    const byteOffset = raw.byteOffset ?? 0;
    if (raw.buffer !== 0 || !Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) <= 0
      || !Number.isSafeInteger(byteOffset) || (byteOffset as number) < 0
      || (byteOffset as number) + (raw.byteLength as number) > declaredBufferLength
      || (raw.byteStride !== undefined && (!Number.isSafeInteger(raw.byteStride) || (raw.byteStride as number) < 4 || (raw.byteStride as number) > 252 || (raw.byteStride as number) % 4 !== 0))
      || (raw.target !== undefined && raw.target !== 34962 && raw.target !== 34963)) {
      return fail("gltf_buffer_view_invalid", path, "Buffer views must select the embedded buffer and fit within its declared byte length and stride limits.");
    }
  }
  const componentBytes = new Map<number, number>([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
  const componentCount = new Map<string, number>([["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4]]);
  const checkedAccessors = new Map<number, { type: string; componentType: number; count: number }>();
  const accessorAt = (index: number): { type: string; componentType: number; count: number } | null => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= accessors.length) return null;
    const cached = checkedAccessors.get(index);
    if (cached) return cached;
    const raw = accessors[index];
    if (!object(raw) || raw.sparse !== undefined || !Number.isSafeInteger(raw.count) || (raw.count as number) < 1
      || typeof raw.type !== "string" || !componentCount.has(raw.type)
      || !Number.isSafeInteger(raw.componentType) || !componentBytes.has(raw.componentType as number)
      || !Number.isSafeInteger(raw.byteOffset ?? 0) || ((raw.byteOffset ?? 0) as number) < 0) return null;
    const viewIndex = raw.bufferView;
    if (!Number.isSafeInteger(viewIndex) || (viewIndex as number) < 0 || (viewIndex as number) >= bufferViews.length) return null;
    const bufferView = bufferViews[viewIndex as number];
    if (!object(bufferView)) return null;
    const bytesPerComponent = componentBytes.get(raw.componentType as number)!;
    const elementBytes = bytesPerComponent * componentCount.get(raw.type)!;
    const stride = (bufferView.byteStride as number | undefined) ?? elementBytes;
    const offset = (raw.byteOffset ?? 0) as number;
    const viewLength = bufferView.byteLength as number;
    if (offset % bytesPerComponent !== 0 || stride < elementBytes
      || offset + stride * ((raw.count as number) - 1) + elementBytes > viewLength) return null;
    const result = { type: raw.type, componentType: raw.componentType as number, count: raw.count as number };
    checkedAccessors.set(index, result);
    return result;
  };
  for (let index = 0; index < accessors.length; index += 1) if (!accessorAt(index)) {
    return fail("gltf_accessor_bounds_invalid", `accessors[${index}]`, "Accessor type, component, byte offset, count, or buffer view range is invalid or unsupported.");
  }
  if (images.some(image => !object(image) || image.uri !== undefined || !Number.isSafeInteger(image.bufferView)
    || (image.bufferView as number) < 0 || (image.bufferView as number) >= bufferViews.length
    || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg"))) {
    return fail("gltf_external_image", "images", "Images must use bounded embedded PNG/JPEG buffer views; external URIs are not allowed.");
  }
  if (nodes.some(node => !object(node) || (node.mesh !== undefined && (!Number.isSafeInteger(node.mesh) || (node.mesh as number) < 0 || (node.mesh as number) >= meshes.length)))) {
    return fail("gltf_node_invalid", "nodes", "Node mesh references must resolve to a declared mesh.");
  }

  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY, minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY, maxZ = Number.NEGATIVE_INFINITY;
  let hasBounds = false;
  for (const [meshIndex, rawMesh] of meshes.entries()) {
    if (!object(rawMesh) || !array(rawMesh.primitives) || rawMesh.primitives.length > 1_024) return fail("gltf_mesh_invalid", `meshes[${meshIndex}]`, "Mesh primitives must be an array of at most 1024 entries.");
    for (const [primitiveIndex, rawPrimitive] of rawMesh.primitives.entries()) {
      const path = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
      if (!object(rawPrimitive) || !object(rawPrimitive.attributes)) return fail("gltf_primitive_invalid", path, "Primitive attributes or mode are invalid.");
      for (const [semantic, accessorIndex] of Object.entries(rawPrimitive.attributes)) if (!accessorAt(accessorIndex as number)) {
        return fail("gltf_attribute_accessor_invalid", `${path}.attributes.${semantic}`, "Every primitive attribute must reference a bounded supported accessor.");
      }
      const modeValue = rawPrimitive.mode ?? 4;
      if (typeof modeValue !== "number" || !Number.isInteger(modeValue) || modeValue < 0 || modeValue > 6) return fail("gltf_primitive_invalid", path, "Primitive attributes or mode are invalid.");
      const positionIndex = rawPrimitive.attributes.POSITION;
      if (!Number.isSafeInteger(positionIndex) || (positionIndex as number) < 0 || (positionIndex as number) >= accessors.length) return fail("gltf_position_accessor_invalid", `${path}.attributes.POSITION`, "Primitive must reference a valid POSITION accessor.");
      const accessor = accessors[positionIndex as number];
      const positionInfo = accessorAt(positionIndex as number);
      if (!object(accessor) || !positionInfo || positionInfo.type !== "VEC3" || positionInfo.componentType !== 5126) return fail("gltf_position_accessor_invalid", `${path}.attributes.POSITION`, "POSITION must reference a bounded float VEC3 accessor.");
      const vertices = positionInfo.count;
      vertexCount += vertices;
      if (vertexCount > 10_000_000) return fail("gltf_vertex_budget_exceeded", "meshes", "GLB exceeds the 10 million vertex inspection budget.");
      const mode = modeValue;
      const indexAccessor = rawPrimitive.indices;
      let elementCount = vertices;
      if (indexAccessor !== undefined) {
        const indices = accessorAt(indexAccessor as number);
        if (!indices || indices.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.componentType)) return fail("gltf_index_accessor_invalid", `${path}.indices`, "Index accessor must be a bounded unsigned SCALAR accessor.");
        elementCount = indices.count;
      }
      if (mode === 4) triangleCount += Math.floor(elementCount / 3);
      else if (mode === 5 || mode === 6) triangleCount += Math.max(0, elementCount - 2);
      primitiveCount += 1;
      if (array(accessor.min) && array(accessor.max) && accessor.min.length === 3 && accessor.max.length === 3
        && [...accessor.min, ...accessor.max].every(value => typeof value === "number" && Number.isFinite(value))) {
        hasBounds = true;
        minX = Math.min(minX, accessor.min[0] as number); minY = Math.min(minY, accessor.min[1] as number); minZ = Math.min(minZ, accessor.min[2] as number);
        maxX = Math.max(maxX, accessor.max[0] as number); maxY = Math.max(maxY, accessor.max[1] as number); maxZ = Math.max(maxZ, accessor.max[2] as number);
      }
    }
  }
  if (triangleCount > 20_000_000) return fail("gltf_triangle_budget_exceeded", "meshes", "GLB exceeds the 20 million triangle inspection budget.");
  const diagnostics: DiagnosticV1[] = [];
  if (!hasBounds) diagnostics.push({ code: "gltf_bounds_unavailable", severity: "warning", path: "accessors", message: "No POSITION accessor provides finite min/max bounds." });
  return {
    ok: true,
    value: Object.freeze({ format: "glb-v2", byteLength: input.byteLength, meshCount: meshes.length, primitiveCount, nodeCount: nodes.length,
      vertexCount, triangleCount, ...(hasBounds ? { boundsMeters: Object.freeze({ x: maxX - minX, y: maxY - minY, z: maxZ - minZ }) } : {}) }),
    diagnostics,
  };
}
