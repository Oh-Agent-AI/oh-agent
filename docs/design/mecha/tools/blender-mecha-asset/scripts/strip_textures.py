#!/usr/bin/env python3
"""Write a texture-free copy of a GLB so Node-side three.js checks can load it.

    python3 strip_textures.py in.glb out_notex.glb

Node has no image decoder, so GLTFLoader fails on embedded PNG/JPEG textures. Geometry, nodes and
animations are untouched; only texture references, textures, images and samplers are removed.
"""
import json
import struct
import sys

src, dst = sys.argv[1], sys.argv[2]
b = open(src, "rb").read()
n = struct.unpack("<I", b[12:16])[0]
g = json.loads(b[20:20 + n])
rest = b[20 + n:]
for m in g.get("materials", []):
    pb = m.get("pbrMetallicRoughness", {})
    pb.pop("baseColorTexture", None)
    pb.pop("metallicRoughnessTexture", None)
    for k in ("emissiveTexture", "normalTexture", "occlusionTexture"):
        m.pop(k, None)
for k in ("textures", "images", "samplers"):
    g.pop(k, None)
j = json.dumps(g).encode()
j += b" " * ((4 - len(j) % 4) % 4)
open(dst, "wb").write(struct.pack("<III", 0x46546C67, 2, 20 + len(j) + len(rest))
                      + struct.pack("<II", len(j), 0x4E4F534A) + j + rest)
print("wrote", dst)
