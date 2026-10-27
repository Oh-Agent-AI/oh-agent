# Example motion module for animate_rigid.py — the Agent City Assault (humanoid, rigid joints).
# Copy and edit per character. Axes: Blender (X, Y = forward, Z = up) ↔ three.js (X, Y = up, Z = back):
#   rotation about three X == Blender X; about three Y == Blender Z; about three Z == Blender −Y.
# Positive X rotation swings a hanging limb FORWARD (+Y). Knees bend with NEGATIVE X rotation.
import math

ID, ROLE, FOOTPRINT, VERSION = "assault", "Assault", [1, 1], 1
ACTION_MAP = {"repair": "attack"}          # unsupported actions map explicitly, never by default
MATERIALS = ["armor_palette", "faction_accent"]
M = 2.0                                    # the game's procedural poses are in scene units (1 = 2 m)

CH = [("visual", "location", 2), ("visual", "rotation_euler", 0), ("visual", "rotation_euler", 1),
      ("body", "location", 2), ("body", "rotation_euler", 0), ("body", "rotation_euler", 2),
      ("head", "rotation_euler", 0),
      ("upper_arm_l", "rotation_euler", 0), ("upper_arm_r", "rotation_euler", 0),
      ("forearm_l", "rotation_euler", 0), ("forearm_r", "rotation_euler", 0),
      ("thigh_l", "rotation_euler", 0), ("thigh_r", "rotation_euler", 0),
      ("shin_l", "rotation_euler", 0), ("shin_r", "rotation_euler", 0),
      ("foot_l", "rotation_euler", 0), ("foot_r", "rotation_euler", 0)]

# Loop clips use an angular frequency of 2π/duration so the first and last frames match.
CLIPS = {"idle": (3.14, True), "move": (0.79, True), "attack": (0.95, False),
         "hit": (0.48, False), "defeat": (0.85, False)}
NO_GROUND_LIFT = {"defeat"}                # the runtime lifts the fall (rearExtent); the clip must not


def pose(clip, t, dur):
    p = min(1.0, t / dur)
    d = {}
    if clip == "idle":
        d[("body", "location", 2)] = math.sin(2 * math.pi * t / dur) * 0.035 * M
    elif clip == "move":
        step = math.sin(2 * math.pi * t / dur)
        d[("thigh_l", "rotation_euler", 0)] = step * 0.30          # heavy unit: short stride
        d[("thigh_r", "rotation_euler", 0)] = -step * 0.30
        d[("shin_l", "rotation_euler", 0)] = -max(0, -step) * 0.5  # knees bend backward
        d[("shin_r", "rotation_euler", 0)] = -max(0, step) * 0.5
        d[("upper_arm_l", "rotation_euler", 0)] = -step * 0.23
        d[("upper_arm_r", "rotation_euler", 0)] = step * 0.23
        d[("body", "rotation_euler", 0)] = -0.05
        d[("visual", "location", 2)] = abs(step) * 0.08 * M
    elif clip == "attack":
        arc = math.sin(p * math.pi)
        d[("body", "rotation_euler", 2)] = -arc * 0.25
        d[("upper_arm_r", "rotation_euler", 0)] = arc * 1.8
        d[("forearm_r", "rotation_euler", 0)] = arc * 0.4
        d[("upper_arm_l", "rotation_euler", 0)] = arc * 0.55
    elif clip == "hit":
        kick = math.sin(p * math.pi) * (1 - p)
        d[("body", "rotation_euler", 0)] = kick * 0.4
        d[("visual", "rotation_euler", 1)] = -math.sin(p * math.pi * 3) * (1 - p) * 0.17
        d[("head", "rotation_euler", 0)] = kick * 0.3
    elif clip == "defeat":
        q = p * p * (3 - 2 * p)
        d[("visual", "rotation_euler", 0)] = q * math.pi / 2
    # Ankles counter-rotate so soles stay flat. Without ankles the toes stab the ground on every
    # step and the whole body must be lifted ~1 m to compensate.
    for side in "lr":
        d[(f"foot_{side}", "rotation_euler", 0)] = -(d.get((f"thigh_{side}", "rotation_euler", 0), 0.0)
                                                     + d.get((f"shin_{side}", "rotation_euler", 0), 0.0))
    return d
