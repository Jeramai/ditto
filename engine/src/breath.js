// He breathes: a slow vertical push on the cage, weighted so his top rises and
// his base stays planted. It is a force on the cage, never an edit to the
// surface, so the grab bindings stay exact.

export const BREATH = {
  hz: 0.22,
  // Keep the acceleration well under gravity and apply it once per frame:
  // injecting it per substep excited the body's own modes and read as a
  // vibration rather than a breath.
  accel: 1.6,
  sway: 0.16,
  wander: 0.021,
};

export function createBreath(body, options = {}) {
  const P = { ...BREATH, ...options };
  const x = body.x, v = body.velocity;
  const n = body.nodeCount;
  const weight = new Float64Array(n);
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 1; i < x.length; i += 3) {
    if (x[i] < y0) y0 = x[i];
    if (x[i] > y1) y1 = x[i];
  }
  const h = y1 - y0 || 1;
  for (let i = 0; i < n; i++) {
    const f = (x[i * 3 + 1] - y0) / h;
    weight[i] = f * f;
  }

  let t = Math.random() * Math.PI * 2, carry = 0;

  const step = (dt) => {
    t += dt;
    carry += dt;
    if (carry < 1 / 60) return;
    const sdt = carry;
    carry = 0;
    const up = Math.sin(t * P.hz * Math.PI * 2) * P.accel;
    // a second, slower and off-phase sway keeps it from looking metronomic
    const sx = Math.sin(t * P.hz * 2.1 + 1.7) * P.sway;
    const sz = Math.cos(t * P.hz * 1.3 + 0.4) * P.sway;
    for (let i = 0; i < n; i++) {
      if (body.invMass[i] === 0) continue;
      const k = weight[i] * sdt, j = i * 3;
      v[j] += sx * k * P.wander;
      v[j + 1] += up * k;
      v[j + 2] += sz * k * P.wander;
    }
  };

  return { step };
}
