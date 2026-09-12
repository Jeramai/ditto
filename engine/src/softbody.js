// XPBD tetrahedral soft body. Constraint pair per element: deviatoric
// ||F||_F - sqrt(3) against the shear modulus, and det(F) - 1 against the bulk
// modulus. Macklin & Muller, "A Constraint-based Formulation of Stable
// Neo-Hookean Deformation" (2021).
//
// Contact runs on the bound surface, not on the cage. The cage is a grown hull
// and sits below the surface at rest, so a cage-node floor would levitate him.

export const DEFAULTS = {
    // Sag is the bulk-to-shear ratio, not the overall stiffness: bulk holds his
  // volume while shear decides how far he settles. He sits 7% shorter than his
  // rest shape. bake_rest.mjs can pre-deform the cage to cancel that entirely,
  // but with friction there are several equilibria and the baked one is only
  // reachable from the first settle: one hand hold and he drops 8 mm and stays
  // there. A slightly firmer material gives the same shape every time instead.
  density: 1050, shear: 1200, bulk: 65e3, damping: 3, gravity: 9.81,
  // Low, because the gait in locomotion.js is a servo onto a target speed and
  // not an impulse. At 0.65 its own gain of 48 peaks at 6.96 m/s^2 against a
  // 6.4 m/s^2 static threshold, so he crept at 18 mm/s; winding the gain up
  // instead sheared his base until an element inverted. At 0.16 the rig runs at
  // its designed gain, he walks at 83 mm/s and the worst Jacobian under load is
  // the same 0.31 he shows at rest. He still does not creep when idle: 0.04 mm
  // over a second and a half.
  staticFriction: 0.16, dynamicFriction: 0.10, restitution: 0.065,
  // Contact has to be compliant or it becomes a point support. A hard push puts
  // a penetrating vertex exactly on the floor, so it disengages at once and the
  // equilibrium is a handful of vertices at zero carrying everything: 4 of 1606
  // held his whole weight. With a compliance he sinks until enough of the base
  // is engaged to carry the load, which is what a contact patch is.
  // Damping on this one is left off: it buys nothing (the visible jiggle is
  // already 0.007 mm) and it lets the multiplier go negative, which drags him
  // through the floor.
  contactCompliance: 0.02, contactDamping: 0,
  // 720 Hz with one sweep. Raising the sweep count is what to avoid: the
  // deviatoric constraint pulls toward collapse and the hydrostatic offset
  // resists, and at four sweeps that balance runs away and inflates him 38 mm.
  // Under-relaxation. Gauss-Seidel carries a correction about one element per
  // sweep, so 720 sweeps a second push information across him at 4.1 m/s while
  // his shear wave speed is only 0.53 m/s. That is why lifting one arm moved the
  // far arm almost at once. The multiplier accumulates, so the settled stiffness
  // is unchanged; only how fast the coupling travels.
  relaxation: 1,
  // The deviatoric and hydrostatic multipliers balance each other at rest, and
  // XPBD resets them every substep, so how far the balance rebuilds depends on
  // h and on the sweep count. One sweep at 720 Hz rebuilds it better than two
  // at 480. Carrying them over would keep it outright. 0 resets, 1 keeps.
  warmStart: 0,
  floor: 0, substep: 1 / 720, iterations: 1,
  // The grab pulls with a multiple of his own weight, so he can be picked up.
  // Under 1.0 he can never leave the floor. 2 was enough only while grabEase was
  // 40 ms and the easing was the bottleneck; once the target tracked the cursor
  // the force became the limit, and a fast drag left him 77 px behind on screen.
  // 6 fixes that -- 9 px -- and is the plateau: 14 and 30 track no better and
  // both hold a worse Jacobian. The radius spreads that force: 32 mm grabs 300
  // of the 728 nodes, so pulling one arm dragged the other arm with it.
  grabWeightFraction: 6, grabCompliance: 1e-6, grabRadius: 0.018, grabEase: 0.01,
  // Letting go of a stretched body just lets the stretch recoil: the grabbed end
  // snaps back and the centre of mass barely travels, so a throw read as him
  // flying the wrong way. Hand the body the cursor's own velocity instead.
  throwScale: 1, throwWindow: 0.06, throwMax: 2.5,
  // The rescue has to be a rate, not a fixed fraction. As a fraction it fires
  // per iteration, so its strength scaled with the substep rate and injected
  // energy: at 3840 Hz that is 7,680 snaps a second.
  maxTravel: 0.003, inversionFloor: 0.12, inversionTau: 0.004,
  // Shape memory, off by default. It holds the silhouette 10 mm taller, but it
  // couples every node to one rigid pose, so a grab fights the whole body: held
  // by a hand he shook at 136 mm/s, and at rest he hummed at 8 Hz. Compliance is
  // m/N per node and only means anything near 1/w, w being 8368 here.
  shapeCompliance: 0, shapeDamping: 1e-4,
  // Internal viscosity. Relative motion decays with this time constant while the
  // rigid motion is untouched, so linear and angular momentum both survive. On
  // the floor friction hides the lack of it; hanging in the air nothing does.
  viscousTau: 0.06,
  // Righting reflex. Dropped on his face he has no reason to get up, so this is
  // an active torque toward upright rather than a physical effect: gain in
  // rad/s^2 per unit of sin(tilt), and a damping term so he settles instead of
  // rocking. It injects angular momentum on purpose, which is what a creature
  // pushing itself upright does.
  uprightGain: 700, uprightDamping: 3.2,
  // He can only push himself upright against the ground. Held in the air he has
  // nothing to push against, so the reflex fades out with floor contact, which
  // is also what lets him dangle from the cursor instead of fighting it.
  uprightContacts: 14,
};

const inv3 = (m, out) => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return 0;
  const s = 1 / det;
  out[0] = A * s; out[1] = (c * h - b * i) * s; out[2] = (b * f - c * e) * s;
  out[3] = B * s; out[4] = (a * i - c * g) * s; out[5] = (c * d - a * f) * s;
  out[6] = C * s; out[7] = (b * g - a * h) * s; out[8] = (a * e - b * d) * s;
  return det;
};

export function createSoftBody(model, options = {}) {
  const P = { ...DEFAULTS, ...options };
  const elementOrder = options.elementOrder ?? null;
  const nodeCount = model.particles.length / 3;
  const tets = model.tets, tetCount = model.volumes.length;

  const x = Float64Array.from(model.particles);
  const rest0 = Float64Array.from(model.particles);
  const prev = new Float64Array(x.length);
  const p = new Float64Array(x.length);
  const velocity = new Float64Array(x.length);
  const invMass = new Float64Array(nodeCount);
  const mass = new Float64Array(nodeCount);
  const DmInv = new Float64Array(9 * tetCount);
  const restVolume = Float64Array.from(model.volumes);
  const lambdaD = new Float64Array(tetCount);
  const lambdaH = new Float64Array(tetCount);
  const lambdaS = new Float64Array(nodeCount);
  const lambdaC = new Float64Array(model.contacts.length);

  const Dm = new Float64Array(9), Fm = new Float64Array(9);
  const dCdF = new Float64Array(9), grad = new Float64Array(12);

  for (let t = 0; t < tetCount; t++) {
    const o = t * 4;
    const i0 = tets[o] * 3, i1 = tets[o + 1] * 3, i2 = tets[o + 2] * 3, i3 = tets[o + 3] * 3;
    for (let r = 0; r < 3; r++) {
      Dm[r * 3] = x[i1 + r] - x[i0 + r];
      Dm[r * 3 + 1] = x[i2 + r] - x[i0 + r];
      Dm[r * 3 + 2] = x[i3 + r] - x[i0 + r];
    }
    inv3(Dm, DmInv.subarray(t * 9, t * 9 + 9));
    const share = P.density * restVolume[t] * 0.25;
    for (let k = 0; k < 4; k++) mass[tets[o + k]] += share;
  }
  for (let i = 0; i < nodeCount; i++) invMass[i] = mass[i] > 0 ? 1 / mass[i] : 0;
  const totalMass = mass.reduce((a, b) => a + b, 0);

  // Read live, not captured: it is the one grab number worth sweeping at runtime
  // and a constant made every sweep silently measure the same force.
  const grabForceNow = () => P.maxGrabForce ?? P.grabWeightFraction * totalMass * P.gravity;
  const restPressure = P.shear / P.bulk;
  const rescueBeta = 1 - Math.exp(-(P.substep / P.iterations) / P.inversionTau);
  const alphaDev = 1 / P.shear, alphaHyd = 1 / P.bulk;

  const contactIds = model.contacts;
  const bindIds = model.bindingIds, bindW = model.bindingWeights;

  const skinAt = (src, vertex, out) => {
    const b = vertex * 4;
    out[0] = out[1] = out[2] = 0;
    for (let k = 0; k < 4; k++) {
      const w = bindW[b + k], j = bindIds[b + k] * 3;
      out[0] += w * src[j]; out[1] += w * src[j + 1]; out[2] += w * src[j + 2];
    }
    return out;
  };

  const now = new Float64Array(3), before = new Float64Array(3);
  let contactCount = 0, minJacobian = 1, guarded = 0, limited = 0;

  // Rest frame for the shape term: offsets about the mass centre.
  const restOffset = new Float64Array(x.length);
  const restCentre = new Float64Array(3);
  for (let i = 0; i < nodeCount; i++)
    for (let r = 0; r < 3; r++) restCentre[r] += mass[i] * x[i * 3 + r];
  for (let r = 0; r < 3; r++) restCentre[r] /= totalMass;
  for (let i = 0; i < nodeCount; i++)
    for (let r = 0; r < 3; r++) restOffset[i * 3 + r] = x[i * 3 + r] - restCentre[r];

  const rotation = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const cov = new Float64Array(9), tmp = new Float64Array(9);
  const centre = new Float64Array(3);

  // Orthogonal polar factor by the Higham iteration R <- (R + R^-T)/2. The
  // iteration is scale free but only converges from a well-scaled start, and a
  // mass-weighted covariance of a 5 cm body has entries around 1e-8.
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const polar = (M, R) => {
    let norm = 0;
    for (let k = 0; k < 9; k++) norm += M[k] * M[k];
    norm = Math.sqrt(norm / 3);
    if (!(norm > 0)) { R.set(IDENTITY); return false; }
    for (let k = 0; k < 9; k++) R[k] = M[k] / norm;
    if (inv3(R, tmp) <= 0) { R.set(IDENTITY); return false; }
    for (let iter = 0; iter < 32; iter++) {
      if (inv3(R, tmp) <= 0) { R.set(IDENTITY); return false; }
      let delta = 0;
      for (let k = 0; k < 9; k++) {
        const next = 0.5 * (R[k] + tmp[(k % 3) * 3 + ((k / 3) | 0)]);
        delta += Math.abs(next - R[k]);
        R[k] = next;
      }
      if (delta < 1e-13) break;
    }
    return true;
  };

  // The goal pose is fixed once per substep. Recomputing the polar factor inside
  // the solve makes the target chase positions the constraint itself just moved,
  // and that feedback loop is what left him humming at rest.
  const goal = new Float64Array(x.length);
  const updateShapeGoal = () => {
    if (!(P.shapeCompliance > 0)) return;
    centre[0] = centre[1] = centre[2] = 0;
    for (let i = 0; i < nodeCount; i++)
      for (let r = 0; r < 3; r++) centre[r] += mass[i] * p[i * 3 + r];
    for (let r = 0; r < 3; r++) centre[r] /= totalMass;

    cov.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const m = mass[i], j = i * 3;
      const dx = p[j] - centre[0], dy = p[j + 1] - centre[1], dz = p[j + 2] - centre[2];
      const rx = restOffset[j], ry = restOffset[j + 1], rz = restOffset[j + 2];
      cov[0] += m * dx * rx; cov[1] += m * dx * ry; cov[2] += m * dx * rz;
      cov[3] += m * dy * rx; cov[4] += m * dy * ry; cov[5] += m * dy * rz;
      cov[6] += m * dz * rx; cov[7] += m * dz * ry; cov[8] += m * dz * rz;
    }
    if (!polar(cov, rotation)) return;
    const R = rotation;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3;
      const rx = restOffset[j], ry = restOffset[j + 1], rz = restOffset[j + 2];
      goal[j]     = centre[0] + R[0] * rx + R[1] * ry + R[2] * rz;
      goal[j + 1] = centre[1] + R[3] * rx + R[4] * ry + R[5] * rz;
      goal[j + 2] = centre[2] + R[6] * rx + R[7] * ry + R[8] * rz;
    }
  };

  // A compliant pull, not a rate-based lerp. A lerp moves each node by
  // deviation * h / tau every substep, so when it opposes a held grab the
  // position is static while v = (p - x) / h reads hundreds of mm/s. With a
  // compliance the two settle into a real equilibrium instead.
  const solveShape = (h, h2) => {
    if (!(P.shapeCompliance > 0)) return;
    const at = P.shapeCompliance / h2;
    // Damped constraint. An undamped spring against the floor rings forever, and
    // at 0.4 mm and 8 Hz that reads as a hum. The gamma term resists motion
    // along the constraint, which is what stops the ring.
    const gamma = at * P.shapeDamping / h;
    const denomScale = 1 + gamma;
    for (let i = 0; i < nodeCount; i++) {
      const w = invMass[i];
      if (w === 0) continue;
      const j = i * 3;
      const dx = goal[j] - p[j], dy = goal[j + 1] - p[j + 1], dz = goal[j + 2] - p[j + 2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-12) continue;
      const inv = 1 / dist;
      const moved = ((p[j] - x[j]) * dx + (p[j + 1] - x[j + 1]) * dy
                   + (p[j + 2] - x[j + 2]) * dz) * inv;
      const dl = (dist - at * lambdaS[i] - gamma * moved) / (denomScale * w + at);
      lambdaS[i] += dl;
      const scale = w * dl * inv;
      p[j] += dx * scale; p[j + 1] += dy * scale; p[j + 2] += dz * scale;
    }
  };

  // An element whose Jacobian falls under the floor is on its way inside out,
  // and the det(F) - 1 gradient cannot be trusted to bring it back. Pull it
  // toward its own rest shape, rotated by its polar factor. Healthy elements
  // never enter this path.
  const elemR = new Float64Array(9), elemCov = new Float64Array(9);
  const rescueD = new Float64Array(12);
  const inertia = new Float64Array(9), inertiaInv = new Float64Array(9);
  const rescueElement = (t) => {
    const o = t * 4;
    let cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0;
    for (let k = 0; k < 4; k++) {
      const j = tets[o + k] * 3;
      cx += p[j]; cy += p[j + 1]; cz += p[j + 2];
      rx += rest0[j]; ry += rest0[j + 1]; rz += rest0[j + 2];
    }
    cx /= 4; cy /= 4; cz /= 4; rx /= 4; ry /= 4; rz /= 4;
    elemCov.fill(0);
    for (let k = 0; k < 4; k++) {
      const j = tets[o + k] * 3;
      const dx = p[j] - cx, dy = p[j + 1] - cy, dz = p[j + 2] - cz;
      const qx = rest0[j] - rx, qy = rest0[j + 1] - ry, qz = rest0[j + 2] - rz;
      elemCov[0] += dx * qx; elemCov[1] += dx * qy; elemCov[2] += dx * qz;
      elemCov[3] += dy * qx; elemCov[4] += dy * qy; elemCov[5] += dy * qz;
      elemCov[6] += dz * qx; elemCov[7] += dz * qy; elemCov[8] += dz * qz;
    }
    // A reflected covariance has no rotational polar factor, and that is exactly
    // the inverted case. Fall back to the body rotation, which is always valid.
    const R = polar(elemCov, elemR) ? elemR : rotation;
    const beta = rescueBeta;
    guarded++;

    for (let k = 0; k < 4; k++) {
      const i = tets[o + k];
      if (invMass[i] === 0) continue;
      const j = i * 3;
      const qx = rest0[j] - rx, qy = rest0[j + 1] - ry, qz = rest0[j + 2] - rz;
      p[j] += (cx + R[0] * qx + R[1] * qy + R[2] * qz - p[j]) * beta;
      p[j + 1] += (cy + R[3] * qx + R[4] * qy + R[5] * qz - p[j + 1]) * beta;
      p[j + 2] += (cz + R[6] * qx + R[7] * qy + R[8] * qz - p[j + 2]) * beta;
    }
  };

  const solveElement = (t, h2) => {
    const o = t * 4;
    const n0 = tets[o] * 3, n1 = tets[o + 1] * 3, n2 = tets[o + 2] * 3, n3 = tets[o + 3] * 3;
    const A = DmInv, a = t * 9;
    const V = restVolume[t];

    for (let pass = 0; pass < 2; pass++) {
      // F has to be rebuilt for each constraint. Evaluating the volume gradient
      // at the pre-shear positions and then applying it to the post-shear ones
      // breaks the rotation-invariance identity and pumps angular momentum in.
      for (let r = 0; r < 3; r++) {
        const c1 = p[n1 + r] - p[n0 + r], c2 = p[n2 + r] - p[n0 + r], c3 = p[n3 + r] - p[n0 + r];
        Fm[r * 3] = c1 * A[a] + c2 * A[a + 3] + c3 * A[a + 6];
        Fm[r * 3 + 1] = c1 * A[a + 1] + c2 * A[a + 4] + c3 * A[a + 7];
        Fm[r * 3 + 2] = c1 * A[a + 2] + c2 * A[a + 5] + c3 * A[a + 8];
      }
      let C, alpha, lambda;
      if (pass === 0) {
        let sq = 0;
        for (let k = 0; k < 9; k++) sq += Fm[k] * Fm[k];
        const norm = Math.sqrt(sq);
        if (norm < 1e-12) continue;
        // Target zero, not sqrt(3). The neo-Hookean deviatoric energy is
        // mu/2 (I_C - 3); dropping the constant leaves mu/2 ||F||^2, which is
        // (1/2)(1/alpha) C^2 with C = ||F||. Using ||F|| - sqrt(3) instead makes
        // the energy quadratic in (I_C - 3) where it should be linear, so the
        // material goes soft near rest. The hydrostatic offset below cancels the
        // rest-state pressure this leaves behind.
        C = norm;
        const s = 1 / norm;
        for (let k = 0; k < 9; k++) dCdF[k] = Fm[k] * s;
        alpha = alphaDev / V;
        lambda = lambdaD;
      } else {
        const f00 = Fm[0], f01 = Fm[1], f02 = Fm[2];
        const f10 = Fm[3], f11 = Fm[4], f12 = Fm[5];
        const f20 = Fm[6], f21 = Fm[7], f22 = Fm[8];
        // columns of the cofactor matrix: f2 x f3, f3 x f1, f1 x f2
        const c0x = f11 * f22 - f12 * f21, c0y = f12 * f20 - f10 * f22, c0z = f10 * f21 - f11 * f20;
        const c1x = f21 * f02 - f22 * f01, c1y = f22 * f00 - f20 * f02, c1z = f20 * f01 - f21 * f00;
        const c2x = f01 * f12 - f02 * f11, c2y = f02 * f10 - f00 * f12, c2z = f00 * f11 - f01 * f10;
        const det = f00 * c0x + f10 * c1x + f20 * c2x;
        if (det < minJacobian) minJacobian = det;
        if (det < P.inversionFloor) { rescueElement(t); continue; }
        // d det / d F is the cofactor matrix, row major like F. Writing the
        // cross products in as columns transposes it, and a transposed gradient
        // is not rotation invariant, so every volume solve ate angular momentum:
        // a rigid spin decayed to nothing in two seconds and he would not hang
        // from the cursor.
        dCdF[0] = c0x; dCdF[1] = c0y; dCdF[2] = c0z;
        dCdF[3] = c1x; dCdF[4] = c1y; dCdF[5] = c1z;
        dCdF[6] = c2x; dCdF[7] = c2y; dCdF[8] = c2z;
        C = det - 1 - restPressure;
        alpha = alphaHyd / V;
        lambda = lambdaH;
      }

      // grad(p_{j+1}) = column j of (dC/dF) * DmInv^T ; grad(p_0) closes the sum
      for (let r = 0; r < 3; r++) {
        const r0 = dCdF[r * 3], r1 = dCdF[r * 3 + 1], r2 = dCdF[r * 3 + 2];
        const g1 = r0 * A[a] + r1 * A[a + 1] + r2 * A[a + 2];
        const g2 = r0 * A[a + 3] + r1 * A[a + 4] + r2 * A[a + 5];
        const g3 = r0 * A[a + 6] + r1 * A[a + 7] + r2 * A[a + 8];
        grad[3 + r] = g1; grad[6 + r] = g2; grad[9 + r] = g3;
        grad[r] = -(g1 + g2 + g3);
      }

      const w0 = invMass[tets[o]], w1 = invMass[tets[o + 1]];
      const w2 = invMass[tets[o + 2]], w3 = invMass[tets[o + 3]];
      let denom = 0;
      denom += w0 * (grad[0] ** 2 + grad[1] ** 2 + grad[2] ** 2);
      denom += w1 * (grad[3] ** 2 + grad[4] ** 2 + grad[5] ** 2);
      denom += w2 * (grad[6] ** 2 + grad[7] ** 2 + grad[8] ** 2);
      denom += w3 * (grad[9] ** 2 + grad[10] ** 2 + grad[11] ** 2);
      const at = alpha / h2;
      if (denom + at < 1e-20) continue;
      const dl = (-C - at * lambda[t]) / (denom + at) * P.relaxation;
      lambda[t] += dl;
      for (let r = 0; r < 3; r++) {
        p[n0 + r] += w0 * dl * grad[r];
        p[n1 + r] += w1 * dl * grad[3 + r];
        p[n2 + r] += w2 * dl * grad[6 + r];
        p[n3 + r] += w3 * dl * grad[9 + r];
      }
    }
  };

  const solveContacts = (h, h2) => {
    contactCount = 0;
    const at = P.contactCompliance / h2;
    // A compliant contact is a spring, and an undamped spring at the base rings.
    const gamma = at * P.contactDamping / h;
    const denomScale = 1 + gamma;
    for (let ci = 0; ci < contactIds.length; ci++) {
      const vtx = contactIds[ci];
      skinAt(p, vtx, now);
      const depth = P.floor - now[1];
      if (depth <= 0) continue;
      contactCount++;
      const b = vtx * 4;
      let wEff = 0;
      for (let k = 0; k < 4; k++) {
        const w = bindW[b + k];
        wEff += w * w * invMass[bindIds[b + k]];
      }
      if (wEff < 1e-20) continue;
      skinAt(x, vtx, before);
      const closing = before[1] - now[1];
      let dl = (depth - at * lambdaC[ci] - gamma * closing) / (denomScale * wEff + at);
      // Contact pushes, never pulls. Without this clamp the damping term can
      // drive the multiplier negative and suck him under the floor.
      if (lambdaC[ci] + dl < 0) dl = -lambdaC[ci];
      lambdaC[ci] += dl;
      if (dl === 0) continue;
      for (let k = 0; k < 4; k++) {
        const w = bindW[b + k], j = bindIds[b + k];
        p[j * 3 + 1] += invMass[j] * w * dl;
      }

      skinAt(prev, vtx, before);
      let tx = now[0] - before[0], tz = now[2] - before[2];
      const slide = Math.hypot(tx, tz);
      if (slide < 1e-12) continue;
      const hold = slide < P.staticFriction * depth
        ? 1 : Math.min(1, P.dynamicFriction * depth / slide);
      tx *= hold; tz *= hold;
      const dlx = -tx / wEff, dlz = -tz / wEff;
      for (let k = 0; k < 4; k++) {
        const w = bindW[b + k], j = bindIds[b + k], m = invMass[j] * w;
        p[j * 3] += m * dlx; p[j * 3 + 2] += m * dlz;
      }
    }
  };

  // Grab: the four cage nodes behind one surface vertex, pulled to a target by
  // a force the solver caps. Barycentric weights keep the pull where the finger
  // landed instead of snapping to a node.
  let grab = null;

  const startGrab = (vertex, target) => {
    const b = vertex * 4;
    const cx = target[0], cy = target[1], cz = target[2];
    const r2 = P.grabRadius * P.grabRadius;
    const ids = [], weights = [];
    let sum = 0;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3;
      const d2 = (x[j] - cx) ** 2 + (x[j + 1] - cy) ** 2 + (x[j + 2] - cz) ** 2;
      if (d2 >= r2) continue;
      const f = (1 - d2 / r2) ** 2;
      ids.push(i); weights.push(f); sum += f;
    }
    if (!ids.length) {
      for (let k = 0; k < 4; k++) { ids.push(bindIds[b + k]); weights.push(bindW[b + k]); }
      sum = 1;
    }
    for (let k = 0; k < weights.length; k++) weights[k] /= sum;
    grab = { vertex, ids, w: weights, aim: Float64Array.from(target),
             target: Float64Array.from(target), lambda: 0,
             aimVel: new Float64Array(3) };
    return grab;
  };
  const moveGrab = (target) => {
    if (!grab) return;
    // exponential average of how fast the cursor is moving, for the throw
    const k = 1 - Math.exp(-P.substep / P.throwWindow);
    const inv = 1 / Math.max(P.substep, 1e-6);
    for (let r = 0; r < 3; r++) {
      const v = (target[r] - grab.aim[r]) * inv;
      grab.aimVel[r] += (v - grab.aimVel[r]) * k;
    }
    grab.aim.set(target);
  };
  const endGrab = () => {
    if (grab && P.throwScale > 0) {
      let vx = grab.aimVel[0] * P.throwScale;
      let vy = grab.aimVel[1] * P.throwScale;
      let vz = grab.aimVel[2] * P.throwScale;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > P.throwMax) {
        const s = P.throwMax / speed;
        vx *= s; vy *= s; vz *= s;
      }
      for (let i = 0; i < nodeCount; i++) {
        if (invMass[i] === 0) continue;
        const j = i * 3;
        velocity[j] += vx; velocity[j + 1] += vy; velocity[j + 2] += vz;
      }
    }
    grab = null;
  };

  // Pointer events land every 8 to 40 ms, so the raw aim is a staircase. Ease the
  // target toward it rather than feeding the constraint a step.
  //
  // The time constant has to be small. At 40 ms the held point trailed the cursor
  // by 6.8 mm on a fast drag and 5.1 mm even with events 40 ms apart, on a body
  // 53 mm wide -- it read as a magnet dragging him along rather than a hand
  // holding him. At 10 ms it tracks to under 0.4 mm, and the shear the easing
  // guards against does not appear: the worst Jacobian is 0.24 against 0.28.
  // Keep the radius where it is, though. Tightening the grab tracks perfectly and
  // tears him open: 6 mm grabs 5 nodes and drove the Jacobian to -2.8.
  const easeGrab = (h) => {
    if (!grab) return;
    const k = 1 - Math.exp(-h / P.grabEase);
    for (let r = 0; r < 3; r++) grab.target[r] += (grab.aim[r] - grab.target[r]) * k;
  };

  const solveGrab = (h2) => {
    if (!grab) return;
    const { ids, w } = grab;
    // The handle is the surface vertex the finger landed on, read fresh every
    // substep. Using the region centroid plus an offset frozen at grab time
    // leaves the grabbed point sitting 2 to 3 mm off the cursor for as long as
    // you hold it, because the region's shape changes as it is pulled.
    skinAt(p, grab.vertex, now);
    let wEff = 0;
    for (let k = 0; k < ids.length; k++) wEff += w[k] * w[k] * invMass[ids[k]];
    if (wEff < 1e-20) return;
    const dx = grab.target[0] - now[0];
    const dy = grab.target[1] - now[1];
    const dz = grab.target[2] - now[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-9) return;
    const at = P.grabCompliance / h2;
    let dl = (dist - at * grab.lambda) / (wEff + at);
    // The cap is on the accumulated multiplier, not on one iteration's share:
    // lambda/h^2 is the force the grab applies, and lambda resets each substep.
    const maxImpulse = grabForceNow() * h2;
    if (grab.lambda + dl > maxImpulse) dl = maxImpulse - grab.lambda;
    if (dl <= 0) return;
    grab.lambda += dl;
    const s = dl / dist;
    for (let k = 0; k < ids.length; k++) {
      const i = ids[k], j = i * 3, m = invMass[i] * w[k] * s;
      p[j] += m * dx; p[j + 1] += m * dy; p[j + 2] += m * dz;
    }
  };

  // Safety net: no node may move further in one substep than a fraction of the
  // lattice cell. A single over-large correction is what folds an element
  // inside out, and one inverted element ruins the shading of its neighbours.
  const limitTravel = () => {
    const cap = P.maxTravel;
    if (!(cap > 0)) return;
    const cap2 = cap * cap;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3;
      const dx = p[j] - x[j], dy = p[j + 1] - x[j + 1], dz = p[j + 2] - x[j + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= cap2) continue;
      const s = cap / Math.sqrt(d2);
      p[j] = x[j] + dx * s;
      p[j + 1] = x[j + 1] + dy * s;
      p[j + 2] = x[j + 2] + dz * s;
      limited++;
    }
  };

  // His orientation, as the rotation that best takes the rest shape to the
  // current one. The shape term used to compute this; it is off now, so the
  // righting reflex needs its own.
  const orient = new Float64Array(9);
  let tilt = 0;
  const measureOrientation = () => {
    centre[0] = centre[1] = centre[2] = 0;
    for (let i = 0; i < nodeCount; i++)
      for (let r = 0; r < 3; r++) centre[r] += mass[i] * x[i * 3 + r];
    for (let r = 0; r < 3; r++) centre[r] /= totalMass;
    cov.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const m = mass[i], j = i * 3;
      const dx = x[j] - centre[0], dy = x[j + 1] - centre[1], dz = x[j + 2] - centre[2];
      const rx = restOffset[j], ry = restOffset[j + 1], rz = restOffset[j + 2];
      cov[0] += m * dx * rx; cov[1] += m * dx * ry; cov[2] += m * dx * rz;
      cov[3] += m * dy * rx; cov[4] += m * dy * ry; cov[5] += m * dy * rz;
      cov[6] += m * dz * rx; cov[7] += m * dz * ry; cov[8] += m * dz * rz;
    }
    if (!polar(cov, orient)) { tilt = 0; return false; }
    rotation.set(orient);
    // his own up axis, in world space: column 1 of the rotation
    tilt = Math.hypot(-orient[7], orient[1]);
    return true;
  };

  const solveUpright = (h) => {
    if (!(P.uprightGain > 0)) return;
    const purchase = Math.min(1, contactCount / P.uprightContacts);
    if (purchase <= 0) return;
    if (!measureOrientation()) return;
    const ux = orient[1], uy = orient[4], uz = orient[7];
    // Axis that turns his up onto world up. Its length is sin(tilt), which is
    // zero both upright and fully inverted, so drive on the tilt itself and use
    // the cross product only for direction. Flat on his back, pick any axis.
    let ex = -uz, ez = ux;
    let axis = Math.hypot(ex, ez);
    if (axis < 1e-6) {
      if (uy > 0) return;
      ex = 1; ez = 0; axis = 1;
    }
    const strength = Math.sqrt(Math.max(0, (1 - uy) * 0.5));
    ex = ex / axis * strength; ez = ez / axis * strength;
    const ey = 0;

    // current spin, so the reflex can be damped instead of rocking him
    let vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3, mi = mass[i];
      vx += mi * velocity[j]; vy += mi * velocity[j + 1]; vz += mi * velocity[j + 2];
    }
    vx /= totalMass; vy /= totalMass; vz /= totalMass;
    let lx = 0, ly = 0, lz = 0;
    inertia.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3, mi = mass[i];
      const rx = x[j] - centre[0], ry = x[j + 1] - centre[1], rz = x[j + 2] - centre[2];
      const wx2 = velocity[j] - vx, wy2 = velocity[j + 1] - vy, wz2 = velocity[j + 2] - vz;
      lx += mi * (ry * wz2 - rz * wy2);
      ly += mi * (rz * wx2 - rx * wz2);
      lz += mi * (rx * wy2 - ry * wx2);
      const r2 = rx * rx + ry * ry + rz * rz;
      inertia[0] += mi * (r2 - rx * rx); inertia[1] -= mi * rx * ry; inertia[2] -= mi * rx * rz;
      inertia[3] -= mi * ry * rx; inertia[4] += mi * (r2 - ry * ry); inertia[5] -= mi * ry * rz;
      inertia[6] -= mi * rz * rx; inertia[7] -= mi * rz * ry; inertia[8] += mi * (r2 - rz * rz);
    }
    let sx = 0, sy = 0, sz = 0;
    if (inv3(inertia, inertiaInv)) {
      sx = inertiaInv[0] * lx + inertiaInv[1] * ly + inertiaInv[2] * lz;
      sy = inertiaInv[3] * lx + inertiaInv[4] * ly + inertiaInv[5] * lz;
      sz = inertiaInv[6] * lx + inertiaInv[7] * ly + inertiaInv[8] * lz;
    }
    // upright pull, minus damping on the spin about the same axes
    const gain = P.uprightGain * purchase;
    const ax = (gain * ex - P.uprightDamping * sx) * h;
    const ay = (gain * ey - P.uprightDamping * sy) * h;
    const az = (gain * ez - P.uprightDamping * sz) * h;
    for (let i = 0; i < nodeCount; i++) {
      if (invMass[i] === 0) continue;
      const j = i * 3;
      const rx = x[j] - centre[0], ry = x[j + 1] - centre[1], rz = x[j + 2] - centre[2];
      velocity[j] += ay * rz - az * ry;
      velocity[j + 1] += az * rx - ax * rz;
      velocity[j + 2] += ax * ry - ay * rx;
    }
  };

  // Bleed off motion that is not rigid-body motion. omega comes from the true
  // angular momentum and inertia tensor, so a spin is preserved exactly and only
  // the wobble is damped.
  const dampRelative = (h) => {
    if (!(P.viscousTau > 0)) return;
    let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3, mi = mass[i];
      cx += mi * x[j]; cy += mi * x[j + 1]; cz += mi * x[j + 2];
      vx += mi * velocity[j]; vy += mi * velocity[j + 1]; vz += mi * velocity[j + 2];
    }
    cx /= totalMass; cy /= totalMass; cz /= totalMass;
    vx /= totalMass; vy /= totalMass; vz /= totalMass;

    let lx = 0, ly = 0, lz = 0;
    inertia.fill(0);
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3, mi = mass[i];
      const rx = x[j] - cx, ry = x[j + 1] - cy, rz = x[j + 2] - cz;
      const ux = velocity[j] - vx, uy = velocity[j + 1] - vy, uz = velocity[j + 2] - vz;
      lx += mi * (ry * uz - rz * uy);
      ly += mi * (rz * ux - rx * uz);
      lz += mi * (rx * uy - ry * ux);
      const r2 = rx * rx + ry * ry + rz * rz;
      inertia[0] += mi * (r2 - rx * rx); inertia[1] -= mi * rx * ry; inertia[2] -= mi * rx * rz;
      inertia[3] -= mi * ry * rx; inertia[4] += mi * (r2 - ry * ry); inertia[5] -= mi * ry * rz;
      inertia[6] -= mi * rz * rx; inertia[7] -= mi * rz * ry; inertia[8] += mi * (r2 - rz * rz);
    }
    if (!inv3(inertia, inertiaInv)) return;
    const wx = inertiaInv[0] * lx + inertiaInv[1] * ly + inertiaInv[2] * lz;
    const wy = inertiaInv[3] * lx + inertiaInv[4] * ly + inertiaInv[5] * lz;
    const wz = inertiaInv[6] * lx + inertiaInv[7] * ly + inertiaInv[8] * lz;

    const k = 1 - Math.exp(-h / P.viscousTau);
    for (let i = 0; i < nodeCount; i++) {
      if (invMass[i] === 0) continue;
      const j = i * 3;
      const rx = x[j] - cx, ry = x[j + 1] - cy, rz = x[j + 2] - cz;
      const gx = vx + wy * rz - wz * ry;
      const gy = vy + wz * rx - wx * rz;
      const gz = vz + wx * ry - wy * rx;
      velocity[j] += (gx - velocity[j]) * k;
      velocity[j + 1] += (gy - velocity[j + 1]) * k;
      velocity[j + 2] += (gz - velocity[j + 2]) * k;
    }
  };

  const step = (h = P.substep) => {
    const h2 = h * h;
    prev.set(x);
    const dv = -P.gravity * h;
    for (let i = 0; i < nodeCount; i++) {
      const j = i * 3;
      if (invMass[i] === 0) { p[j] = x[j]; p[j + 1] = x[j + 1]; p[j + 2] = x[j + 2]; continue; }
      velocity[j + 1] += dv;
      p[j] = x[j] + velocity[j] * h;
      p[j + 1] = x[j + 1] + velocity[j + 1] * h;
      p[j + 2] = x[j + 2] + velocity[j + 2] * h;
    }
    if (P.warmStart > 0) {
      for (let t = 0; t < tetCount; t++) {
        lambdaD[t] *= P.warmStart; lambdaH[t] *= P.warmStart;
      }
    } else { lambdaD.fill(0); lambdaH.fill(0); }
    lambdaS.fill(0); lambdaC.fill(0);
    updateShapeGoal();
    if (grab) grab.lambda = 0;
    easeGrab(h);
    minJacobian = 1;
    for (let it = 0; it < P.iterations; it++) {
      // The GPU solves elements in colour order. Gauss-Seidel depends on that
      // order, so the two only agree if the CPU walks the same sequence.
      if (elementOrder) {
        for (let i = 0; i < elementOrder.length; i++) solveElement(elementOrder[i], h2);
      } else {
        for (let t = 0; t < tetCount; t++) solveElement(t, h2);
      }
      solveShape(h, h2);
      solveGrab(h2);
      solveContacts(h, h2);
      limitTravel();
    }
    const decay = Math.exp(-P.damping * 0.35 * h), invH = 1 / h;
    for (let i = 0; i < nodeCount; i++) {
      if (invMass[i] === 0) continue;
      const j = i * 3;
      for (let r = 0; r < 3; r++) {
        velocity[j + r] = (p[j + r] - x[j + r]) * invH * decay;
        x[j + r] = p[j + r];
      }
    }
    solveUpright(h);
    dampRelative(h);
    if (minJacobian <= 0) guarded++;
  };

  return {
    params: P, x, velocity, invMass, tets, DmInv, restVolume, skinAt, rotation,
    nodeCount, tetCount, totalMass, get grabForce() { return grabForceNow(); }, step,
    startGrab, moveGrab, endGrab,
    get grabbing() { return grab !== null; },
    get grab() { return grab; },
    get minJacobian() { return minJacobian; },
    get contactCount() { return contactCount; },
    get guarded() { return guarded; },
    get limited() { return limited; },
    get tilt() { return tilt; },
  };
}
