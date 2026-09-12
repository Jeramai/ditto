# Ditto

A soft-body Ditto in a Pokemon route, on three.js and WebGPU. Live at
<https://jeramai.github.io/ditto/>.

It began as a fan edit of [**jelly baby**](https://jelly.scottsun.io) by Scott Sun, patched over
the shipped bundle. None of that survives. The app is `engine/`, written from scratch, and what
is left here are the Python bakes that derive its assets.

## Layout

| | |
| --- | --- |
| `engine/` | the app: solver, skinning, world, interface. `engine/README.md` covers it. |
| `make_*.py` | the bakes. Every one writes straight into `engine/public/`. |
| `original/` | the three upstream files the bakes read, and nothing else |
| `ditto2.glb`, `ditto-skin.png`, `shape_table.json` | model sources, checked in |
| `build/` | bake intermediates, ignored |

## Run it

```bash
cd engine
npm install
npx vite            # http://localhost:5173
```

Needs WebGPU. Chrome, Edge and Safari 18+ work. Controls and query flags are in
`engine/README.md`.

## Re-bake after an edit

```bash
python3 make_grass.py --preview     # the tilesheet and the tuft sprite, plus previews
python3 make_favicon.py --preview   # the four favicon frames, plus a strip
python3 make_shape.py               # shape_table.json, the cage morph field
python3 make_model.py               # the baked body: ditto-model.bin and ditto-model.json
python3 make_sky.py                 # the daylight probe
python3 make_star.py                # the sparkle the transform throws
python3 make_audio.py               # the track, trimmed to whole beats
```

All seven write into `engine/public/`, and re-running them reproduces it byte for byte. The two
model scripts need the model archive in `~/Downloads` only when re-deriving; `shape_table.json`
and the baked model are checked in.

`SCALE` in `make_model.py` is the only size knob for Ditto. Every face measurement is a ratio of
the body, so the eyes and the mouth move with it.

## The body

- **The mesh is the 3D Ditto model.** `make_model.py` bakes the body mesh from `ditto2.glb`,
  closes its mouth opening and bakes the model's own eye meshes in. A per-vertex `faceTag` paints
  the eyes and `mouthTag` carries the tongue and lip colours, so the runtime samples no texture.
  He is ~4 cm, w/h 1.31, d/w 0.75.
- **The physics cage is built from Ditto, not from the jelly.** `build_model_cage` grows the
  model's own hull by `CAGE_GROW` and fills it with a lattice of Kuhn tetrahedra (`CAGE_CELL`), so
  the cage has his arms. The jelly's smoothed cage left the arm tips outside every tet, and a grab
  there sheared them into a spike. Every surface vertex binds inside a tet with convex weights, so
  no vertex is ever extrapolated.
- **Contacts cover every side.** The solver only keeps the listed vertices that are above the
  floor, so the shipped bottom-band list let him sink through the ground whenever he landed on his
  top. The whole surface is sampled on a 2.2 mm grid: 1,600 candidates.

**Closing the mouth cutout.** The game mesh has the mouth cut out of the body — a 24-edge hole —
and covers it with a separate recessed mouth mesh. Baked alone that reads as a gaping cavity.
What works is a direct geometric dome: ear-clip the loop, then push the cap outward along the
loop's normal into a paraboloid tapering to zero at the rim, so it bulges flush and convex.
Out-of-cage vertices — the pointy arm tips — are clamped to convex tet weights so the
grab-consistency check holds. Every vertex reconstructs to 0 um.

**Why the cage morph is by height slices and not a radius field from a point.** A radial field has
a blind spot at the poles: one ratio per direction cannot widen a narrow spire into a flat
plateau, and the model's top is a plateau. Slices have no such blind spot, and because heights map
one to one the flat base stays flat. The model is also genuinely asymmetric — its top runs 0.98 of
its height on one side and 0.79 on the other — and `SYMMETRY` in `make_shape.py` mirrors part of
that away (0 faithful, 1 symmetric, sits at 0.7).

Two more things about that field matter more than they look:

- **How it is smoothed.** Repeated box passes rounded the side nubs and the wavy top clean off. A
  single Gaussian kills the per-bin sampling noise, and it only needs to be wide enough to do
  that: the runtime samples with Catmull-Rom, which is already C1, so the blur is not what keeps
  the surface smooth. `SMOOTH_SIGMA = 2.0` flattened his nubs and wavy top; 1.0 keeps them.
- **How it is sampled.** Bilinear leaves the slope discontinuous at every bin edge, and the
  shading turns each one into a visible crease, which made him look faceted. Both `make_shape.py`
  and the runtime use Catmull-Rom. The two samplers are written to match, so the verification
  numbers describe what actually renders.

`SX/SY/SZ` then correct the residual and land him on the model's own proportions.

## The route

`make_grass.py` builds the tilesheet from a 16x16 tall-grass sprite, extracted pixel for pixel
from a clean nearest-neighbour source — every colour and cell verbatim. `LAYOUT` stamps it into
clumps on the mint ground; open tiles get faint flecks. Tuft tiles come from a tiling value-noise
fbm, so the field clumps instead of repeating a small stamp. Earlier attempts hand-drew the motif,
because the first reference was a *blurred* upscale with no recoverable pixel grid; the clean
sprite made the copy exact.

The sheet ships as lossless webp. The intermediate PNGs go to `build/`, because only the webp is
published.

## The easter egg

**Sound starts off. Turning it on starts the conga.** That is the whole trigger — the speaker
button in the top right, which works the same with a mouse or a thumb. After
[matias.me/nsfw](https://matias.me/nsfw/), which is not what its URL suggests: a dancing Ditto, a
Gloria Estefan track, and a room that flashes a new colour on every beat.

`R`, `Escape`, the reset button and typing `conga` all route through that same button rather than
touching the dance directly, so the sound state and the dance state are one thing and can never
disagree.

`engine/README.md` has the rest: how the flash is built, why it runs on the measured beat rather
than the original's fixed 0.4 s timer, and why he turns to face you by pressing his own S key.

## The favicon

`make_favicon.py` carries the original 132x29 four-frame sprite strip from matias.me/nsfw inline
as base64, decodes it — a 2-bit paletted PNG, so inflate, unfilter, then unpack the indices — and
writes each 33x29 pose padded square as RGBA. The tab cycles one frame per quarter beat, so the
icon sways in time with the track, and idles while the tab is hidden.

## Credit and licence

The soft-body idea, the world, the art direction and the audio are Scott Sun's work. Ditto is a
Pokemon owned by Nintendo, Creatures Inc. and Game Freak. `konga.mp3` is "Conga" by Gloria Estefan
and Miami Sound Machine, taken from matias.me/nsfw, and the favicon sprite strip comes from the
same page. `shape_table.json` is derived from a rip of the Pokemon X/Y Ditto model. None of that
is licensed to anybody here. This is a personal, non-commercial fan edit.
