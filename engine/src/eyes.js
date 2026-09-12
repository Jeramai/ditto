import { uniform, attribute, abs, smoothstep, oneMinus } from 'three/tsl';

const OPEN = 1.4;          // a half width this large inks the whole disc
const SHUT = 0.24;
const FADE = 0.07;         // soft edge, in eye radii: the discs are ~12 px on screen
const HOLD = 0.11;         // seconds the lid stays down
const GAP = [2.6, 6.8];
const EASE = 34;           // 1/s toward the target
const TAPER = 0.85;        // how far the lid narrows toward the corners

export function createEyes(model) {
  const tag = model.faceTag, pos = model.positions, nor = model.normals;
  const eyeUV = new Float32Array(tag.length * 2);

  // The two discs sit either side of x = 0, so the sign splits them.
  const sides = [[], []];
  for (let i = 0; i < tag.length; i++) if (tag[i] > 0.5) sides[pos[i * 3] < 0 ? 0 : 1].push(i);

  for (const side of sides) {
    if (!side.length) continue;
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (const i of side) {
      cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2];
      nx += nor[i * 3]; ny += nor[i * 3 + 1]; nz += nor[i * 3 + 2];
    }
    const k = 1 / side.length;
    cx *= k; cy *= k; cz *= k;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    // u across the disc, v up it, both in the plane it faces
    let ux = nz, uz = -nx;
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    let vx = ny * uz, vy = nz * ux - nx * uz, vz = -ny * ux;
    if (vy < 0) { vx = -vx; vy = -vy; vz = -vz; }

    let radius = 0;
    for (const i of side) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      radius = Math.max(radius, Math.hypot(dx, dy, dz));
    }
    const inv = 1 / (radius || 1);
    for (const i of side) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      eyeUV[i * 2] = (dx * ux + dz * uz) * inv;
      eyeUV[i * 2 + 1] = (dx * vx + dy * vy + dz * vz) * inv;
    }
  }

  const lid = uniform(OPEN), taper = uniform(0);
  const e = attribute('eyeUV', 'vec2');
  // a width that tapers to a point is what makes a shut lid read as a lid
  const half = lid.mul(oneMinus(abs(e.x).mul(taper))).max(0.02);
  const inkNode = oneMinus(smoothstep(half.sub(FADE), half.add(FADE), abs(e.y)));

  const next = () => GAP[0] + Math.random() * (GAP[1] - GAP[0]);
  let until = next(), shut = 0;

  return {
    eyeUV, inkNode,
    uniforms: { lid, taper },
    get shut() { return shut > 0; },

    step(dt) {
      if (shut > 0) shut -= dt;
      else if ((until -= dt) <= 0) { shut = HOLD; until = next(); }
      const k = Math.min(1, EASE * dt);
      lid.value += ((shut > 0 ? SHUT : OPEN) - lid.value) * k;
      taper.value += ((shut > 0 ? TAPER : 0) - taper.value) * k;
    },
  };
}
