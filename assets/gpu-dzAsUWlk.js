const U=({nodeCount:F,tetCount:t,colourCount:m})=>{const f=F,e=t,r=m;return`
const THREADS : u32 = 128u;
const NODES   : u32 = ${f}u;
const TETS    : u32 = ${e}u;
const COLOURS : u32 = ${r}u;

// state: x | velocity | invMass
const V_OFF  : u32 = ${3*f}u;
const IM_OFF : u32 = ${6*f}u;
// topo: tets | colourOffsets | colourElements
const CO_OFF : u32 = ${4*e}u;
const CE_OFF : u32 = ${4*e+r+1}u;
// elem: dmInv | restVolume | lambdaDev | lambdaHyd
const RV_OFF : u32 = ${9*e}u;
const LD_OFF : u32 = ${10*e}u;
const LH_OFF : u32 = ${11*e}u;

struct Params {
  h : f32, h2 : f32, gravity : f32, alphaDev : f32,
  alphaHyd : f32, restPressure : f32, decay : f32, maxTravel : f32,
  iterations : u32, substeps : u32, pad0 : u32, pad1 : u32,
};

@group(0) @binding(0) var<storage, read_write> state : array<f32>;
@group(0) @binding(1) var<storage, read>       topo  : array<u32>;
@group(0) @binding(2) var<storage, read_write> elem  : array<f32>;
@group(0) @binding(3) var<uniform>             P     : Params;

var<workgroup> wp : array<f32, ${3*f}>;

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

@compute @workgroup_size(128)
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
`};async function R(F,t,m){const f=await navigator.gpu.requestAdapter();if(!f)throw new Error("no WebGPU adapter");const e=await f.requestDevice(),r=t.params,c=t.nodeCount,s=t.tetCount,w=m.colourCount,v=new Float32Array(7*c),h=new Uint32Array(5*s+w+1),y=new Float32Array(12*s),p=3*c,d=6*c,u=4*s,g=4*s+w+1,n=9*s;v.set(t.x,0),v.set(t.velocity,p),v.set(t.invMass,d),h.set(t.tets,0),h.set(m.offsets,u),h.set(m.elements,g),y.set(t.DmInv,0),y.set(t.restVolume,n);const P=(a,i)=>{const O=e.createBuffer({size:a.byteLength,usage:i|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});return e.queue.writeBuffer(O,0,a),O},C=P(v,GPUBufferUsage.STORAGE),x=P(h,GPUBufferUsage.STORAGE),E=P(y,GPUBufferUsage.STORAGE),j=new ArrayBuffer(48),o=new Float32Array(j),l=new Uint32Array(j),S=e.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),T=a=>{const i=r.substep;o[0]=i,o[1]=i*i,o[2]=r.gravity,o[3]=1/r.shear,o[4]=1/r.bulk,o[5]=r.shear/r.bulk,o[6]=Math.exp(-r.damping*.35*i),o[7]=r.maxTravel,l[8]=r.iterations,l[9]=a,e.queue.writeBuffer(S,0,j)},B=e.createShaderModule({code:U({nodeCount:c,tetCount:s,colourCount:w})}),D=(await B.getCompilationInfo()).messages.filter(a=>a.type==="error");if(D.length)throw new Error("shader: "+D.map(a=>`${a.lineNum}: ${a.message}`).join(" | "));e.pushErrorScope("validation");const k=e.createComputePipeline({layout:"auto",compute:{module:B,entryPoint:"main"}}),A=e.createBindGroup({layout:k.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:C}},{binding:1,resource:{buffer:x}},{binding:2,resource:{buffer:E}},{binding:3,resource:{buffer:S}}]}),M=await e.popErrorScope();if(M)throw new Error("pipeline: "+M.message);const _=e.createBuffer({size:3*c*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});return{device:e,step:a=>{T(a);const i=e.createCommandEncoder(),O=i.beginComputePass();O.setPipeline(k),O.setBindGroup(0,A),O.dispatchWorkgroups(1),O.end(),e.queue.submit([i.finish()])},readPositions:async()=>{const a=e.createCommandEncoder();a.copyBufferToBuffer(C,0,_,0,3*c*4),e.queue.submit([a.finish()]),await _.mapAsync(GPUMapMode.READ);const i=new Float32Array(_.getMappedRange().slice(0));return _.unmap(),i},uploadState:()=>{e.queue.writeBuffer(C,0,Float32Array.from(t.x)),e.queue.writeBuffer(C,p*4,Float32Array.from(t.velocity))},colourCount:w,threads:128,storageBuffers:3}}async function V(F,t,m,f){const e={substep:.0020833333333333333,iterations:2,gravity:0,floor:-10,uprightGain:0,viscousTau:0,shapeCompliance:0},r=d=>{for(let u=0;u<d.nodeCount;u++){const g=u*3,n=1+.06*Math.sin(u*1.7);d.x[g]*=n,d.x[g+1]*=n,d.x[g+2]*=n}},c=t(F,e),s=m(c.tets,c.nodeCount),w=f(c.tets,s),v={...e,elementOrder:s.elements},h=async d=>{const u=t(F,v),g=t(F,v);r(u),r(g);const n=await R(F,g,s);n.uploadState();const P=performance.now();for(let l=0;l<d;l++)u.step(e.substep);const C=performance.now()-P,x=performance.now();n.step(d),await n.device.queue.onSubmittedWorkDone();const E=performance.now()-x,j=await n.readPositions();let o=0;for(let l=0;l<u.x.length;l++)o=Math.max(o,Math.abs(j[l]-u.x[l]));return n.device.destroy(),{cpuMs:C,gpuMs:E,worst:o}},y=await h(1),p=await h(480);return{colours:s.colourCount,colouringOk:w.ok,largestColour:w.largestColour,oneStepDivergenceUm:+(y.worst*1e6).toFixed(4),at480StepsDivergenceMm:+(p.worst*1e3).toFixed(2),cpuMs480:+p.cpuMs.toFixed(1),gpuMs480:+p.gpuMs.toFixed(1),speedup:+(p.cpuMs/p.gpuMs).toFixed(2),storageBuffers:3}}export{V as benchGpu,R as createGpuSolver};
