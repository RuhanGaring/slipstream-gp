# Elevation and city circuits: plan

Status: stage 1 (generator and Track Lab) is built and under review. Nothing in the game has
changed yet; the game still uses `js/trackgen.js`.

## What was wrong before

Every circuit's height came from four sine waves of a few metres (22 m at most, at Sierra),
smoothed once. Nothing limited the gradient, nothing checked crests or dips at racing speed, and
the ground beside the track was the same sine field blended toward the road, so cuttings and
embankments never formed. Generated street circuits were the same star-shaped outlines as the
park circuits, only tighter.

## The new generator (`js/trackgen2.js`)

Four styles: **city** (a harbour town on a hill, after Monaco), **park**, **mountain** and
**modern**. Every candidate goes through the same five steps.

1. **Site.** A natural height field from the seed.
   - City: sea below a wavy coastline, then a hill rising 45 to 85 m inland, with terraced noise.
   - Mountain: a valley side that tilts across the whole site, with ridges and gullies.
   - Park: rolling fractal hills.
   - Modern: a near-flat plain.
2. **Layout.**
   - Open styles reuse the first generator's outlines.
   - City circuits are traced through a warped street grid. Row streets follow the hill's
     contours and cross streets climb it.
   - The lap is the outline of a random connected set of city blocks with no holes and no
     corner-only contacts. That outline is always a single simple loop, so a city lap cannot
     cross itself by construction.
   - Narrow terrace strips between two streets give hairpins.
   - Long straights get chicanes, as at the harbour and swimming pool.
   - A gentle covered stretch becomes a tunnel.
   - The longest straight becomes the start straight, with the pit lane on whichever side is
     clear.
3. **Grading.** The road is graded the way a real one is.
   - The height field is sampled around the lap and smoothed.
   - The road is then held to a gradient limit, which is lower through corners, through
     hairpins and on the grid and pit lane.
   - The limit is an exact projection around the loop (the mean of the tightest upper and lower
     envelopes), so it always holds and the lap always closes.
   - The road is smoothed further until no crest unloads the car below 0.3 g and no dip loads
     it above 3 g, at the speed a car would carry there.
   - Banking leans into corners, and the hillside's own camber adds off-camber corners where the
     hill falls away. Banking is capped at 6 %.
4. **Ground.** The ground is cut and filled to meet the road.
   - From just past the barriers, banks rise or fall at a fixed slope to the natural ground.
   - The banks are computed from every stretch of road within reach at once, so the ground is
     continuous everywhere.
   - Where two stretches pass close at different heights, their banks meet. In a city that is a
     retaining wall (a terrace). On a mountain a few short rock faces are allowed. Elsewhere the
     candidate is rejected.
5. **Verification.** `verify()` re-checks the finished circuit without trusting how it was
   made. Only a circuit that passes every check is returned. If it fails, the next candidate
   from the same seed is tried, so a seed always gives the same circuit.

| Style | Width | Lap | Grade limit (straight / corner / hairpin / grid) | Climb (from the real envelope) |
|---|---|---|---|---|
| City | 10 to 11 m | 3.0 to 4.3 km | 14 / 9 / 5.5 / 3 % | 27 to 47 m |
| Park | 14 to 15 m | 4.3 to 5.8 km | 11 / 8 / 5 / 2 % | 3 to 43 m |
| Mountain | 13 to 14 m | 4.3 to 6.2 km | 17 / 12 / 6 / 2.5 % | 36 to 117 m |
| Modern | 15 m | 4.4 to 5.9 km | 11 / 8 / 5 / 1.5 % | 4 to 45 m |

### The checks

- Finite geometry and profile.
- Lap length.
- No corner tighter than 9 m (city) or 10 m.
- No kinks in the curvature.
- Clearance between unrelated parts of the lap: at least 19 m in a city (walls between),
  58 to 62 m elsewhere.
- A straight start line and grid.
- A clear pit lane.
- At least one overtaking straight.
- Corner count and variety.
- Gradients within the local limit everywhere.
- Realism: climb, steepest 100 m, steep share, ascent per metre of climb, separate climbs and
  sharpest crest inside the envelope of the real circuits of its kind.
- The lap closes in height.
- Crest and dip loads at racing speed.
- Banking within limits.
- Banks meet the road with no unplanned walls.
- No step where the banks end.
- City only: road on land and above the sea, every building clear of the road, a town of at
  least 20 buildings, the tunnel away from the pit lane, and at least one hairpin.

`node tools/gen2batch.js N` builds N seeds per style. It re-verifies every result in a fresh
pass and checks that the same seed rebuilds the same circuit. It exits non-zero on any failure.

## Calibration to real F1 circuits

The terrain and the realism check come from measured data, not guesses.

- **Source.** The centrelines of 40 F1 circuits, past and present (`bacinger/f1-circuits`, MIT),
  were sampled every 5 m against open elevation data (AWS Terrain Tiles at zoom 14, about 6 to
  10 m per pixel) by `tools/f1elev_prep.py`.
- **Cleaning.** Buildings and tree canopy that the surface model still carries are removed with
  a 100 m morphological opening, then the profile is smoothed over 30 m.
- **Statistics per circuit:** climb, ascent per lap, steepest 100 m and 200 m, share of the lap
  steeper than 2, 4, 6 and 8 %, separate climbs, gradient in corners and on straights, sharpest
  crest and dip, and big-feature against small-undulation spread. They are written to
  `tools/data/f1_elevation.json` and `lab/f1ref.js`.
- **Checked against published figures:** Spa 105 m with 18 % at its steepest, the Red Bull Ring
  63 m, Suzuka 43 m, Interlagos 43 m, Silverstone 12 m, Zandvoort 5 m.
- **Left out of the envelopes:** Singapore, Mexico City and Buenos Aires, whose profiles are
  dominated by buildings or stands in the data. Monaco uses its published 42 m climb, because
  the data reads its tunnel at the hotel roof.
- **What the measurements showed.** Real circuits are mostly even ground with one or two big
  landforms, plus 1 to 4 m of small undulation. Open sites are therefore built from a gentle
  tilt, small undulation and one or two placed landforms (hill, hollow, escarpment, valley),
  sized per style.
- **Envelopes.** `tools/f1elev_fit.py` fits each style's envelope from its real group and writes
  it into `js/trackgen2.js`:
  - City: Monaco, Baku, Madring.
  - Park: permanent circuits under 40 m of climb.
  - Mountain: permanent circuits of 40 m or more.
  - Modern: the purpose-built venues.
- **The realism check.** Every generated lap is measured exactly the same way and must fall
  inside its style's envelope. Track Lab shows the comparison and the most similar real
  circuit's profile.

## Track Lab (`lab/trackgen.html`)

A standalone page that loads the game's own track modules.

- Pick a style and a seed, or press RANDOM. The arrow keys step through seeds.
- The 3D view shows the cut-and-filled ground, the road with kerbs, run-off and barriers, the
  pit lane, the town, the harbour and the tunnel. Height can be exaggerated 1x, 2x or 3x.
- The road can be coloured by gradient.
- The elevation profile is coloured by gradient. Hovering it marks the spot in 3D.
- The plan view is coloured by height.
- Stats: length, corners, climb, maximum grade, tightest corner, crest and dip loads, closest
  pass, tries and time.
- The full check list is re-run in the page.
- DRIVE A LAP rides the lap at the speed profile's pace, with speed, gradient and height shown.
- BATCH TEST runs many seeds per style in the page.

## Stage 2: into the game (after approval)

1. `Tracks.build` accepts a definition carrying the new profile: `trackgen2` regenerates it
   from the seed, as `trackgen` does now, so the learning workers rebuild the same circuit.
   `tr.z`, `tr.dz`, `tr.ddz` and `tr.bank` keep their names, so physics, AI and the renderer
   read the new profile unchanged. `groundAt` uses the cut-and-fill ground.
2. Physics check on steep road: gravity along the slope, load change over crests and through
   dips, and the AI's braking on downhill approaches. Run `tools/simrace.js` and the learning
   on hilly circuits and compare lap times and incidents with flat ones.
3. Renderer:
   - Terrain mesh from the cut-and-fill ground.
   - Retaining walls drawn where banks meet.
   - The city drawn from the generator's blocks: facades, the harbour with boats, Armco and
     catch fences on concrete walls, and the tunnel with lighting.
4. Procedural Circuit screen: a style choice (City, Park, Mountain, Modern) next to the seed.
   AI learning runs per map, as it does now.
5. New calendar circuits built with the system: a Monaco-like harbour circuit and a mountain
   circuit, picked from seeds approved in the Track Lab and given names and skies. Their
   racing lines and limits are learned with `tools/learnpar.js`.
6. Later, optional: grade-separated crossings (a bridge, as at Suzuka). The grading would then
   enforce at least 7 m between the levels, and the checks would cover the crossing.
