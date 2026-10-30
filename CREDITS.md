# Credits

## Car model

"Aston Martin F1 AMR23 2023" by **Redgrund**
(https://sketchfab.com/3d-models/aston-martin-f1-amr23-2023-f6ba825a43b146a9b669934a4e1fd529),
licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Obtained via https://github.com/Ron2509/Ron2509.github.io (`public/models/car.glb`), where the textures had
already been removed and the parts split.

Changes made for this game (`tools/car_prep.mjs`): rescaled to the game's car and re-axed, simplified into
two levels of detail, tyres split from rims with generated sidewall UVs, materials reassigned, and every
livery painted in code in the game's fictional team colours. No original logos or sponsor marks are used.
The teams, drivers and circuits in the game are fictional.

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
