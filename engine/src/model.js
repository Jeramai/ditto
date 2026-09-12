const TYPES = { Float32Array, Float64Array, Uint32Array, Uint16Array };

export async function loadModel(base = './') {
  const meta = await (await fetch(base + 'ditto-model.json')).json();
  const bin = await (await fetch(base + 'ditto-model.bin')).arrayBuffer();
  const parts = {};
  for (const [name, { offset, length, type }] of Object.entries(meta.layout)) {
    parts[name] = new TYPES[type](bin, offset, length);
  }
  const model = { ...meta, ...parts, surfaceTarget: parts.positions };

  // The cage can be baked pre-deformed so that gravity settles him onto the
  // model's own silhouette instead of below it. bake_rest.mjs solves for it, and
  // the material it was solved for has to match or the compensation is wrong.
  //
  // The bake is optional and is currently parked, so ask the manifest whether it
  // exists rather than probing for it: fetching a file that is not there logs a
  // 404 on every single page load.
  try {
    const rest = meta.restBake ? await fetch(base + 'ditto-rest.json') : { ok: false };
    if (rest.ok) {
      const info = await rest.json();
      const bytes = await (await fetch(base + 'ditto-rest.bin')).arrayBuffer();
      if (info.nodeCount * 3 === parts.particles.length && info.sourceHash === meta.sourceHash) {
        model.particles = new Float64Array(bytes);
        model.restBake = info;
      }
    }
  } catch {}
  return model;
}
