"""Measure suspected openings between split rigged mesh boundaries in Blender.

blender --background --python scripts/audit_mecha_boundary_gaps.py -- \
  --blend /path/to/model.blend --out /tmp/gaps.json --samples 49

Works on an existing Blender file without saving or changing it. The mesh and
armature must be unambiguous. Matching nearby boundary edges finds candidates,
not semantic seams; inspect the reported faces and animation frames visually.
"""
import argparse
import collections
import json
import math
import sys
from pathlib import Path

import bpy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--blend', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--samples', type=int, default=49)
    parser.add_argument('--match-height', type=float, default=.002)
    parser.add_argument('--min-edge-height', type=float, default=.001)
    parser.add_argument('--alert-height', type=float, default=.01)
    parser.add_argument('--pair', action='append', metavar='BONE_A:BONE_B')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    if args.samples < 2 or any(not math.isfinite(x) or x <= 0 for x in (args.match_height, args.min_edge_height, args.alert_height)):
        parser.error('samples must be at least 2; thresholds must be finite and positive')
    pairs = args.pair or ['foot.L:shin.L', 'foot.R:shin.R', 'chest:thigh.L', 'chest:thigh.R', 'head:chest']
    if any(p.count(':') != 1 or not all(p.split(':')) for p in pairs):
        parser.error('each pair must be two bone names separated by :')
    bpy.ops.wm.open_mainfile(filepath=str(args.blend))
    scene = bpy.context.scene
    rigs = [o for o in scene.objects if o.type == 'ARMATURE']
    meshes = [o for o in scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)]
    if len(rigs) != 1 or len(meshes) != 1 or not rigs[0].animation_data:
        raise ValueError('expected one animated armature and one armature-modified mesh')
    rig, mesh = rigs[0], meshes[0]
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    rig.animation_data.action = None
    bpy.context.view_layer.update()

    def points():
        evaluated = mesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
        data = evaluated.to_mesh()
        try:
            result = [evaluated.matrix_world @ v.co for v in data.vertices]
            if len(result) != len(mesh.data.vertices):
                raise ValueError('evaluated topology differs from source mesh')
            return result
        finally:
            evaluated.to_mesh_clear()

    rest = points()
    height = max(v.z for v in rest) - min(v.z for v in rest)
    if not math.isfinite(height) or height <= 0:
        raise ValueError('invalid model height')
    names = {g.index: g.name for g in mesh.vertex_groups}
    bone = [names.get(max(v.groups, key=lambda g: g.weight).group, '?') if v.groups else '?' for v in mesh.data.vertices]
    counts = collections.Counter(tuple(sorted(edge)) for poly in mesh.data.polygons for edge in poly.edge_keys)
    boundaries = collections.defaultdict(list)
    for edge, count in counts.items():
        i, j = edge
        if count == 1 and bone[i] == bone[j] and bone[i] != '?' and (rest[i] - rest[j]).length >= args.min_edge_height * height:
            boundaries[bone[i]].append(edge)
    matched = []
    for pair in pairs:
        first, second = pair.split(':')
        if first not in rig.pose.bones or second not in rig.pose.bones:
            raise ValueError('bone not found: ' + pair)
        for i, j in boundaries[first]:
            for x, y in boundaries[second]:
                straight = max((rest[i] - rest[x]).length, (rest[j] - rest[y]).length)
                reversed_ = max((rest[i] - rest[y]).length, (rest[j] - rest[x]).length)
                if min(straight, reversed_) > height * args.match_height:
                    continue
                if reversed_ < straight:
                    x, y = y, x
                matched.append({'group': pair, 'edgeA': [i, j], 'edgeB': [x, y],
                                'restGap': min(straight, reversed_), 'edgeLength': (rest[i] - rest[j]).length})
    actions = sorted((a for a in bpy.data.actions if a.name.startswith('ground_half_trial_')), key=lambda a: a.name)
    if not actions:
        raise ValueError('no ground_half_trial_ actions found')
    clips = []
    for action in actions:
        rig.animation_data.action = action
        start, end = action.frame_range
        maxima = {}
        samples = []
        for k in range(args.samples):
            phase = k / (args.samples - 1)
            frame = start + (end - start) * phase
            scene.frame_set(int(frame), subframe=frame % 1)
            posed = points()
            groups = {}
            for entry in matched:
                i, j = entry['edgeA']; x, y = entry['edgeB']
                # The reported width is the larger endpoint separation, not an
                # exact visible hole width; endpoints remain paired to rest pose.
                gap = max((posed[i] - posed[x]).length, (posed[j] - posed[y]).length)
                item = groups.setdefault(entry['group'], {'maxGap': 0.0, 'edgesOverThreshold': 0})
                item['maxGap'] = max(item['maxGap'], gap)
                if gap > height * args.alert_height:
                    item['edgesOverThreshold'] += 1
                old = maxima.get(entry['group'])
                if old is None or gap > old['gap']:
                    maxima[entry['group']] = {'gap': gap, 'gapHeightFraction': gap / height, 'phase': phase,
                                               'frame': frame, 'edgeA': entry['edgeA'], 'edgeB': entry['edgeB'],
                                               'position': list((posed[i] + posed[j] + posed[x] + posed[y]) * .25)}
            bones = {}
            for side in ('L', 'R'):
                foot, shin = rig.pose.bones.get('foot.' + side), rig.pose.bones.get('shin.' + side)
                if foot and shin:
                    bones[side] = (rig.matrix_world @ foot.head - rig.matrix_world @ shin.tail).length
            samples.append({'phase': phase, 'frame': frame, 'groups': groups, 'ankleBoneGaps': bones})
        clips.append({'action': action.name, 'maxima': maxima, 'samples': samples})
    report = {'source': str(args.blend), 'height': height, 'sampleCount': args.samples,
              'matchHeightFraction': args.match_height, 'minEdgeHeightFraction': args.min_edge_height,
              'alertHeightFraction': args.alert_height, 'boundaryCount': sum(map(len, boundaries.values())),
              'matchedCount': len(matched), 'matchedEdges': matched, 'clips': clips,
              'limits': 'Candidates only. Nearby boundary edges can belong to intentionally independent parts; endpoint distance is not a measured visible hole or penetration depth. Unequal tessellation, closed surfaces, occlusion, coplanar overlaps and animation transitions are not covered.'}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('BOUNDARY_AUDIT', args.out, 'matched', len(matched), 'actions', len(clips), flush=True)


if __name__ == '__main__':
    main()
