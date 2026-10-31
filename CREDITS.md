# Credits

## Car models

The ten teams race nine 2026 car models by **Dave Love SketchFab (@Tyler_Dave)**, each listed on Sketchfab
under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/):

| File | Model | Source |
|---|---|---|
| `js/assets/cars/sf26.js` | 2026 Ferrari SF-26 | https://sketchfab.com/3d-models/e5ca6cecdc42449283f4bed27360f2a7 |
| `js/assets/cars/w17.js` | 2026 Mercedes W17 | https://sketchfab.com/3d-models/b806f1e70aa343219e7158169549b97b |
| `js/assets/cars/mcl40.js` | 2026 McLaren MCL40 | https://sketchfab.com/3d-models/96214ad5624f42a0861f77008f8d29e7 |
| `js/assets/cars/rb22.js` | 2026 Redbull RB22 | https://sketchfab.com/3d-models/0a3d24a58e0549d591a5a48c22eec383 |
| `js/assets/cars/amr26.js` | 2026 Aston Martin AMR26 | https://sketchfab.com/3d-models/a50d1c7bc086455c9412470d93fc3fc7 |
| `js/assets/cars/r26.js` | 2026 Audi R26 | https://sketchfab.com/3d-models/32bf228264b047669b100b0f1b8769ac |
| `js/assets/cars/mac26.js` | 2026 Cadillac MAC-26 | https://sketchfab.com/3d-models/95bcd37aa7c649779efc33b90b6c023e |
| `js/assets/cars/vf26.js` | 2026 Haas VF-26 | https://sketchfab.com/3d-models/1f41e03886724bc6acd16c92402989bc |
| `js/assets/cars/fw48.js` | 2026 Williams FW48 | https://sketchfab.com/3d-models/4efa51e6d64a4192a83418f1b715c671 |

Changes made for this game (`tools/car_prep26.mjs`, packed into script files by `tools/car_pack.py`): re-axed and placed so each car's steering wheel sits at
the driver's hands, wheels and steering wheel split out so they turn, simplified into two levels of detail
plus a far mesh with baked colours, the models' race numbers removed (the game draws its own), and textures
resized and re-encoded as WebP. The models' own materials and textures are otherwise kept as made. One team
(Tessera) runs the FW48 with its colours turned in the shader.

The liveries carry the real teams' and sponsors' names and logos, which are trademarks of their owners; the
game is not affiliated with or endorsed by any of them. The source files' texture names suggest parts of
them came from earlier community mods, so check the provenance before any commercial use. The teams,
drivers and circuits in the game are fictional.

## Textures, skies and foliage (CC0, no attribution required, credited with thanks)

- Poly Haven (https://polyhaven.com): asphalt_track, asphalt_pit_lane, gravel_floor_02, concrete_wall_008,
  coast_sand_01, pavement_02, painted_concrete, metal_plate, painted_plaster_wall, the leaf and twig atlases
  of island_tree_01, tree_small_02 and fir_tree_01, and the HDR skies overcast_soil_puresky,
  citrus_orchard_road_puresky, kloofendal_48d_partly_cloudy_puresky, sunflowers_puresky and
  industrial_sunset_puresky.
- Poly Haven 3D models (CC0), baked into 8-view tree impostors by tools/assets_trees.py: island_tree_01,
  island_tree_02, tree_small_02, fir_sapling_medium and quiver_tree_01.
- ambientCG (https://ambientcg.com): Grass001, Rubber004, Facade001, Facade002, Facade006, CorrugatedSteel005 (venue buildings, via tools/assets_venue.py).

## Models

- Driver's arms and gloves: the MakeHuman base mesh with its default skeleton and skin weights
  (https://github.com/makehumancommunity/makehuman), CC0 1.0. The right arm is cut out, its fingers
  posed round a grip, and a suit sleeve and glove added by tools/assets_arm.py.

## Libraries

- three.js r158 (MIT), vendored in `js/vendor/`.

Titillium Web is licensed under the SIL Open Font License 1.1 (Accademia di Belle Arti di Urbino), bundled in assets/fonts for offline play.

- Driver suit and glove cloth relief: ambientCG Fabric066, Fabric061, Leather039 (CC0), https://ambientcg.com
