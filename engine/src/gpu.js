// The elastic solver as one compute dispatch per frame.
//
// NOT the live solver, on purpose. This covers the neo-Hookean pair and the
// integration only: no contacts, friction, grab, righting reflex, inversion
// rescue or viscosity, which is every interaction in softbody.js. Swapping it
// in would trade all of that for throughput the app does not need, since the
// CPU step is 2.5 ms of a 8.3 ms frame. It would also have to read positions
// back each frame for skin.js, and that map is the stall the dispatch saves.
// It also does not yet reproduce the CPU solver. With both structural fixes
// applied and the sweep order matched it agrees to 0.57 mm over 480 substeps
// and 0.62 mm over one, which is far above f32 rounding on a 40 mm body. The
// residual is unattributed, so treat this as an unverified reference and not a
// second opinion. Run it with ?gpu=bench.
//
// Colour-per-dispatch is the obvious port and it is the wrong one: 29 colours x
// 2 iterations x 480 Hz is 27,840 dispatches a second, each holding about 98
// tets of work, so dispatch overhead swamps the solve. Instead the whole substep
// loop lives inside a single workgroup and uses workgroupBarrier() between
// colours. Predicted positions sit in workgroup storage: 8,736 bytes, inside the
// 16 KB that WebGPU guarantees.
//
// Buffers are packed into three because a shader stage is only guaranteed eight
// storage bindings, and the unpacked form needed eleven.

const THREADS = 128;

const shader = ({ nodeCount, tetCount, colourCount }) => {
  const N = nodeCount, T = tetCount, C = colourCount;
  return /* wgsl */ `
const THREADS : u32 = ${THREADS}u;
const NODES   : u32 = ${N}u;
const TETS    : u32 = ${T}u;
const COLOURS : u32 = ${C}u;

// state: x | velocity | invMass
const V_OFF  : u32 = ${3 * N}u;
const IM_OFF : u32 = ${6 * N}u;
// topo: tets | colourOffsets | colourElements
const CO_OFF : u32 = ${4 * T}u;
const CE_OFF : u32 = ${4 * T + C + 1}u;
// elem: dmInv | restVolume | lambdaDev | lambdaHyd
const RV_OFF : u32 = ${9 * T}u;
const LD_OFF : u32 = ${10 * T}u;
const LH_OFF : u32 = ${11 * T}u;

struct Params {
  h : f32, h2 : f32, gravity : f32, alphaDev : f32,
  alphaHyd : f32, restPressure : f32, decay : f32, maxTravel : f32,
  iterations : u32, substeps : u32, pad0 : u32, pad1 : u32,
};

@group(0) @binding(0) var<storage, read_write> state : array<f32>;
@group(0) @binding(1) var<storage, read>       topo  : array<u32>;
@group(0) @binding(2) var<storage, read_write> elem  : array<f32>;
@group(0) @binding(3) var<uniform>             P     : Params;

var<workgroup> wp : array<f32, ${3 * N}>;

fn solveElement(t : u32) {
  let o = t * 4u;
  let i0 = topo[o]; let i1 = topo[o + 1u]; let i2 = topo[o + 2u]; let i3 = topo[o + 3u];
  let n0 = i0 * 3u; let n1 = i1 * 3u; let n2 = i2 * 3u; let n3 = i3 * 3u;
  let a = t * 9u;

  let V = elem[RV_OFF + t];
  let w0 = state[IM_OFF + i0];
  let w1 = state[IM_OFF + i1];
  let w2 = state[IM_OFF + i2];
  let w3 = state[IM_OFF + i3];

  for (var phase = 0u; phase < 2u; phase = phase + 1u) {
    // Rebuild F per phase. The deviatoric solve has already moved wp, so
    // reusing the pre-deviatoric F makes the hydrostatic solve answer the wrong
    // question. Same trap as softbody.js.
    var F : array<f32, 9>;
    for (var r = 0u; r < 3u; r = r + 1u) {
      let c1 = wp[n1 + r] - wp[n0 + r];
      let c2 = wp[n2 + r] - wp[n0 + r];
      let c3 = wp[n3 + r] - wp[n0 + r];
      F[r * 3u]      = c1 * elem[a]      + c2 * elem[a + 3u] + c3 * elem[a + 6u];
      F[r * 3u + 1u] = c1 * elem[a + 1u] + c2 * elem[a + 4u] + c3 * elem[a + 7u];
      F[r * 3u + 2u] = c1 * elem[a + 2u] + c2 * elem[a + 5u] + c3 * elem[a + 8u];
    }

    var C4 : f32;
    var alpha : f32;
    var dCdF : array<f32, 9>;

    if (phase == 0u) {
      var sq = 0.0;
      for (var k = 0u; k < 9u; k = k + 1u) { sq = sq + F[k] * F[k]; }
      let norm = sqrt(sq);
      if (norm < 1e-12) { continue; }
      C4 = norm;
      let s = 1.0 / norm;
      for (var k = 0u; k < 9u; k = k + 1u) { dCdF[k] = F[k] * s; }
      alpha = P.alphaDev / V;
    } else {
      let f00 = F[0]; let f01 = F[1]; let f02 = F[2];
      let f10 = F[3]; let f11 = F[4]; let f12 = F[5];
      let f20 = F[6]; let f21 = F[7]; let f22 = F[8];
      let c0x = f11 * f22 - f12 * f21;
      let c0y = f12 * f20 - f10 * f22;
      let c0z = f10 * f21 - f11 * f20;
      let c1x = f21 * f02 - f22 * f01;
      let c1y = f22 * f00 - f20 * f02;
      let c1z = f20 * f01 - f21 * f00;
      let c2x = f01 * f12 - f02 * f11;
      let c2y = f02 * f10 - f00 * f12;
      let c2z = f00 * f11 - f01 * f10;
      let det = f00 * c0x + f10 * c1x + f20 * c2x;
      // cofactor matrix, row major like F; see the note in softbody.js
      dCdF[0] = c0x; dCdF[1] = c0y; dCdF[2] = c0z;
      dCdF[3] = c1x; dCdF[4] = c1y; dCdF[5] = c1z;
      dCdF[6] = c2x; dCdF[7] = c2y; dCdF[8] = c2z;
      C4 = det - 1.0 - P.restPressure;
      alpha = P.alphaHyd / V;
    }

    var grad : array<f32, 12>;
    for (var r = 0u; r < 3u; r = r + 1u) {
      let r0 = dCdF[r * 3u];
      let r1 = dCdF[r * 3u + 1u];
      let r2 = dCdF[r * 3u + 2u];
      let g1 = r0 * elem[a]      + r1 * elem[a + 1u] + r2 * elem[a + 2u];
      let g2 = r0 * elem[a + 3u] + r1 * elem[a + 4u] + r2 * elem[a + 5u];
      let g3 = r0 * elem[a + 6u] + r1 * elem[a + 7u] + r2 * elem[a + 8u];
      grad[3u + r] = g1; grad[6u + r] = g2; grad[9u + r] = g3;
      grad[r] = -(g1 + g2 + g3);
    }

    var denom = 0.0;
    denom = denom + w0 * (grad[0] * grad[0] + grad[1] * grad[1] + grad[2] * grad[2]);
    denom = denom + w1 * (grad[3] * grad[3] + grad[4] * grad[4] + grad[5] * grad[5]);
    denom = denom + w2 * (grad[6] * grad[6] + grad[7] * grad[7] + grad[8] * grad[8]);
    denom = denom + w3 * (grad[9] * grad[9] + grad[10] * grad[10] + grad[11] * grad[11]);
    let at = alpha / P.h2;
    if (denom + at < 1e-20) { continue; }

    var slot = LD_OFF + t;
    if (phase == 1u) { slot = LH_OFF + t; }
    let lam = elem[slot];
    let dl = (-C4 - at * lam) / (denom + at);
    elem[slot] = lam + dl;

    for (var r = 0u; r < 3u; r = r + 1u) {
      wp[n0 + r] = wp[n0 + r] + w0 * dl * grad[r];
      wp[n1 + r] = wp[n1 + r] + w1 * dl * grad[3u + r];
      wp[n2 + r] = wp[n2 + r] + w2 * dl * grad[6u + r];
      wp[n3 + r] = wp[n3 + r] + w3 * dl * grad[9u + r];
    }
  }
}

@compute @workgroup_size(${THREADS})
fn main(@builtin(local_invocation_index) tid : u32) {
  for (var s = 0u; s < P.substeps; s = s + 1u) {
    for (var i = tid; i < NODES; i = i + THREADS) {
      let j = i * 3u;
      if (state[IM_OFF + i] == 0.0) {
        wp[j] = state[j]; wp[j + 1u] = state[j + 1u]; wp[j + 2u] = state[j + 2u];
      } else {
        let vy = state[V_OFF + j + 1u] - P.gravity * P.h;
        state[V_OFF + j + 1u] = vy;
        wp[j]      = state[j]      + state[V_OFF + j] * P.h;
        wp[j + 1u] = state[j + 1u] + vy * P.h;
        wp[j + 2u] = state[j + 2u] + state[V_OFF + j + 2u] * P.h;
      }
    }
    for (var t = tid; t < TETS; t = t + THREADS) {
      elem[LD_OFF + t] = 0.0;
      elem[LH_OFF + t] = 0.0;
    }
    workgroupBarrier();

    for (var it = 0u; it < P.iterations; it = it + 1u) {
      for (var c = 0u; c < COLOURS; c = c + 1u) {
        let lo = topo[CO_OFF + c];
        let hi = topo[CO_OFF + c + 1u];
        for (var i = lo + tid; i < hi; i = i + THREADS) {
          solveElement(topo[CE_OFF + i]);
        }
        workgroupBarrier();
      }
    }

    if (P.maxTravel > 0.0) {
      let cap = P.maxTravel;
      for (var i = tid; i < NODES; i = i + THREADS) {
        let j = i * 3u;
        let dx = wp[j] - state[j];
        let dy = wp[j + 1u] - state[j + 1u];
        let dz = wp[j + 2u] - state[j + 2u];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cap * cap) {
          let sc = cap / sqrt(d2);
          wp[j]      = state[j]      + dx * sc;
          wp[j + 1u] = state[j + 1u] + dy * sc;
          wp[j + 2u] = state[j + 2u] + dz * sc;
        }
      }
      workgroupBarrier();
    }

    let invH = 1.0 / P.h;
    for (var i = tid; i < NODES; i = i + THREADS) {
      if (state[IM_OFF + i] == 0.0) { continue; }
      let j = i * 3u;
      for (var r = 0u; r < 3u; r = r + 1u) {
        state[V_OFF + j + r] = (wp[j + r] - state[j + r]) * invH * P.decay;
        state[j + r] = wp[j + r];
      }
    }
    workgroupBarrier();
  }
}
`;
};

export async function createGpuSolver(model, body, colouring) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const device = await adapter.requestDevice();
  const P = body.params;
  const N = body.nodeCount, T = body.tetCount, C = colouring.colourCount;

  const state = new Float32Array(7 * N);
  const topo = new Uint32Array(5 * T + C + 1);
  const elem = new Float32Array(12 * T);
  const V_OFF = 3 * N, IM_OFF = 6 * N;
  const CO_OFF = 4 * T, CE_OFF = 4 * T + C + 1;
  const RV_OFF = 9 * T, LD_OFF = 10 * T;

  state.set(body.x, 0);
  state.set(body.velocity, V_OFF);
  state.set(body.invMass, IM_OFF);
  topo.set(body.tets, 0);
  topo.set(colouring.offsets, CO_OFF);
  topo.set(colouring.elements, CE_OFF);
  elem.set(body.DmInv, 0);
  elem.set(body.restVolume, RV_OFF);

  const make = (data, usage) => {
    const b = device.createBuffer({ size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const stateBuffer = make(state, GPUBufferUsage.STORAGE);
  const topoBuffer = make(topo, GPUBufferUsage.STORAGE);
  const elemBuffer = make(elem, GPUBufferUsage.STORAGE);

  const paramsData = new ArrayBuffer(48);
  const pf = new Float32Array(paramsData), pu = new Uint32Array(paramsData);
  const paramsBuffer = device.createBuffer({ size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const writeParams = (substeps) => {
    const h = P.substep;
    pf[0] = h; pf[1] = h * h; pf[2] = P.gravity;
    pf[3] = 1 / P.shear; pf[4] = 1 / P.bulk; pf[5] = P.shear / P.bulk;
    pf[6] = Math.exp(-P.damping * 0.35 * h); pf[7] = P.maxTravel;
    pu[8] = P.iterations; pu[9] = substeps;
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);
  };

  const module = device.createShaderModule({
    code: shader({ nodeCount: N, tetCount: T, colourCount: C }) });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(m => m.type === 'error');
  if (errors.length) throw new Error('shader: ' + errors.map(m => `${m.lineNum}: ${m.message}`).join(' | '));

  device.pushErrorScope('validation');
  const pipeline = device.createComputePipeline({ layout: 'auto',
    compute: { module, entryPoint: 'main' } });
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: topoBuffer } },
      { binding: 2, resource: { buffer: elemBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
    ] });
  const setupError = await device.popErrorScope();
  if (setupError) throw new Error('pipeline: ' + setupError.message);

  const readBuffer = device.createBuffer({ size: 3 * N * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const step = (substeps) => {
    writeParams(substeps);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([enc.finish()]);
  };

  const readPositions = async () => {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(stateBuffer, 0, readBuffer, 0, 3 * N * 4);
    device.queue.submit([enc.finish()]);
    await readBuffer.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    return out;
  };

  const uploadState = () => {
    device.queue.writeBuffer(stateBuffer, 0, Float32Array.from(body.x));
    device.queue.writeBuffer(stateBuffer, V_OFF * 4, Float32Array.from(body.velocity));
  };

  return { device, step, readPositions, uploadState,
           colourCount: C, threads: THREADS, storageBuffers: 3 };
}

// Reproduces the claim behind this file: same state, same element order, no
// contacts. Gravity off and the floor out of reach, so only the elastic pair
// runs and the two solvers are comparable.
//
// Divergence is reported at one substep and at 480, and both are larger than
// f32 rounding explains. Two fixes already landed against this harness: F is
// now rebuilt per constraint phase (62.18 -> 5.79 mm at 480 steps) and the CPU
// sweeps the colour order the dispatch uses (5.79 -> 0.57 mm). What remains is
// not accounted for.
export async function benchGpu(model, createSoftBody, colourElements, verifyColouring) {
  const opts = { substep: 1 / 480, iterations: 2, gravity: 0, floor: -10,
                 uprightGain: 0, viscousTau: 0, shapeCompliance: 0 };
  const stretch = (b) => {
    for (let i = 0; i < b.nodeCount; i++) {
      const j = i * 3, k = 1 + 0.06 * Math.sin(i * 1.7);
      b.x[j] *= k; b.x[j + 1] *= k; b.x[j + 2] *= k;
    }
  };
  const probe = createSoftBody(model, opts);
  const colouring = colourElements(probe.tets, probe.nodeCount);
  const check = verifyColouring(probe.tets, colouring);
  // Gauss-Seidel depends on sweep order, so the CPU has to visit the elements in
  // the same colour order the dispatch does or the two answer different questions.
  const matched = { ...opts, elementOrder: colouring.elements };

  const run = async (steps) => {
    const cpu = createSoftBody(model, matched);
    const gpuBody = createSoftBody(model, matched);
    stretch(cpu); stretch(gpuBody);
    const solver = await createGpuSolver(model, gpuBody, colouring);
    solver.uploadState();
    const tc = performance.now();
    for (let i = 0; i < steps; i++) cpu.step(opts.substep);
    const cpuMs = performance.now() - tc;
    const tg = performance.now();
    solver.step(steps);
    await solver.device.queue.onSubmittedWorkDone();
    const gpuMs = performance.now() - tg;
    const out = await solver.readPositions();
    let worst = 0;
    for (let i = 0; i < cpu.x.length; i++) worst = Math.max(worst, Math.abs(out[i] - cpu.x[i]));
    solver.device.destroy();
    return { cpuMs, gpuMs, worst };
  };

  const one = await run(1);
  const many = await run(480);
  return {
    colours: colouring.colourCount,
    colouringOk: check.ok, largestColour: check.largestColour,
    oneStepDivergenceUm: +(one.worst * 1e6).toFixed(4),
    at480StepsDivergenceMm: +(many.worst * 1e3).toFixed(2),
    cpuMs480: +many.cpuMs.toFixed(1), gpuMs480: +many.gpuMs.toFixed(1),
    speedup: +(many.cpuMs / many.gpuMs).toFixed(2),
    storageBuffers: 3,
  };
}
