"""Blender-only candidate screening of animated seams and cross-bone intersections.

blender --background --python scripts/audit_mecha_motion.py -- --glb MODEL.glb --out REPORT.json
Coordinates are in the imported scene; no source assets are modified.
"""
import argparse
import collections
import hashlib
import itertools
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument('--glb', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--samples', type=int, default=25)
    parser.add_argument('--near-height', type=float, default=0.0002)
    parser.add_argument('--gap-height', type=float, default=0.005)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if args.samples < 2 or args.near_height <= 0 or args.gap_height <= 0:
        parser.error('samples must be >= 2 and thresholds must be positive')
    return args


def evaluated_positions(mesh):
    evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    data = evaluated.to_mesh()
    try:
        return [evaluated.matrix_world @ v.co for v in data.vertices]
    finally:
        evaluated.to_mesh_clear()


def main():
    args = arguments()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(args.glb))
    scene = bpy.context.scene
    rigs = [o for o in scene.objects if o.type == 'ARMATURE']
    meshes = [o for o in scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
    if len(rigs) != 1 or len(meshes) != 1:
        raise ValueError('expected exactly one armature and one skinned mesh; inspect this asset manually')
    rig, mesh = rigs[0], meshes[0]
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = None
    bpy.context.view_layer.update()
    baseline = evaluated_positions(mesh)
    height = max(v.z for v in baseline) - min(v.z for v in baseline)
    if not math.isfinite(height) or height <= 0:
        raise ValueError('invalid model height')
    bone_names = {g.index: g.name for g in mesh.vertex_groups}
    dominant = [bone_names.get(max(v.groups, key=lambda g: g.weight).group, '?') if v.groups else '?' for v in mesh.data.vertices]
    tree = KDTree(len(baseline))
    for i, point in enumerate(baseline):
        tree.insert(point, i)
    tree.balance()
    # Quantized/UV-split models may duplicate a point many times. Record only
    # the closest representative for each other bone for each source vertex.
    candidates = set()
    for i, point in enumerate(baseline):
        closest = {}
        for _, j, distance in tree.find_range(point, height * args.near_height):
            if i == j or dominant[i] == dominant[j] or '?' in (dominant[i], dominant[j]):
                continue
            old = closest.get(dominant[j])
            if old is None or (distance, j) < old:
                closest[dominant[j]] = (distance, j)
        for _, j in closest.values():
            candidates.add(tuple(sorted((i, j))))
    seam_pairs = [(i, j, (baseline[i] - baseline[j]).length) for i, j in sorted(candidates)]
    bone_faces = collections.defaultdict(list)
    for poly in mesh.data.polygons:
        vertices = tuple(poly.vertices)
        if len(vertices) == 3 and len({dominant[v] for v in vertices}) == 1:
            name = dominant[vertices[0]]
            if name != '?':
                bone_faces[name].append((poly.index, vertices))
    # Cross-bone triangles include legitimate mechanical joints; they are leads,
    # not proof of visible clipping. Keep source polygon IDs for reproducibility.
    groups = list(itertools.combinations(sorted(bone_faces), 2))

    def overlaps(points):
        trees = {name: BVHTree.FromPolygons(points, [f for _, f in faces], all_triangles=True, epsilon=0.0)
                 for name, faces in bone_faces.items()}
        return {a + '/' + b: {(bone_faces[a][i][0], bone_faces[b][j][0]) for i, j in trees[a].overlap(trees[b])}
                for a, b in groups}

    bind_overlap = overlaps(baseline)
    clips = []
    for action in sorted(bpy.data.actions, key=lambda a: a.name):
        if not action.name.startswith('ground_half_trial_'):
            continue
        rig.animation_data.action = action
        start, end = action.frame_range
        seams = {}
        crossings = {}
        for sample in range(args.samples):
            phase = sample / (args.samples - 1)
            frame = start + (end - start) * phase
            scene.frame_set(int(frame), subframe=frame % 1)
            posed = evaluated_positions(mesh)
            for i, j, initial in seam_pairs:
                gap = (posed[i] - posed[j]).length
                growth = max(0.0, gap - initial) / height
                if growth < args.gap_height:
                    continue
                key = '/'.join(sorted((dominant[i], dominant[j])))
                item = seams.setdefault(key, {'maxGrowthHeight': 0.0, 'phase': 0.0, 'vertices': [], 'position': [], 'sampleHits': 0})
                item['sampleHits'] += 1
                if growth > item['maxGrowthHeight']:
                    item.update(maxGrowthHeight=growth, phase=phase, vertices=[i, j], position=list((posed[i] + posed[j]) * .5))
            current = overlaps(posed)
            for key, values in current.items():
                added = len(values - bind_overlap[key])
                item = crossings.setdefault(key, {'maxAddedPairs': 0, 'phase': 0.0, 'bindPairs': len(bind_overlap[key])})
                if added > item['maxAddedPairs']:
                    item.update(maxAddedPairs=added, phase=phase)
        clips.append({'name': action.name, 'seams': dict(sorted(seams.items(), key=lambda x: -x[1]['maxGrowthHeight'])),
                      'intersections': dict(sorted(((k, v) for k, v in crossings.items() if v['maxAddedPairs']), key=lambda x: -x[1]['maxAddedPairs']))})
    if not clips:
        raise ValueError('no ground_half_trial_ animation actions found')
    report = {'sha256': hashlib.sha256(args.glb.read_bytes()).hexdigest(), 'height': height, 'samplesPerClip': args.samples,
              'nearHeight': args.near_height, 'gapHeight': args.gap_height, 'candidateVertexPairs': len(seam_pairs),
              'limits': 'Candidates only: nearby independent joint surfaces may separate intentionally; pair counts are not visible holes or penetration depth. Cross-bone BVH misses coplanar overlaps, mixed-weight faces, occlusion and transitions. Review images and ground contact before editing.',
              'clips': clips}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('MOTION_AUDIT', args.out, 'pairs', len(seam_pairs), 'clips', len(clips), flush=True)


if __name__ == '__main__':
    main()
