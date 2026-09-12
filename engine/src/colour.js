// Gauss-Seidel over elements is sequential: two tets sharing a node must not be
// projected at the same time. Colour the tet adjacency graph, then each colour
// is one conflict-free compute dispatch.

export function colourElements(tets, nodeCount) {
  const tetCount = tets.length / 4;

  // node -> tets, built as CSR so the hot loop touches no arrays of arrays
  const degree = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < tets.length; i++) degree[tets[i] + 1]++;
  for (let i = 0; i < nodeCount; i++) degree[i + 1] += degree[i];
  const start = degree;
  const nodeTets = new Uint32Array(tets.length);
  const cursor = Uint32Array.from(start.subarray(0, nodeCount));
  for (let t = 0; t < tetCount; t++)
    for (let k = 0; k < 4; k++) nodeTets[cursor[tets[t * 4 + k]]++] = t;

  const colour = new Int32Array(tetCount).fill(-1);
  const taken = new Uint8Array(64);
  let colourCount = 0;

  // Largest-degree-first keeps the colour count near the lower bound.
  const order = Array.from({ length: tetCount }, (_, t) => t);
  const neighbourCount = new Uint32Array(tetCount);
  for (let t = 0; t < tetCount; t++) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const node = tets[t * 4 + k];
      n += start[node + 1] - start[node];
    }
    neighbourCount[t] = n;
  }
  order.sort((a, b) => neighbourCount[b] - neighbourCount[a]);

  for (const t of order) {
    taken.fill(0);
    for (let k = 0; k < 4; k++) {
      const node = tets[t * 4 + k];
      for (let s = start[node]; s < start[node + 1]; s++) {
        const c = colour[nodeTets[s]];
        if (c >= 0 && c < taken.length) taken[c] = 1;
      }
    }
    let c = 0;
    while (c < taken.length && taken[c]) c++;
    colour[t] = c;
    if (c + 1 > colourCount) colourCount = c + 1;
  }

  // group tets by colour into one flat index buffer plus offsets
  const sizes = new Uint32Array(colourCount);
  for (let t = 0; t < tetCount; t++) sizes[colour[t]]++;
  const offsets = new Uint32Array(colourCount + 1);
  for (let c = 0; c < colourCount; c++) offsets[c + 1] = offsets[c] + sizes[c];
  const order2 = new Uint32Array(tetCount);
  const fill = Uint32Array.from(offsets.subarray(0, colourCount));
  for (let t = 0; t < tetCount; t++) order2[fill[colour[t]]++] = t;

  return { colourCount, offsets, elements: order2, colour };
}

// Every colour must be conflict free, or the parallel solve is silently wrong.
export function verifyColouring(tets, { colourCount, offsets, elements }) {
  const seen = new Int32Array(tets.length ? Math.max(...tets) + 1 : 0).fill(-1);
  let worst = 0;
  for (let c = 0; c < colourCount; c++) {
    for (let i = offsets[c]; i < offsets[c + 1]; i++) {
      const t = elements[i];
      for (let k = 0; k < 4; k++) {
        const node = tets[t * 4 + k];
        if (seen[node] === c) return { ok: false, colour: c, node };
        seen[node] = c;
      }
    }
    worst = Math.max(worst, offsets[c + 1] - offsets[c]);
  }
  return { ok: true, largestColour: worst };
}
