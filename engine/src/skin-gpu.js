// skin.js on the GPU: only the cage crosses the bus, and the grab skins on demand.
import * as THREE from 'three/webgpu';
import { Fn, storage, instanceIndex, float, vec3, vec4, If, Loop } from 'three/tsl';

export function createSkinGpu(model, body, renderer) {
  const vertexCount = model.positions.length / 3;
  const indices = model.indices;
  const triangleCount = indices.length / 3;
  const ids = model.bindingIds, w = model.bindingWeights;
  const twin = model.normalTwin || new Uint32Array(0);
  const nodeCount = body.nodeCount;

  // gather, not scatter: WGSL has no float atomic, so a vertex walks its own triangles
  const valence = new Uint32Array(vertexCount);
  for (let i = 0; i < indices.length; i++) valence[indices[i]]++;
  const adjOffset = new Uint32Array(vertexCount + 1);
  for (let v = 0; v < vertexCount; v++) adjOffset[v + 1] = adjOffset[v] + valence[v];
  const adjList = new Uint32Array(indices.length);
  const cursor = adjOffset.slice(0, vertexCount);
  for (let t = 0; t < triangleCount; t++) {
    for (let k = 0; k < 3; k++) adjList[cursor[indices[t * 3 + k]]++] = t;
  }

  // both sides of a twin sum the same pair, so they land on one value with no copy pass
  const partner = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) partner[v] = v;
  for (let i = 0; i < twin.length; i += 2) {
    partner[twin[i]] = twin[i + 1];
    partner[twin[i + 1]] = twin[i];
  }

  const flat = (arr, type) => new THREE.StorageBufferAttribute(arr, 1, type);

  // stride 4 where the CPU writes: three pads itemSize 3 and swaps the array out
  const nodeArray = new Float32Array(nodeCount * 4);
  const nodeAttr = new THREE.StorageBufferAttribute(nodeArray, 4);

  const bindIdArray = new Uint32Array(vertexCount * 4);
  bindIdArray.set(model.bindingIds);
  const bindWArray = new Float32Array(vertexCount * 4);
  bindWArray.set(model.bindingWeights);

  // the GPU alone writes these, so three is free to pad them
  const positionAttr = new THREE.StorageBufferAttribute(new Float32Array(vertexCount * 3), 3);
  const normalAttr = new THREE.StorageBufferAttribute(new Float32Array(vertexCount * 3), 3);
  const rawAttr = new THREE.StorageBufferAttribute(new Float32Array(vertexCount * 4), 4);

  const nodes = storage(nodeAttr, 'vec4', nodeCount).toReadOnly();
  const bindId = storage(flat(bindIdArray, Uint32Array), 'uint', vertexCount * 4).toReadOnly();
  const bindW = storage(flat(bindWArray, Float32Array), 'float', vertexCount * 4).toReadOnly();
  const tri = storage(flat(Uint32Array.from(indices), Uint32Array), 'uint', indices.length).toReadOnly();
  const adjOff = storage(flat(adjOffset, Uint32Array), 'uint', vertexCount + 1).toReadOnly();
  const adj = storage(flat(adjList, Uint32Array), 'uint', adjList.length).toReadOnly();
  const mate = storage(flat(partner, Uint32Array), 'uint', vertexCount).toReadOnly();
  const skinned = storage(positionAttr, 'vec3', vertexCount);
  const outRaw = storage(rawAttr, 'vec4', vertexCount);
  const outNrm = storage(normalAttr, 'vec3', vertexCount);

  const at = (v) => skinned.element(v);

  const skinPass = Fn(() => {
    const v = instanceIndex;
    const b = v.mul(4);
    const p = vec3(0).toVar();
    Loop({ start: 0, end: 4, condition: '<' }, ({ i }) => {
      const n = nodes.element(bindId.element(b.add(i)));
      p.addAssign(vec3(n.x, n.y, n.z).mul(bindW.element(b.add(i))));
    });
    skinned.element(v).assign(p);
  })().compute(vertexCount);

  const normalPass = Fn(() => {
    const v = instanceIndex;
    const acc = vec3(0).toVar();
    const from = adjOff.element(v).toVar();
    const to = adjOff.element(v.add(1)).toVar();
    Loop({ start: from, end: to, condition: '<' }, ({ i }) => {
      const t = adj.element(i).mul(3);
      const a = at(tri.element(t));
      const e1 = at(tri.element(t.add(1))).sub(a);
      const e2 = at(tri.element(t.add(2))).sub(a);
      acc.addAssign(e1.cross(e2));
    });
    outRaw.element(v).assign(vec4(acc, 0));
  })().compute(vertexCount);

  const foldPass = Fn(() => {
    const v = instanceIndex;
    const own = outRaw.element(v);
    const other = outRaw.element(mate.element(v));
    const sum = vec3(own.x, own.y, own.z).add(vec3(other.x, other.y, other.z)).toVar();
    const len = sum.length().toVar();
    const out = sum.toVar();
    // skin.js leaves a zero normal alone rather than dividing by nothing
    If(len.greaterThan(float(0)), () => { out.assign(sum.div(len)); });
    outNrm.element(v).assign(out);
  })().compute(vertexCount);

  const { x } = body;

  const update = () => {
    for (let i = 0, o = 0, j = 0; i < nodeCount; i++, o += 4, j += 3) {
      nodeArray[o] = x[j]; nodeArray[o + 1] = x[j + 1]; nodeArray[o + 2] = x[j + 2];
    }
    nodeAttr.needsUpdate = true;
    renderer.compute(skinPass);
    renderer.compute(normalPass);
    renderer.compute(foldPass);
  };

  // the grab raycasts a CPU surface: skin it on the click, not every frame
  const positions = new Float32Array(vertexCount * 3);
  positions.set(model.positions);
  const skinForPick = () => {
    for (let v = 0; v < vertexCount; v++) {
      const b = v * 4, o = v * 3;
      let px = 0, py = 0, pz = 0;
      for (let k = 0; k < 4; k++) {
        const wk = w[b + k], j = ids[b + k] * 3;
        px += wk * x[j]; py += wk * x[j + 1]; pz += wk * x[j + 2];
      }
      positions[o] = px; positions[o + 1] = py; positions[o + 2] = pz;
    }
  };

  return {
    positions, indices, vertexCount, update, skinForPick,
    positionAttribute: positionAttr, normalAttribute: normalAttr,
    readBackNormals: async () => new Float32Array(await renderer.getArrayBufferAsync(normalAttr)),
    readBackPositions: async () => new Float32Array(await renderer.getArrayBufferAsync(positionAttr)),
  };
}
