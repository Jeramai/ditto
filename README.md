# Ditto Baby

A local fan edit of [**jelly baby**](https://jelly.scottsun.io) by Scott Sun. The soft-body
jelly becomes Ditto, and the nursery floor becomes a Pokemon route.

## Run it

The page loads its assets from absolute `/assets/...` paths, so serve the folder from its root:

```bash
python3 -m http.server 8123
open http://127.0.0.1:8123/
```

It needs a WebGPU browser. Chrome and Edge work. Safari 18+ works.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | wander |
| `Space` | hop |
| drag | orbit the camera |
| drag on Ditto | grab and stretch |
| `R` | reset |

## What changed

The upstream site ships as a minified bundle. `original/` holds the four pristine text files.
`patch.py` re-applies every edit to them and writes the served copies, so an edit is one number
in one place. It asserts that each search string matches exactly once, and fails loudly instead
of half-patching.

### Ditto

- **The face.** Ditto has no eyebrows, no blush and no mouth interior, so all three meshes are
  gone — the interior read as an orange gash through the thin mouth line. Two small dot eyes
  replace the glossy domes. The mouth is a thin stroke of constant thickness, very nearly
  straight: `MOUTH_LIFT_AT` above about 0.02 starts to read as a grin. Every face material is
  matte.
- **The body and eyes are the 3D Ditto model.** `make_model.py` bakes the model's body mesh
  (`ditto2.glb`) into the soft-body asset, closes its mouth opening, and bakes the model's own
  eye meshes in; a per-vertex `faceTag` paints the eyes dark.
- **The physics cage is built from Ditto, not from the jelly.** `build_model_cage` grows the
  model's own hull by `CAGE_GROW` and fills it with a lattice of Kuhn tetrahedra (`CAGE_CELL`),
  so the cage has his arms. Reusing the jelly's smoothed cage left the arm tips outside every
  tet, and a grab there sheared them into a spike. Every surface vertex now binds inside a tet
  with convex weights, so no vertex is ever extrapolated. He is ~4 cm, w/h 1.31, d/w 0.75.
- **`?cage=1` draws the live cage** as a wireframe over Ditto, for diagnosing deformation.
- **The field is 2.5D.** `make_grass.py` writes the flat pixel sheet plus a single
  `grass_tuft.png`; `dittoGrass` scatters that sprite as upright quads that turn to the camera
  about their own vertical axis every frame (one shared vector is not enough -- sprites away
  from the axis then face slightly wrong and go edge-on). Tuft tiles on the sheet come from a
  tiling value-noise fbm, so the field clumps instead of repeating a small stamp.
- **Contacts cover every side.** The solver only keeps the vertices in the asset's `contacts`
  list above the floor, so the shipped bottom-band list let Ditto sink through the ground
  whenever he landed on his top. `make_model.py` now samples the whole surface on a 2.2 mm grid.
- **The field reacts.** Sprites within `TRAMPLE_OUT` of Ditto's centre squash to
  `TRAMPLE_LOW` of their height while the solver reports him grounded, and spring back when he
  hops or is lifted.
- **The loading card matches the field**: mint ground, a violet Ditto mark with dot eyes and a
  smile, and "A little copy."
- **The light.** The shipped scene is lit entirely by a nursery-room HDR, which is why an
  outdoor field came out flat and indoor-looking. `ENV_FILL` drops that to a fill, and a warm
  `DirectionalLight` plus a sky/ground `HemisphereLight` do the work. The sun points along
  `c.incoming`, the same direction the shadow renderer already projects along, so the lit side
  and the shadow agree.
- **The skin.** Transmission drops to zero and roughness rises, so the room in the environment
  map no longer reflects in him. Two forms replace the four jelly flavors: `ditto` and its shiny
  blue.

The surface is rebuilt from the cage every frame by barycentric interpolation, so moving cage
nodes moves the render mesh, the face, the shadow and the contacts with it. Each tet's rest
volume is rescaled by its own Jacobian ratio, which keeps the solver's material and mass
distribution correct. The sculpt throws rather than run on an inverted tetrahedron.

### The route

- `make_grass.py` builds `assets/grass_tiles.png` from the user's own 16x16 tall-grass sprite,
  extracted pixel-for-pixel (`tuft_grid.json`) from a clean nearest-neighbour source — every
  colour and cell verbatim. `LAYOUT` stamps it into clumps on the mint ground; open tiles get
  faint flecks. Earlier attempts hand-drew the motif because the first reference was a *blurred*
  upscale with no recoverable pixel grid (see `fit_tile.py`); the clean sprite made the copy exact.
- The floor samples the sheet with nearest filtering and no wood relief. The wood textures are
  deleted.
- The damp contact prints are gone from the floor shader. An opaque Ditto focuses no light, so
  the caustic patch under him is gone too. Only the drop shadow stays.
- The trampoline and the swing are no longer registered.
- The olive interface palette shifts to plum. The masthead credits the original.

### The easter egg

**Sound starts off. Turning it on starts the conga.** That is the whole trigger — the speaker
button in the top right, which works the same with a mouse or a thumb. After
[matias.me/nsfw](https://matias.me/nsfw/), which is not what its URL suggests, only a dancing
Ditto and a Gloria Estefan track.

`R`, `Escape`, the reset button and typing `conga` all route through that same button rather
than touching the dance directly, so the sound state and the dance state are one thing and can
never disagree. `wL.muted` starts `true` and the markup starts pressed and `.muted`, so the
icon matches on the first paint.

The dance drives `rig.move` and `rig.jump()`, so it runs through the same soft body as the
keyboard does. The direction snaps a quarter turn on each beat and drifts slowly, so he changes
direction *on* the beat instead of gliding. It also forces the laughing face, which stretches
the smile. The hop clock reads `audio.currentTime`, so the beat holds if a frame drops.

`CONGA_BEAT` and `CONGA_OFFSET` are measured, not guessed: 122.4 BPM and a first downbeat at
0.380 s, from an onset-flux autocorrelation over the decoded track.

### The favicon

`make_favicon.py` carries the original 132x29 four-frame sprite strip from matias.me/nsfw
inline as base64, decodes it — a 2-bit paletted PNG, so inflate, unfilter, then unpack the
indices — and writes each 33x29 pose padded square as RGBA. `patch.py` inlines those as data
URLs. The tab cycles one frame per quarter beat, so the icon sways in time with the track, and
idles while the tab is hidden.

Chrome ignores an animated GIF icon and caches an `href` it has already seen, so each frame goes
in as a fresh `<link>` element rather than a mutated one.

## Re-apply after an edit

```bash
python3 make_grass.py --preview     # the tilesheet, plus previews to look at
python3 make_favicon.py --preview   # the favicon frames, plus a strip to look at
python3 make_shape.py               # shape_table.json, the cage morph field, from the model
python3 make_model.py               # assets/ditto-model.bin + ditto-model.json, the baked body
python3 patch.py                    # rebuilds index.html and the three asset files
```

`shape_table.json`, `ditto-model.bin` and `ditto-model.json` are checked in, so the two model
scripts only need the archive in `~/Downloads` when re-deriving.

`SCALE` is the only size knob for Ditto. Every face measurement is a ratio of the body, so the
the eyes and the mouth move with it.

## Known limits

The shipped startup runs 80 warm-up substeps. A half-scale body is relatively stiffer, so it can
still be bouncing when they run out, fall asleep mid-bounce and freeze there — he loads as a
smooth egg until you nudge him. `SETTLE_STEPS` raises the count.

The engine spatial-hashes face triangles only inside a fixed window, sized for the original
7.5 cm jelly. A 5 cm Ditto sits lower, so `FACE_WINDOW_X` and `FACE_WINDOW_Y` widen it. Without
that, a wide expression samples outside the index and the solver throws
`Animated facial detail outside the jelly surface`.

**Closing the mouth cutout.** The game mesh has the mouth cut out of the body (a 24-edge hole)
and covers it with a separate, recessed mouth mesh. Baked alone that reads as a gaping cavity —
the "giant hole." Reconstructing it fought the surrounding curvature for many tries; what finally
worked is a direct geometric dome: ear-clip the loop, then push the cap outward along the loop's
normal into a paraboloid tapering to zero at the rim, so it bulges flush and convex. Out-of-cage
vertices (the pointy arm tips) are clamped to convex tet weights so the grab-consistency check
holds; every vertex reconstructs to 0 um and grabbing the arms no longer glitches.

The height-slice cage morph is still how the cage itself is shaped to Ditto (`shape_table.json`),
and the `dittoSculpt` morph-only path remains in git history if a smooth, seamless — but
bump-free — Ditto is ever wanted instead.

**Why the cage morph is by height slices **Why the cage morph is by height slices **Why the cage morph is by height slices **Why the cage morph is by height slices and not a radius field from a point.** A radial field
has a blind spot at the poles: one ratio per direction cannot widen a narrow spire into a flat
plateau, and the model's top is a plateau. Slices have no such blind spot, and because heights
map one-to-one the flat base stays flat. The model is also genuinely asymmetric — its top runs
0.98 of its height on one side and 0.79 on the other — and `SYMMETRY` in `make_shape.py` mirrors
part of that away (0 faithful, 1 symmetric, sits at 0.7). Since the render mesh is now the model
itself, this only shapes the cage the mesh is bound to.

Two more things about the field matter more than they look:

- **How it is smoothed.** Repeated box passes rounded the side nubs and the wavy top clean off.
  A single Gaussian kills the per-bin sampling noise, and it only needs to be wide enough to do
  that: the runtime samples with Catmull-Rom, which is already C1, so the blur is not what keeps
  the surface smooth. `SMOOTH_SIGMA = 2.0` flattened his nubs and wavy top; 1.0 keeps them.
- **How it is sampled.** Bilinear leaves the slope discontinuous at every bin edge, and the
  shading turns each one into a visible crease, which made him look faceted. Both
  `make_shape.py` and the runtime use Catmull-Rom, which is C1. The two samplers are written to
  match, so the verification numbers describe what actually renders.

`SX/SY/SZ` then correct the residual and land him on the model's own proportions.

`MORPH` blends between the two: 0 is the original jelly, 1 is the measured Ditto.

## Credit and licence

The world, the soft-body solver, the art and the audio are Scott Sun's work, copied here
unmodified except where listed above. Ditto is a Pokemon owned by Nintendo, Creatures Inc. and
Game Freak. `assets/konga.mp3` is "Conga" by Gloria Estefan and Miami Sound Machine, taken from
matias.me/nsfw, and the favicon sprite strip comes from the same page. `shape_table.json` is
derived from a rip of the Pokemon X/Y Ditto model. None of that is licensed to anybody here. This is a
personal, non-commercial fan edit. It is live at
<https://jeramai.github.io/ditto/>.

The three wood floor textures are deleted, because the grass floor never loads them. To put the
nursery floor back, drop the floor pairs from `patch.py` and fetch them again:

```bash
for f in wood_base-BnLq3mVl.jpg wood_normal-pCUsk1GY.png wood_roughness-a0mBSnc7.jpg; do
  curl -sL -o "assets/$f" "https://jelly.scottsun.io/assets/$f"
done
```

## Building

```
python3 make_grass.py     # ground sheet, tuft sprite, grass_layout.json
python3 make_favicon.py   # the four dancing-Ditto favicon frames
python3 make_sky.py       # assets/sky.exr (258 KB, replaces the 5.9 MB room HDR)
python3 make_audio.py     # trims the conga loop from 4 MB to 491 KB
python3 make_shape.py     # shape_table.json (model frame + radius field)
python3 make_model.py     # assets/ditto-model.bin (+ .json)
python3 patch.py          # index.html, index-*.js, index-*.css, runtime-*.js
python3 make_site.py      # dist/ : only the files the page fetches
```

## Deploying to jeramai.github.io/ditto

The site is the engine now, not the patched build. Every served path is
relative, so `dist/` works at any base path; verified by serving it under
`/ditto/`.

1. `cd engine && npx vite build`
2. Push the contents of `engine/dist/` to the `ditto` repo, plus `.nojekyll`
   (Pages: deploy from branch, root).
3. It lands at `https://jeramai.github.io/ditto/`.

`engine/dist/` is 3.6 MB. Ditto's own bundle is 620 KB; the rest is the model
(1.2 MB), the conga (491 KB), the social image (187 KB), the grass sheet
(84 KB) and the sky probe (46 KB).

`patch.py` and `make_site.py` still build the old patched site from
`original/`, and nothing deployed depends on them any more.

## Credits

Ditto is a Pokemon, owned by Nintendo, Creatures and Game Freak. The dancing
sprite and the idea of setting it to a conga come from
[matias.me/nsfw](https://matias.me/nsfw/), and the track is "Conga" by Gloria
Estefan and Miami Sound Machine.
