// Surface skinning. Positions come from the four barycentric weights per vertex.
// Normals are accumulated from the deformed triangles: a per-element gradient is
// cheaper but constant across each element, and the seams between elements read
// as blotches once he deforms.

export function createSkin(model, body) {
  const vertexCount = model.positions.length / 3;
  const positions = new Float32Array(model.positions.length);
  const normals = new Float32Array(model.normals.length);
  const indices = model.indices;
  const triangleCount = indices.length / 3;
  const ids = model.bindingIds, w = model.bindingWeights;
  const twin = model.normalTwin || new Uint32Array(0);
  const { x } = body;

  const update = () => {
    for (let v = 0; v < vertexCount; v++) {
      const b = v * 4, o = v * 3;
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < 4; k++) {
        const wk = w[b + k], j = ids[b + k] * 3;
        px += wk * x[j]; py += wk * x[j + 1]; pz += wk * x[j + 2];
      }
      positions[o] = px; positions[o + 1] = py; positions[o + 2] = pz;
    }

    normals.fill(0);
    for (let t = 0; t < triangleCount; t++) {
      const i = t * 3;
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
      const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
      const e2x = positions[c] - ax, e2y = positions[c + 1] - ay, e2z = positions[c + 2] - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
      normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
      normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
    }
    // A vertex duplicated to carry a second colour must not shade as its own
    // surface, or the mouth outline reads as a crease. Sum the copies, then
    // share the result back.
    for (let i = 0; i < twin.length; i += 2) {
      const d = twin[i] * 3, m = twin[i + 1] * 3;
      normals[m] += normals[d]; normals[m + 1] += normals[d + 1]; normals[m + 2] += normals[d + 2];
    }
    for (let v = 0; v < vertexCount; v++) {
      const o = v * 3;
      const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
      if (len > 0) { normals[o] /= len; normals[o + 1] /= len; normals[o + 2] /= len; }
    }
    for (let i = 0; i < twin.length; i += 2) {
      const d = twin[i] * 3, m = twin[i + 1] * 3;
      normals[d] = normals[m]; normals[d + 1] = normals[m + 1]; normals[d + 2] = normals[m + 2];
    }
  };

  positions.set(model.positions);
  normals.set(model.normals);
  return { positions, normals, indices, vertexCount, update };
}
