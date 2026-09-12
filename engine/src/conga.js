// The conga, shaped from the favicon sprite rather than invented: those four
// frames measure 27x23, 29x21, 29x19 and 27x27 pixels, so the dance is a squash
// and stretch bounce in place -- he shortens about 17%, and widens as he does.
//
// It poses him through the rig's posture spring instead of injecting a velocity
// field, and stiffens that spring while it does, because at walking stiffness
// the spring settles against the bulk modulus and only squashes him 2%.
//
// A squash on a floor moves him whichever way it is driven: the contact answers
// the downward half and not the upward one, so every cycle leaves a net impulse.
// Measured 6 mm over 5 seconds. Cancelling it as a velocity failed, because the
// dance's own instantaneous speed defeats any speed gate. So hold his ground
// instead: remember the spot, and pull the centre of mass back to it.

export const CONGA = {
  beat: 0.4902,                          // seconds, measured off the track
  frames: [1.0, 0.913, 0.826, 1.174],    // sprite height / neutral height
  ease: 60,                              // 1/s onto the frame
  stiff: 20,                             // posture spring multiplier while dancing
  // The sprite alternates its two nubs: frame 0 has both high, frame 2 drops the
  // left to y11 while the right sits at y7, frame 3 throws the right up to y3.
  // That is about a fifth of its height, so 9 mm on his 50 mm cage.
  arms: 0.009,                           // m, peak lift per arm
  turn: 0.05,                            // s of S at the start: a tap, not a walk
  turnHold: 0.35,                        // s the heading keeps easing after the gait stops
  turnRate: 26,                          // 1/s throughout; 38 and up inverts a tet on a big turn
  home: 14,                              // 1/s reclaiming the spot
  homeDamp: 24,                          // 1/s off the horizontal drift velocity
  homeRange: 0.05,                       // m; further than this he was moved on purpose
};

export function createConga(rig, body, options = {}) {
  const P = { ...CONGA, ...options };
  const x = body.x, v = body.velocity;
  const n = body.nodeCount;
  const mass = new Float64Array(n);
  let totalMass = 0;
  for (let i = 0; i < n; i++) {
    mass[i] = body.invMass[i] > 0 ? 1 / body.invMass[i] : 0;
    totalMass += mass[i];
  }

  let on = false, phase = 0, tall = 1, stiff = 1, armed = 0;
  let home = null;

  const frameHeight = (u) => {
    const f = u * P.frames.length;
    const i0 = Math.floor(f) % P.frames.length;
    const i1 = (i0 + 1) % P.frames.length;
    return P.frames[i0] + (P.frames[i1] - P.frames[i0]) * (f - Math.floor(f));
  };

  const centre = () => {
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const m = mass[i] / totalMass, j = i * 3;
      cx += x[j] * m; cz += x[j + 2] * m;
    }
    return [cx, cz];
  };

  const step = (dt, clock) => {
    if (dt <= 0) return;
    // Prefer the audio clock over accumulated dt: a dropped frame then loses a
    // slice of the bounce instead of sliding the whole dance off the beat.
    let want = 1, wantStiff = 1;
    if (on) {
      phase = clock === undefined ? phase + dt / P.beat : clock / P.beat;
      want = frameHeight(phase - Math.floor(phase));
      wantStiff = P.stiff;
    }
    const k = Math.min(1, P.ease * dt);
    tall += (want - tall) * k;
    stiff += (wantStiff - stiff) * k;
    // widen as he shortens, so the silhouette matches the sprite
    const wide = 1 / Math.sqrt(tall);
    rig.setShape(wide, tall, wide, stiff);
    // one beat per full swing, so the two arms trade places on the beat
    const swing = on ? Math.sin(phase * Math.PI * 2) : 0;
    armed += (swing - armed) * k;
    rig.setArms(armed * P.arms);

    if (!on || body.grabbing) { home = null; return; }
    const here = centre();
    if (!home) { home = here; return; }
    // Keep the spot even while he is off the ground. At 17% he bounces clear of
    // it every cycle, and forgetting the spot each time made the servo re-home
    // onto wherever he had already drifted to -- he walked 15 mm in 8 seconds.
    if (body.contactCount === 0) return;
    const dx = home[0] - here[0], dz = home[1] - here[1];
    // If he is well off the spot somebody carried him there. Take the new one.
    if (Math.hypot(dx, dz) > P.homeRange) { home = here; return; }
    // Correct the position, not the velocity. A velocity nudge arrives once a
    // frame while the contact regenerates the drift across every substep, so it
    // only ever caught up part way: 12.3 mm of drift became 4.2 mm at twenty
    // times the gain. Shifting him is rigid and horizontal, so it cannot shear
    // him and cannot push him into the floor, and it cancels the drift exactly.
    const g = Math.min(1, P.home * dt);
    const d = Math.min(1, P.homeDamp * dt);
    let vx = 0, vz = 0;
    for (let i = 0; i < n; i++) {
      const m = mass[i] / totalMass, j = i * 3;
      vx += v[j] * m; vz += v[j + 2] * m;
    }
    for (let i = 0; i < n; i++) {
      if (!mass[i]) continue;
      const j = i * 3;
      x[j] += dx * g; x[j + 2] += dz * g;
      v[j] -= vx * d; v[j + 2] -= vz * d;
    }
  };

  return {
    step, params: P,
    get on() { return on; },
    get height() { return tall; },
    set on(value) {
      on = value;
      if (value) rig.press(0, 1, P.turn, P.turnRate, P.turnHold); else { phase = 0; home = null; }
    },
    toggle() { this.on = !on; return on; },
  };
}
