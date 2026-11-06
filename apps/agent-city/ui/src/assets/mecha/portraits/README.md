# Existing character-sheet portraits

These five runtime JPEGs are **crops of the existing 2026-10-26 concept sheets**,
not newly generated art and not generic line drawings. The repository's source
README documents the original imagegen provenance. No network or generation was
used for these derivatives; no license/ownership claim is added here.

Sources (repository-relative, plus exact absolute paths in `provenance.json`):
`docs/design/mecha/2026-10-26/{assault,gunner,support,boss,raider}.png`.
Original sheets are unchanged and are not imported by runtime code.

Each crop selects the primary 3/4 character view and removes page titles,
side/detail panels, ground markers and dimension/stat annotations. These are
square **portraits**, not full-body extractions: peripheral limbs/equipment are
intentionally clipped as recorded per image. Printed marks on the character's
armor (such as A-01/G-02) remain part of the source artwork; they are not rules or
an alternate unit name. The sheets' engineering annotations are unverified.

All outputs are 256 × 256 JPEG, final sips `formatOptions=82`. Raider west/east,
including compact `raider-w` / `raider-e`, share one species portrait; localization
and directional symbols remain in the identity descriptor/caller. Unknown IDs
have no portrait. `provenance.json` records source SHA-256, source dimensions,
original-pixel crop coordinates, output hashes, byte counts and tool version.
Coordinates have a top-left origin, x horizontal and y vertical.

## Reproduce locally

Run from the repository/worktree root on macOS with Python 3 and `/usr/bin/sips`.
This verifies each original hash before writing **only the derived JPEGs**.
Do not combine crop and resize into one sips invocation: sips may resize first
and apply crop offsets to the resized image rather than the original pixels.

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json, subprocess

out = Path('apps/agent-city/ui/src/assets/mecha/portraits')
manifest = json.loads((out / 'provenance.json').read_text())
for item in manifest['portraits']:
    source = Path(item['sourcePath'])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == item['sourceSha256']
    c = item['crop']
    target = out / item['output']['file']
    subprocess.run([
        '/usr/bin/sips', '-c', str(c['height']), str(c['width']),
        '--cropOffset', str(c['y']), str(c['x']),
        '-s', 'format', 'jpeg', '-s', 'formatOptions', '100',
        str(source), '--out', str(target),
    ], check=True)
    subprocess.run([
        '/usr/bin/sips', '-z', '256', '256', '-s', 'formatOptions', '82',
        str(target), '--out', str(target),
    ], check=True)
PY
```

Use the recorded sips version for byte-exact reproduction. Other encoder versions
may preserve crop coordinates/dimensions but differ in JPEG bytes; verify rather
than silently refreshing the provenance hashes.
