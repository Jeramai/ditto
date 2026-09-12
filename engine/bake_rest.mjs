// Gravity always deflects a soft body, so a cage baked at the model's own shape
// settles below it. Solve the inverse problem instead: find the rest cage whose
// settled shape IS the model. Fixed point, rest -= (settled - target), which
// converges in about a dozen rounds. Over-relaxing it diverges.
import { readFileSync, writeFileSync } from 'node:fs';
import { createSoftBody } from './src/softbody.js';

const SHEAR = Number(process.argv[2] ?? 300);
const ROUNDS = Number(process.argv[3] ?? 12);
// Relaxation on the fixed point, not partial compensation: the solution where
// the settled shape equals the model is the same for any value. Smaller just
// converges more slowly and survives a settle that is not perfectly repeatable.
const RELAX = Number(process.argv[4] ?? 0.5);

const meta = JSON.parse(readFileSync('public/ditto-model.json', 'utf8'));
const buf = readFileSync('public/ditto-model.bin');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const T = { Float32Array, Float64Array, Uint32Array };
const base = { ...meta };
for (const [k, v] of Object.entries(meta.layout)) base[k] = new T[v.type](ab, v.offset, v.length);
const NV = base.positions.length / 3;

const probe = new Float64Array(3);
const surfaceError = (b) => {
  let worst = 0, sum = 0;
  for (let v = 0; v < NV; v++) {
    b.skinAt(b.x, v, probe);
    const d = Math.hypot(probe[0] - base.positions[v * 3],
                         probe[1] - base.positions[v * 3 + 1],
                         probe[2] - base.positions[v * 3 + 2]);
    if (d > worst) worst = d;
    sum += d;
  }
  return { worst: worst * 1000, mean: sum / NV * 1000 };
};

const target = Float64Array.from(base.particles);
let rest = Float64Array.from(target);
const opts = { shear: SHEAR, bulk: 65e3 };
let probeBody;
// The fixed point plateaus and then wanders, so keep the best round, not the last.
let best = { mean: Infinity, worst: Infinity, rest: null, round: -1 };

for (let k = 0; k <= ROUNDS; k++) {
  const body = createSoftBody({ ...base, particles: rest }, opts);
  const rate = 1 / body.params.substep;
  for (let i = 0; i < rate * 6; i++) body.step();
  const e = surfaceError(body);
  probeBody = body;
  if (e.mean < best.mean) best = { ...e, rest: Float64Array.from(rest), round: k };
  process.stdout.write(`  round ${String(k).padStart(2)}  worst ${e.worst.toFixed(3)} mm  mean ${e.mean.toFixed(3)} mm${e.mean === best.mean ? '   <- best' : ''}\n`);
  if (k === ROUNDS) break;
  for (let i = 0; i < rest.length; i++) rest[i] -= RELAX * (body.x[i] - target[i]);
  // Gravity squashes him down, so compensation should lift nodes, never sink
  // them. A node pushed below the floor has nothing to push it back up, so the
  // iteration sinks it without limit and the surface bound to it hangs off the
  // base as a droplet. Clamp the vertical component to its original height.
  for (let i = 1; i < rest.length; i += 3)
    if (rest[i] < target[i]) rest[i] = target[i];
}

rest = best.rest;
writeFileSync('public/ditto-rest.bin', Buffer.from(rest.buffer, rest.byteOffset, rest.byteLength));
writeFileSync('public/ditto-rest.json', JSON.stringify({
  bakedFor: { shear: SHEAR, bulk: opts.bulk, gravity: probeBody.params.gravity,
              substep: probeBody.params.substep, iterations: probeBody.params.iterations },
  rounds: ROUNDS, keptRound: best.round, relax: RELAX, nodeCount: rest.length / 3,
  residual: { worst_mm: +best.worst.toFixed(3), mean_mm: +best.mean.toFixed(3) },
  sourceHash: meta.sourceHash,
}, null, 1));
console.log(`baked public/ditto-rest.bin from round ${best.round}: worst ${best.worst.toFixed(3)} mm, mean ${best.mean.toFixed(3)} mm`);
