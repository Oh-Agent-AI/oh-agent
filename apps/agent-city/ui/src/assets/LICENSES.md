# City assets — sources and licenses

Every file in this folder is listed here; `scripts/verify-react-city-assets.mjs` fails if a file
is missing from this table or if the folder exceeds the 5 MB budget. All files ship inside the
app bundle; nothing is fetched at runtime.

Files were downscaled to 512 px (ground / facade / normals) or 2048×1024 (skies) and re-encoded
as JPEG with macOS `sips`. HDR skies were tone-mapped (ACES, exposure noted) to 8-bit before
encoding — no `.hdr` file is shipped.

| File | Source asset | Author / site | License | Processing |
| --- | --- | --- | --- | --- |
| `sky-day.jpg` | `kloofendal_48d_partly_cloudy_puresky` (2K HDR) | Poly Haven — polyhaven.com | CC0 1.0 | ACES, exposure 1.0 → 2048×1024 q80 |
| `sky-dusk.jpg` | `kloppenheim_06_puresky` (2K HDR) | Poly Haven — polyhaven.com | CC0 1.0 | ACES, exposure 0.45 → 2048×1024 q80 |
| `ground-asphalt-02-color.jpg` / `-normal.jpg` | `asphalt_02` (1K diffuse, normal GL) | Poly Haven | CC0 1.0 | 512 q76 / q80 |
| `ground-concrete-pavement-02-color.jpg` / `-normal.jpg` | `concrete_pavement_02` | Poly Haven | CC0 1.0 | 512 q76 / q80 |
| `ground-coast-sand-01-color.jpg` / `-normal.jpg` | `coast_sand_01` | Poly Haven | CC0 1.0 | 512 q76 / q80 |
| `ground-brown-mud-02-color.jpg` / `-normal.jpg` | `brown_mud_02` | Poly Haven | CC0 1.0 | 512 q76 / q80 |
| `ground-aerial-grass-rock-color.jpg` / `-normal.jpg` | `aerial_grass_rock` | Poly Haven | CC0 1.0 | 512 q76 / q80 |
| `facade-glass.jpg` | `Facade001` (1K color) | ambientCG — ambientcg.com | CC0 1.0 | 512 q78 |
| `facade-commercial.jpg` | `Facade002` (1K color) | ambientCG | CC0 1.0 | 512 q78 |
| `facade-banded.jpg` | `Facade006` (1K color) | ambientCG | CC0 1.0 | 512 q78 |
| `stucco-normal.jpg` | `PaintedPlaster006` (1K normal GL; color map not used) | ambientCG | CC0 1.0 | 512 q78 |
| `water-normal.jpg` | `examples/textures/waternormals.jpg` | three.js — github.com/mrdoob/three.js | MIT (three.js authors) | 512 q80 |

## Flora (`flora/`)

Twenty low-poly vegetation models from **Kenney Nature Kit 2.1** (kenney.nl, "Created/distributed by Kenney",
License: Creative Commons Zero, CC0 — per the kit's `License.txt`). Copied unmodified as `.glb`; colour variants
(cherry pink, maple red) are applied at runtime, not baked into the files.

| File | Biome use |
| --- | --- |
| `flora/tree_palm.glb`, `flora/tree_palmBend.glb`, `flora/tree_palmTall.glb`, `flora/tree_palmDetailedShort.glb`, `flora/plant_bushLarge.glb` | tropical |
| `flora/tree_oak.glb`, `flora/tree_default.glb`, `flora/tree_detailed.glb`, `flora/tree_fat.glb`, `flora/plant_bush.glb` | temperate |
| `flora/tree_pineRoundA.glb`, `flora/tree_pineTallA_detailed.glb`, `flora/tree_pineDefaultA.glb`, `flora/tree_cone_dark.glb` | boreal / highland |
| `flora/tree_plateau.glb`, `flora/tree_thin.glb`, `flora/plant_bushTriangle.glb` | savanna |
| `flora/tree_default_fall.glb`, `flora/tree_simple_fall.glb`, `flora/tree_tall.glb` | east-asian garden |

## Building guide thumbnails (`catalog/`)

Renders of Agent City's own procedural geometry (no third-party models), captured from the browser
preview on 2026-10-07 and compressed to 360 px JPEG for the in-app 「建筑说明」 list. Project-owned; same
licence as the repository.

`catalog/session-tower.jpg`, `catalog/session-slab.jpg`, `catalog/session-deco.jpg`, `catalog/session-hotel.jpg`,
`catalog/district-landmark.jpg`, `catalog/twin-towers.jpg`, `catalog/villa.jpg`, `catalog/ferris-wheel.jpg`,
`catalog/sail-opera.jpg`, `catalog/suspension-bridge.jpg`, `catalog/truss-bridge.jpg`, `catalog/harbor.jpg`,
`catalog/beach.jpg`,
`catalog/civic-hall.jpg`, `catalog/station.jpg`, `catalog/stadium.jpg`, `catalog/observation-tower.jpg`, `catalog/park.jpg`, `catalog/expressway.jpg`, `catalog/lighthouse.jpg`, `catalog/twist-tower.jpg`, `catalog/tv-tower.jpg`, `catalog/arch.jpg`, `catalog/pagoda.jpg`, `catalog/signs.jpg`,
`catalog/hospital.jpg`, `catalog/school.jpg`, `catalog/mall.jpg`, `catalog/garden.jpg`,
`catalog/hero-tower.jpg`,
`catalog/airport.jpg`

## Mecha character models (`mecha/`)

All mecha character models and their `.manifest.json` files are original Agent City artwork (project-owned; same
licence as the repository). The `.blend` sources are kept outside the repository; the hashes in each manifest identify
the shipped GLB (and the source blend where applicable). None of these files contains third-party textures.

| File | Origin |
| --- | --- |
| `mecha/assault.glb` + `mecha/assault.manifest.json` | Assault mecha, modelled by hand in Blender 5.4. An AI-generated low-poly mesh (Tencent Hunyuan 3D Pro via the 胜算云 router, 2026-10-26) was used only as a proportion/detail reference inside Blender and is not part of the shipped file. Materials are an 8×1 colour palette plus one emissive accent material. |
| `mecha/gunner.glb` + `mecha/gunner.manifest.json` | Gunner, rebuilt from the Hunyuan 3D high model, retopologised/reduced and rigged in Blender; 2048 diffuse atlas baked from the high model, no third-party textures. |
| `mecha/support.glb` + `mecha/support.manifest.json` | Support, generated with Hunyuan 3D Pro, split per joint, repaired and rigged in Blender; 2048 atlas baked from the generated model's map. |
| `mecha/assault-trial.glb` + `mecha/assault-trial.manifest.json` | Experimental Assault trial candidate (restored left lower leg, forward punch); not validated for battle. |
| `mecha/assault-gait-preview.glb` + `mecha/assault-gait-preview.manifest.json` | Experimental shorter-step Assault preview; not approved for battle. Embedded textures were downscaled to 512 px WebP in 2026-10-30 to bring the preview under the city asset cap. |
| `mecha/assault-lift-preview.glb` + `mecha/assault-lift-preview.manifest.json` | Experimental high-detail alternating-foot-lift Assault preview; not approved for battle. |
