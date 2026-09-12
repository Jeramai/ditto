// Walking, ported from the rig the live build uses, because the gaits I wrote
// instead were both wrong. A hop reads as a lurch three times a second, and a
// plain horizontal drive shears his base against a 0.65 friction floor until an
// element inverts -- one direction reversal measured a Jacobian of -0.82.
//
// This works differently. Every node is sprung toward its rest offset from his
// centre, stiff at the feet and softer above, and the gait is an animated pose
// on those targets: the feet swing fore and aft and lift, the arms counter. The
// posture spring is what makes the horizontal drive safe, because it holds his
// shape while friction pushes back on it. The drive itself is a servo onto a
// target speed rather than an impulse.
//
// The length constants come from the original 7.5 cm jelly and are kept as they
// are: the live build never rescaled them for a 4 cm Ditto, and the result is
// the gait we are matching.

export const LOCOMOTION = {
  speed: 0.145,           // m/s the servo aims for
  drive: 48,              // servo gain onto that speed
  footStiff: 1800,        // posture spring under footHeight
  bodyStiff: 1000,        // and above it
  postureDamp: 24,        // against his own mean velocity, so rigid motion is free
  footHeight: 0.023,      // how far above his base still counts as a foot
  armOut: 0.03,           // how far out a node must sit to counter-swing
  armRamp: 0.016,
  swingFoot: 0.009,       // fore and aft, at the feet
  swingArm: 0.004,        // and against it, at the arms
  footLift: 0.006,        // on the forward half of the swing only
  gaitRate: 14,           // rad/s at full stride
  turnRate: 10,
  airDrive: 0.08,         // he can still steer a little off the ground
  airPosture: 0.22,
  // Hold to squish, release to jump, and the squish is what sets the height.
  // The crouch is a posture pose, so it stores no momentum: what you see is the
  // spring being wound, and the release is the only impulse.
  // How deep he squishes is capped, and the cap is not a taste call. Past about
  // this depth the squish loses more energy to the material than the impulse can
  // put back: 0.32 commanded reached an apex of zero, and 0.34 jumped 37 mm
  // where 0.28 jumps 78. Raise the gain with the depth or this stops working.
  crouch: 0.28,           // fraction of his height at a full charge
  crouchWiden: 0.55,      // how much of that he puts back into his waist
  chargeTime: 0.42,       // s to wind all the way up
  chargeStiff: 22,        // posture multiplier while charging, or he barely dips
  // The floor is a real jump, not a nudge: on the move this is the whole jump,
  // since walking skips the wind-up. At 0.30 a walking jump cleared 5.6 mm and
  // read as a stumble; the hop gait it replaced used 0.43 to 0.55.
  jumpBase: 0.5,          // m/s off a tap, or while walking
  jumpGain: 0.95,         // and what a full charge adds, to the same ceiling
  jumpFoot: 0.12,         // extra, weighted to his underside
  jumpCooldown: 0.18,
  // Winding up shoves his base sideways: the charge spring is 22 times stiff and
  // reaching new targets against a 0.16 friction floor slides him 13.75 mm over
  // a second and a half. Softening the spring fixes the slide and ruins the
  // charge, so hold his ground instead, the same way the conga does -- and only
  // while he is not being asked to walk.
  plantGain: 16,          // 1/s reclaiming the spot he started winding on
  // Winding up has to slow him down. The charge spring is 22 times stiff and it
  // does not only hold the crouch, it also drives the gait's 9 mm foot swing
  // that much harder: crouching while walking doubled his speed to 161 mm/s and
  // he power walked across the field as a pancake. Plant him instead.
  chargeBrake: 0.5,       // how much of his stride a full charge takes away
  releaseFade: 0.55,      // s to fade the rig back in after a grab
};

export function createLocomotion(body, options = {}) {
  const P = { ...LOCOMOTION, ...options };
  const held = new Set();
  const x = body.x, v = body.velocity;
  const n = body.nodeCount;

  const mass = new Float64Array(n);
  let totalMass = 0;
  for (let i = 0; i < n; i++) {
    mass[i] = body.invMass[i] > 0 ? 1 / body.invMass[i] : 0;
    totalMass += mass[i];
  }

  // The rest cage, and his rest centre of mass. Heights are measured from the
  // cage's own base: it sits below the surface, so raw y is negative down there.
  const rest = Float64Array.from(x);
  let restBase = Infinity;
  for (let i = 1; i < rest.length; i += 3) if (rest[i] < restBase) restBase = rest[i];
  const restCentre = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const m = mass[i] / totalMass, j = i * 3;
    restCentre[0] += rest[j] * m;
    restCentre[1] += rest[j + 1] * m;
    restCentre[2] += rest[j + 2] * m;
  }

  // His arm nubs, for the conga to wave. The gait's own armOut of 30 mm picks
  // the fourteen lowest outer nodes on a 34 mm half width, which are not arms at
  // all; the nubs are the nodes that are both far out and high up.
  let restTop = -Infinity;
  for (let i = 1; i < rest.length; i += 3) if (rest[i] > restTop) restTop = rest[i];
  const armWeight = new Float64Array(n);
  const armSide = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const out = (Math.abs(rest[j] - restCentre[0]) - 0.014) / 0.010;
    const up = ((rest[j + 1] - restBase) / (restTop - restBase) - 0.45) / 0.30;
    armWeight[i] = Math.max(0, Math.min(1, out)) * Math.max(0, Math.min(1, up));
    armSide[i] = rest[j] < restCentre[0] ? -1 : 1;
  }

  const KEYS = {
    KeyW: [0, -1], ArrowUp: [0, -1],
    KeyS: [0, 1], ArrowDown: [0, 1],
    KeyA: [-1, 0], ArrowLeft: [-1, 0],
    KeyD: [1, 0], ArrowRight: [1, 0],
  };
  const onKey = (down) => (e) => {
    if (e.code === 'Space') {
      // Only the raw key state here. Whether it winds him up or fires straight
      // away depends on whether he is walking, and that is not known until step.
      jumpHeld = down;
      if (!down) fired = false;
      e.preventDefault();
      return;
    }
    if (!KEYS[e.code]) return;
    if (down) held.add(e.code); else held.delete(e.code);
    e.preventDefault();
  };
  const keyDown = onKey(true), keyUp = onKey(false);
  addEventListener('keydown', keyDown);
  addEventListener('keyup', keyUp);
  addEventListener('blur', () => held.clear());

  const stick = { x: 0, z: 0 };
  const setStick = (sx, sz) => { stick.x = sx; stick.z = sz; };
  // a key the dance presses for him; it adds like a real one, so it composes with both
  let nudge = null;
  // seconds of gait, then holdFor of heading alone: the rate that finishes a big
  // turn inside one tap inverts a tet, so the turn outlives the step instead.
  const press = (dx, dz, seconds, rate = 0, holdFor = seconds) => {
    nudge = { dx, dz, left: seconds, hold: holdFor, rate };
  };

  // The conga poses him through the same posture spring rather than injecting a
  // velocity field, so the dance cannot push him anywhere.
  // The conga poses him through this and stiffens it, because at the walking
  // stiffness the spring settles against a bulk modulus of 65e3 and only
  // squashes him 2%.
  const shape = { x: 1, y: 1, z: 1, stiff: 1, arm: 0 };
  const setShape = (sx, sy, sz, stiff = 1) => {
    shape.x = sx; shape.y = sy; shape.z = sz; shape.stiff = stiff;
  };
  // Signed: one arm goes up as the other goes down. Posed, not pushed, so the
  // pair cannot become a torque the way the old arm impulses did.
  const setArms = (lift) => { shape.arm = lift; };

  const pose = { on: false, cyaw: 1, syaw: 0, crouchY: 1, crouchXZ: 1, stiff: 1,
                 gait: 0, phase: 0, d: 0, l: 0, u: 0 };

  // The posture spring, run once per substep. Everything it needs was measured
  // on the frame; only the integration happens here.
  const posture = (h) => {
    if (!pose.on) return;
    // The centre and the mean velocity are measured here, every substep, not
    // stashed on the frame. Both have to be current or the spring fights rigid
    // motion: against a stale mean, the jump impulse looks like internal motion
    // and the damping term eats it -- -12 m/s^2 per substep, which cancelled the
    // jump entirely. Damping deviation from the current mean is the whole point,
    // and it leaves a uniform impulse untouched by construction.
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < n; i++) {
      const w = mass[i] / totalMass, j = i * 3;
      cx += x[j] * w; cy += x[j + 1] * w; cz += x[j + 2] * w;
      vx += v[j] * w; vy += v[j + 1] * w; vz += v[j + 2] * w;
    }
    for (let i = 0; i < n; i++) {
      if (!mass[i]) continue;
      const j = i * 3;
      let ox = (rest[j] - restCentre[0]) * shape.x * pose.crouchXZ;
      let oy = (rest[j + 1] - restCentre[1]) * shape.y * pose.crouchY;
      let oz = (rest[j + 2] - restCentre[2]) * shape.z * pose.crouchXZ;
      const foot = Math.max(0, 1 - (rest[j + 1] - restBase) / P.footHeight);
      const arm = Math.max(0, Math.min(1, (Math.abs(ox) - P.armOut) / P.armRamp));
      const swing = Math.sin(pose.phase + (ox < 0 ? 0 : Math.PI)) * pose.gait;
      oz += swing * (foot * P.swingFoot - arm * P.swingArm);
      oy += Math.max(0, swing) * foot * P.footLift;
      oy += shape.arm * armSide[i] * armWeight[i];
      const tx = ox * pose.cyaw + oz * pose.syaw;
      const tz = oz * pose.cyaw - ox * pose.syaw;
      const k = (foot > 0 ? P.footStiff : P.bodyStiff) * pose.stiff;
      v[j]     += (pose.d * (k * (cx + tx - x[j])     - P.postureDamp * (v[j] - vx)) + pose.l) * h;
      v[j + 1] += (pose.d * (k * (cy + oy - x[j + 1]) - P.postureDamp * (v[j + 1] - vy))) * h;
      v[j + 2] += (pose.d * (k * (cz + tz - x[j + 2]) - P.postureDamp * (v[j + 2] - vz)) + pose.u) * h;
    }
  };

  let yaw = 0, phase = 0, gaitWeight = 0, jumpQueued = false;
  let jumpCooldown = 0, releasedFor = P.releaseFade;
  let charging = false, charge = 0, crouched = 0, planted = null;
  let jumpHeld = false, fired = false;

  const step = (dt, camera) => {
    if (dt <= 0) return { moving: false, grounded: body.contactCount > 0 };
    jumpCooldown -= dt;

    // his centre and his own mean velocity, both mass weighted
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < n; i++) {
      const m = mass[i] / totalMass, j = i * 3;
      cx += x[j] * m; cy += x[j + 1] * m; cz += x[j + 2] * m;
      vx += v[j] * m; vy += v[j + 1] * m; vz += v[j + 2] * m;
    }

    const grounded = body.contactCount > 0;
    // Held, the rig steps aside completely: nothing should fight the cursor.
    if (body.grabbing) { releasedFor = 0; jumpQueued = false; pose.on = false;
      return { moving: false, grounded }; }
    releasedFor += dt;
    const fade = Math.min(1, releasedFor / P.releaseFade);

    let ix = stick.x, iz = stick.z;
    for (const code of held) { const [dx, dz] = KEYS[code]; ix += dx; iz += dz; }
    let turnRate = P.turnRate, hx = 0, hz = 0;
    if (nudge) {
      turnRate = nudge.rate || P.turnRate;
      if (nudge.left > 0) { ix += nudge.dx; iz += nudge.dz; nudge.left -= dt; }
      else { hx = nudge.dx; hz = nudge.dz; }
      if ((nudge.hold -= dt) <= 0) nudge = null;
    }
    let len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; len = 1; }

    // camera space: screen up is away from the viewer along the ground
    let mx = 0, mz = 0, hwx = 0, hwz = 0;
    if (len > 1e-4 || hx || hz) {
      const f = camera.getWorldDirection(FORWARD);
      const fl = Math.hypot(f.x, f.z) || 1;
      const nx = f.x / fl, nz = f.z / fl;
      if (len > 1e-4) { mx = -nz * ix + nx * -iz; mz = nx * ix + nz * -iz; }
      if (hx || hz) { hwx = -nz * hx + nx * -hz; hwz = nx * hx + nz * -hz; }
    }
    const move = Math.hypot(mx, mz);

    // Winding up is for standing still. On the move Space fires at once: a
    // crouch mid stride reads as a stumble, and it is also what let him power
    // walk as a pancake. Starting to walk mid charge spends it immediately.
    const walking = move > 0.01;
    if (jumpHeld) {
      if (walking) {
        if (charging) { charging = false; jumpQueued = true; }
        else if (!fired) { jumpQueued = true; fired = true; }
      } else if (!charging && !fired) {
        charging = true;
      }
    } else if (charging) {
      charging = false;
      jumpQueued = true;
    }

    const wx = move > 0.01 ? mx : hwx, wz = move > 0.01 ? mz : hwz;
    if (wx || wz) {
      const want = Math.atan2(wx, wz);
      const turn = Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw));
      yaw += turn * (1 - Math.exp(-turnRate * dt));
    }
    // wind up while the key is held and he has something to push off
    if (charging && grounded && jumpCooldown <= 0) {
      charge = Math.min(1, charge + dt / P.chargeTime);
    }
    // The pose follows the key, but the charge itself survives the release and
    // is cleared only once the jump has read it. Zeroing it here instead meant
    // every jump used the base impulse, so a deep squish jumped lower than a
    // tap -- it launched him folded up and gained nothing for it.
    const wound = charging ? charge : 0;
    crouched += (wound - crouched) * Math.min(1, 30 * dt);
    const crouchY = 1 - P.crouch * crouched;
    const crouchXZ = 1 + P.crouch * P.crouchWiden * crouched;
    const stiff = shape.stiff * (1 + (P.chargeStiff - 1) * crouched);

    const brake = 1 - P.chargeBrake * crouched;
    gaitWeight += (Math.min(1, move) * brake - gaitWeight) * (1 - Math.exp(-12 * dt));
    if (gaitWeight < 1e-5) gaitWeight = 0;
    if (move > 0.001 && grounded) {
      const pace = Math.max(0.25, Math.min(1, Math.hypot(vx, vz) / 0.1));
      phase += dt * pace * P.gaitRate;
    }

    const airK = grounded ? 1 : P.airDrive;
    // Stashed, not applied. The spring runs on the substep: at 22x charge
    // stiffness k*dt^2 is 2.7 on a 120 Hz frame and 44 on a 30 Hz one, well past
    // the explicit-integration limit, so it overshot instead of pulling -- while
    // holding jump he grew 4 mm taller and sank 4 mm into the floor. On the
    // 1/480 substep the same spring sits at 0.17 and behaves.
    pose.on = true;
    pose.cyaw = Math.cos(yaw); pose.syaw = Math.sin(yaw);
    pose.crouchY = crouchY; pose.crouchXZ = crouchXZ;
    pose.stiff = stiff; pose.gait = gaitWeight; pose.phase = phase;
    pose.d = (grounded ? 1 : P.airPosture) * fade;
    pose.l = (mx * P.speed * brake - vx) * P.drive * airK * fade;
    pose.u = (mz * P.speed * brake - vz) * P.drive * airK * fade;

    // Hold the spot he started winding on. Correcting the position rather than
    // the velocity, because the spring re-creates the slide every substep and a
    // velocity nudge only ever catches part of it.
    if (charging && grounded && move <= 0.01) {
      if (!planted) planted = [cx, cz];
      const dx = planted[0] - cx, dz = planted[1] - cz;
      if (Math.hypot(dx, dz) > 0.05) planted = [cx, cz];
      else {
        const g = Math.min(1, P.plantGain * dt);
        for (let i = 0; i < n; i++) {
          if (!mass[i]) continue;
          const j = i * 3;
          x[j] += dx * g; x[j + 2] += dz * g;
        }
      }
    } else if (!charging) {
      planted = null;
    }

    if (jumpQueued) {
      if (grounded && jumpCooldown <= 0) {
        const up = P.jumpBase + P.jumpGain * charge;
        for (let i = 0; i < n; i++) {
          if (!mass[i]) continue;
          const foot = Math.max(0, 1 - (rest[i * 3 + 1] - restBase) / 0.035);
          v[i * 3 + 1] += up + foot * P.jumpFoot;
        }
        jumpCooldown = P.jumpCooldown;
      }
      jumpQueued = false;
      charge = 0;              // spent, whether it launched or was dropped
      // Neutralise the crouch on the same frame, in the stashed pose as well as
      // the state. The pose was stashed while he was still folded, and the
      // substep spring is strong enough to hold him there through the launch:
      // leaving it cancelled the jump outright, 0.5 mm instead of 84.
      crouched = 0;
      pose.crouchY = 1; pose.crouchXZ = 1; pose.stiff = shape.stiff;
    }

    return { moving: move > 0.01, grounded };
  };

  // Put him back facing front. Without this the reset button restores his
  // position and leaves him turned, because the yaw lives here and not in the
  // cage: he came back from a walk still pointing away from the camera.
  const reset = () => {
    yaw = 0; phase = 0; gaitWeight = 0; jumpCooldown = 0;
    jumpQueued = false; releasedFor = P.releaseFade;
    charging = false; charge = 0; crouched = 0; planted = null;
    jumpHeld = false; fired = false;
    held.clear(); stick.x = 0; stick.z = 0; nudge = null;
  };

  const dispose = () => {
    removeEventListener('keydown', keyDown);
    removeEventListener('keyup', keyUp);
  };

  return { step, posture, setStick, press, setShape, setArms, reset, dispose, params: P,
    hold: () => { jumpHeld = true; },
    release: () => { jumpHeld = false; fired = false; },
    get charge() { return charge; },
    get yaw() { return yaw; }, get held() { return held.size; } };
}

// module scope scratch, so the step does not allocate
let FORWARD = null;
export function bindScratch(vector3) { FORWARD = vector3; }
