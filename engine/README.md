# Ditto, our own engine

This is the site at [jeramai.github.io/ditto](https://jeramai.github.io/ditto/): our own app layer
on three.js (MIT), with our own soft-body solver, skinning, world and interface. Nothing here is
patched into anything. It replaced a patch over someone else's bundle, and none of that is left.

```bash
cd engine
npm install
npx vite            # http://localhost:5173
npx vite build      # writes dist/
```

Needs WebGPU. Chrome, Edge and Safari 18+ work.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | wander |
| `Space` | jumps at once while walking; standing still, hold it to squish and jump higher |
| drag the field | orbit (pitch is clamped, see below) |
| drag Ditto | grab and stretch |
| `R` | put him back |
| type `conga` | you'll see |
| `Esc` | stop the music |

On a touch device a stick and a hop button appear instead.

### Query flags

| Flag | Effect |
| --- | --- |
| `?hud=1` | the frame and solver readout |
| `?shiny` | force the shiny form |
| `?gpu=bench` | run the compute-solver A/B in the console |
| `?shear=` `?bulk=` `?gravity=` `?grabRadius=` | override one material constant |

## How it fits together

| File | What it owns |
| --- | --- |
| `softbody.js` | the XPBD solver: neo-Hookean pair, contacts, friction, grab, righting, viscosity |
| `skin.js` | 8,194 surface vertices from four barycentric weights each, normals from the deformed triangles |
| `colour.js` | graph colouring of the tets, so a parallel sweep is conflict free |
| `gpu.js` | the elastic solve as one WebGPU dispatch. Not wired in — see the note in the file |
| `world.js` | sky probe, tiled ground, camera-facing tufts, the trampled trail |
| `locomotion.js` | the rig: a posture spring, an animated gait, a servo onto a target speed |
| `conga.js` | the sprite's bounce, the alternating arm wave, the turn to camera |
| `disco.js` | the beat-driven colour flash, the tint on the lights, the parade of sprites |
| `breath.js` | the idle rise and fall |
| `audio.js` | the track, the beat, the favicon spin |
| `sprite.js` | the four pixel frames in both forms, for the parade and for the tab |
| `ui.js` | name, form, sound, reset, credits, the entrance, the touch pad |

The asset comes from `../make_model.py`, which writes straight into `public/`: 728 cage nodes,
2,832 tets, 8,194 surface vertices,
1,600 contact candidates, plus `faceTag` for the eyes and `mouthTag` for the mouth. The sky
comes from `../make_sky.py` and the field from `../make_grass.py`.

## Two things worth knowing before you edit

**The skin texture is not a picture.** It is a 64×64 colour-ID table: one texel per triangle,
four flat colours, nearest filtered. glTF puts v = 0 at the top, so sampling it with `1 - v`
swaps the lip and the tongue exactly, because the dark red sits on rows 0–3 and the pink on
59–61. `make_model.py` resolves the colour per face and bakes it per vertex, so the runtime
samples no texture at all.

**Friction and the gait are one setting.** The rig drives him with a servo onto a target speed,
and that servo's peak output is `speed × drive` = 6.96 m/s². Static friction costs `μ × g`, so at
μ = 0.65 the servo barely clears the threshold and he creeps at 18 mm/s. Winding the gain up
instead makes the friction constraint shear his base until an element inverts — a reversal
measured a Jacobian of −0.82. μ = 0.16 lets the rig run at its designed gain: 73 mm/s, and the
worst Jacobian under load is the same 0.31 he shows at rest. Change one and re-measure the other.

**He turns to the camera by pressing his own S key.** The rig already owns a world heading, and
already eases it onto the direction of travel whenever `move > 0.01` — but only then, so there is
no way to aim him while he stands still. `rig.press(0, 1, seconds)` adds into `ix/iz` exactly where
a held key does, so the dance taps S for `turn` and the existing, already-tuned branch brings him
round. No new heading API, and no aiming the posture spring directly at 20× conga stiffness. He
does not travel, because the dance's own home spot cancels the walk: 0.1 mm of drift through a
full 180°.

**The press length is free. The turn rate is not.** A press long enough to close a half turn at
`turnRate` 10 is 0.55 s, and the gait fades over another 0.25 s at 12/s on top — nearly a second,
which reads as a walk rather than a tap. The press therefore carries its own rate, and that rate
is the one dangerous number in this feature. Measured on a 180° turn, worst Jacobian against 0.632
at rest:

| rate | 14 | 20 | 26 | 30 | 38 | 46 | 92 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| worst J | 0.47 | 0.50 | **0.39** | 0.33 | 0.16 | −0.06 | −0.84 |

Past about 30 it inverts tetrahedra — −0.84 is the same failure `locomotion.js` opens by naming.
Duration does not appear in that table: 0.05 s and 0.55 s both measure 0.39 at rate 26, because
the peak angular speed is `angle × rate` and the length only decides how much of the angle is
spent.

So the tap and the turn are separated. `press` takes a gait length and a longer heading length:
`turn` is 0.05 s of S, short enough to read as a tap, and for `turnHold` 0.35 s after that the
heading alone keeps easing at the same safe rate 26, with the gait already fading and no drive on
him. A full 180° lands to 0.0°, inside 3° in 100 ms, on 0.1 mm of drift, worst Jacobian 0.441.
Closing the same turn inside the 0.05 s tap would need rate 92, which is the −0.84 column.

**A crowd sprite can roll shiny.** The strip is four flat colours and the body is a single
`#b860e0`, so one pass over the decoded pixels swaps it for the shiny form's blue and leaves the
outline and the highlight alone — 391 body pixels change and the 86 outline and 7 highlight ones
do not. No second asset. It is rolled per sprite at `shinyOdds`, 64, not the real 4096, which at
two spawns a second would show one about every 32 s of dancing instead of never. The roll is
independent of the player's own form, so the parade is ordinary Dittos with a rare one among them.

**The tab follows your form, and stops re-fetching a png.** `sprite.js` bakes all eight frames
once and hands out a canvas for the parade and a data URL for the `<link>`, so `audio.js` and
`disco.js` share one copy instead of keeping their own. The icon is the shiny blue whenever the
body is, switching on the form button, and the parade's rare shiny is rolled separately. The old
code pointed the link back at `favicon-<n>.png`, which Chrome re-requested every 124 ms — eight
times a second for as long as the music played. There is no fallback to those files: before they
decode the markup's icon is already correct, and asking again is a request for nothing.

**The disco's blend has to sit on the fixed element itself.** `position: fixed` makes an isolated
group, so a `mix-blend-mode` on a child of a fixed wrapper blends against transparency and the
canvas below never takes part — three different modes produced byte-identical screenshots. `#disco`
is therefore the fixed, blended, coloured element, and `#crowd` is a separate fixed canvas after it
in the markup. The flood is capped at `ceiling` 0.55: at full strength a saturated panel colour
erased the field and Ditto with it, and one random colour in eight has no channel above half.
`prefers-reduced-motion: reduce` turns the flash and the parade off and leaves the dance and the
music running.

**The original is worth reading before changing any of this.** matias.me/nsfw swaps two random hex
colours on a fixed 0.4 s timer, which drifts against its own track, and animates its sprite at
0.085 s a frame. Everything here runs off `audio.currentTime` on the measured 0.4902 s beat
instead, the rule `conga.js` and `audio.js` already follow, so the flash lands with his bounce. Its
`color()` also returns 5-digit strings about 6% of the time, which the browser rejects and which
holds the previous colour; that is not copied.

**The camera's pitch floor is geometry, not taste.** The half fov is 0.314 rad, so the top of the
frame looks (pitch − 0.314) below horizontal and lands `height / tan(that)` away: 5.1 m at pitch
0.34, past the fog, which reads as a pale empty band. 0.42 puts it at 1.5 m. The start pitch of
0.52 sees 0.9 m, and the start yaw is 0 so the entrance's pixel sprite hands over to the model in
the same pose and place — the sprite box is sized to match, so changing the framing means
re-measuring it.

**The drag plane has to be re-anchored every move.** It is camera-parallel, and the camera
follows him, so fixing the plane at grab time means a given pixel maps to a steadily shifting
world point: a slow steady drag slid him 38 px out from under the cursor. Re-anchoring each move
at his current depth holds it to 0.7 px, and the camera no longer follows him while he is held.

**Anything sized around him has to travel with him.** This caught us three times. The mesh's
bounding sphere is only rebuilt for the raycast, so it culled him mid-screen. The sun's 24 cm
shadow camera cut his shadow off at the edge of its box. And the 6 m ground plane stayed at the
origin, so at 84 mm/s he walked off the edge of the world in about half a minute and stood in the
void with the tuft sprites hovering round him. The mesh no longer frustum-culls, and
`world.follow` moves the light, its target and the ground.

The ground snaps to whole multiples of the sheet's 2.56 m repeat rather than tracking him
smoothly: one period leaves the pattern exactly where it was in world space, so the painted
rosettes stay under the sprites with no UV correction and nothing swims. Worst case he sits
1.28 m off the plane centre against a 3 m half span.

**Nothing may allocate in the frame loop.** Two things did, for nothing: the debug object was a
fresh nineteen-property literal 120 times a second, and the HUD string was assembled even though
the readout is hidden unless `?hud=1`. Idle GC churn is a 12.1 MB sawtooth now against the old
build's 15.3 MB. Steady heap is 25.1 MB against its 16.1 MB, and that difference is not in our
data -- the model arrays are 1.2 MB and the optical stubs 0.2 KiB -- it is three.js node
materials and the PMREM environment, which is 13 textures for a three-mesh scene.

**The posture spring runs on the substep, and its damping needs a live mean.** Two traps, both of
which broke the crouch outright. Integrated on the frame, `k·dt²` is 2.7 at 120 Hz and 44 at 30 Hz,
past the explicit-integration limit, so the spring overshot and *inverted* the crouch — holding
jump made him 4 mm taller and sank him 4 mm into the floor, and it got worse as the frame rate
dropped. On the 1/720 substep the same spring sits at 0.075. Then the damping term has to measure
deviation from the **current** mass-weighted mean velocity, recomputed each substep: against a
stale one, a jump impulse looks like internal motion and gets eaten at −12 m/s², which cancelled
the jump completely. Damping internal motion while leaving rigid motion free is the entire job of
that term, and a stale mean breaks the invariant.

**Charging is only for standing still.** On the move, Space fires immediately: a crouch mid-stride
reads as a stumble, and it was also what let him power-walk. The 22× charge spring does not only
hold the crouch, it drives the gait's 9 mm foot swing that much harder, which doubled him to
161 mm/s as a pancake. `chargeBrake` is the backstop for a charge that starts and then walks.
Walking jump 15 mm, standing tap 22 mm, full charge 84 mm.

**Winding up slides him.** The charge spring is 22× stiff, and reaching new targets against a
0.16 friction floor slid him 13.75 mm over a second and a half. Softening the spring fixes the
slide and ruins the charge, so `locomotion.js` holds his ground instead — a position correction,
like the conga's, and only while he is not being asked to walk. 0.55 mm now, and he still travels
226 mm if you hold a direction at the same time.

**Squishing him past about 28% of his height stops helping.** The charge jump poses a crouch and
launches with an impulse scaled by it, and past that depth the compression loses more energy into
the material than the impulse puts back: 0.32 commanded reached an apex of *zero*. `crouch` and
`jumpGain` move together, and the apex is the only thing that tells you whether they still agree.

**A squash on a floor always moves him.** The contact answers the downward half of the cycle and
not the upward one, so every bounce leaves a net impulse — 6 mm over 5 s. `conga.js` cancels it by
correcting his *position*, not his velocity: a velocity nudge lands once a frame while the contact
regenerates the drift across every substep, and it never caught up.

**∂det(F)/∂F is the cofactor matrix, row-major like F.** Writing the cross products in as
columns transposes it, and a transposed gradient is not rotation invariant, so every volume
solve eats angular momentum. The test is the identity Σ p × ∇C = 0.

**`positionLocal` reads zero in a fragment node.** It is a vertex-stage variable, so a fragment
expression built on it compiles and runs and silently uses 0. The form sweep looked like an
instant snap because of it. Use `positionWorld`, which is a real varying, for anything the
fragment stage has to know about where a vertex is.

**The tuft field writes depth, so an effect sprite standing in it needs none.** A depth-tested
sparkle at his own height spends most of its life inside a grass billboard. `transform.js` turns
the depth test off and takes `renderOrder` 10, the way the entrance draws its stars over the
sprite.

**A 16-bit vertex attribute costs more memory than a 32-bit one.** `WebGPUAttributeUtils`
in three r169 rewrites every non-normalized `Uint16Array` attribute into a fresh `Uint32Array`
on upload, and assigns it back over `attribute.array`. So a narrow index ships 92 KB smaller and
then pays 185 KB for the copy, on top of the slice still sitting in the model buffer. Narrow
whatever the solver reads on the CPU; leave anything that reaches the GPU at 32 bits.

## Credits

Ditto is a Pokémon, owned by Nintendo, Creatures and Game Freak. The dancing sprite and the
idea of setting it to a conga come from [matias.me/nsfw](https://matias.me/nsfw/), and the
track is "Conga" by Gloria Estefan and Miami Sound Machine. The soft-body toy that started
this is [jelly baby](https://jelly.scottsun.io) by Scott Sun.

A personal, non-commercial fan project. None of the above is mine, and none of it is licensed
for redistribution.
