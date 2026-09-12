import * as THREE from 'three/webgpu';
import { attribute, mix, vec3, float, oneMinus } from 'three/tsl';
import { loadModel } from './model.js';
import { createSoftBody } from './softbody.js';
import { createSkin } from './skin.js';
import { createSkinGpu } from './skin-gpu.js';
import { colourElements, verifyColouring } from './colour.js';
import { createWorld } from './world.js';
import { createLocomotion, bindScratch } from './locomotion.js';
import { createConga } from './conga.js';
import { createDisco } from './disco.js';
import { createBreath } from './breath.js';
import { createAudio } from './audio.js';
import { createSprite } from './sprite.js';
import { createUi, COARSE, REDUCED } from './ui.js';
import { createTransform } from './transform.js';
import { createEyes } from './eyes.js';

const hud = document.getElementById('hud');
const fail = document.getElementById('fail');

const DITTO = 0xc99ae2;
// the model ships a 16x16 solid black texture for the eye meshes
const FACE_INK = 0x120f16;
// The skin palette's two red entries. The tongue carries a little more blue
// than the palette's ffb2b2: inside the cavity it is lit mostly by the green
// bounce off the field, which starves the blue and renders it salmon.
const TONGUE = 0xffb2c6;
const LIP = 0x8f1010;
const SUBSTEP = 1 / 720;
const MAX_SUBSTEPS = 24;  // clamps at 30 fps of sim work, and says so in the HUD

async function main() {
  const ui = createUi();
  if (!navigator.gpu) throw new Error('This engine needs WebGPU.');
  ui.say('Unwrapping him');
  const model = await loadModel('./');
  const q = new URLSearchParams(location.search);
  const tuning = {};
  for (const key of ['shear', 'bulk', 'gravity', 'grabRadius']) {
    const v = q.get(key);
    if (v !== null) tuning[key] = Number(v);
  }
  ui.say('Building the cage');
  const baked = model.restBake?.bakedFor ?? {};
  const body = createSoftBody(model, { substep: SUBSTEP, iterations: 1, ...baked, ...tuning });
  if (model.restBake && !q.has('shear')) {
    const b = model.restBake.bakedFor;
    if (b.shear !== body.params.shear || b.gravity !== body.params.gravity)
      console.warn('rest cage was baked for different material; the sag compensation will be wrong');
  }
  const cpuSkin = createSkin(model, body);
  const restPose = Float64Array.from(body.x);

  ui.say('Starting WebGPU');
  // ?gputime=1 turns on timestamp queries, the only way to see real GPU cost
  const gpuTimed = q.has('gputime');
  const renderer = new THREE.WebGPURenderer({ antialias: true, trackTimestamp: gpuTimed });
  // A phone reports 3, and 2 already draws four times the pixels of 1.
  renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  // PCF costs seventeen depth compares a fragment and the ground fills the
  // screen, so touch takes the one-tap filter and keeps the shape. PCFSoft is
  // gone from three since r186; the constant survives and silently means PCF.
  renderer.shadowMap.type = COARSE ? THREE.BasicShadowMap : THREE.PCFShadowMap;
  // The original reads as pale sage under flat light, not a dark forest. ACES
  // crushes the pixel art palette, so keep the mapping linear.
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 0.9;
  // Inside a <main> so the page has a landmark, and described, because the
  // canvas is the entire content: a screen reader has nothing else to go on.
  renderer.domElement.setAttribute('aria-label',
    'Ditto. WASD to wander, space to jump, hold space to jump higher. '
    + 'Drag Ditto to stretch him, drag the field to orbit.');
  renderer.domElement.tabIndex = 0;
  (document.getElementById('viewport') ?? document.body).appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  // ?cpuskin=1 keeps skin.js, which is what the compute result is checked against
  const gpuSkin = q.has('cpuskin') ? null : createSkinGpu(model, body, renderer);
  const skin = gpuSkin || cpuSkin;

  const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.001, 40);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', gpuSkin ? gpuSkin.positionAttribute : new THREE.BufferAttribute(cpuSkin.positions, 3));
  geometry.setAttribute('normal', gpuSkin ? gpuSkin.normalAttribute : new THREE.BufferAttribute(cpuSkin.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(skin.indices, 1));
  // The skin png is a colour-ID table, one texel per triangle, so make_model.py
  // resolves the colour per vertex and mouthTag carries it: 1 tongue, 2 lip.
  // The body stays tintable and no texture is sampled. faceTag is the eyes.
  geometry.setAttribute('faceTag', new THREE.BufferAttribute(model.faceTag, 1));
  geometry.setAttribute('mouthTag', new THREE.BufferAttribute(model.mouthTag, 1));
  // eyeUV is derived at load, not baked: it is 64 KB and the two discs are
  // recoverable from faceTag and the rest pose.
  const eyes = createEyes(model);
  geometry.setAttribute('eyeUV', new THREE.BufferAttribute(eyes.eyeUV, 2));
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const faceMask = attribute('faceTag', 'float');
  const tag = attribute('mouthTag', 'float');
  const rgb = (hex) => vec3(...new THREE.Color(hex).toArray());
  const transform = await createTransform(scene, body);
  transform.set(DITTO);
  // The eyes are inked vertices, so the lid is a mask over them, not a texture.
  const ink = faceMask.mul(eyes.inkNode);
  material.colorNode = mix(
    mix(mix(transform.bodyNode, rgb(TONGUE), tag.min(float(1))), rgb(LIP), tag.sub(1).max(float(0))),
    rgb(FACE_INK), ink);
  material.emissiveNode = rgb(transform.spark).mul(transform.ridgeNode).mul(oneMinus(ink));
  // 0.53 not 0.42: r186 narrowed the probe's specular lobe and 0.42 blew out
  material.roughnessNode = mix(mix(float(0.53), float(0.85), tag.min(float(1))),
                               float(0.52), ink);
  // The mouth is a cavity, but nothing here occludes it, so the sky probe lit it
  // as if it faced the open sky and the pale tongue clipped to cream.
  material.aoNode = mix(float(1), float(0.30), tag.min(float(1)));
  const mesh = new THREE.Mesh(geometry, material);
  // The bounding sphere is only rebuilt for the raycast, so in the render path
  // it stays wherever he last was and culls him while the camera is pointed
  // right at him. The camera follows him, so culling this mesh never saves work.
  mesh.frustumCulled = false;
  scene.add(mesh);

  // Never rendered: it exists so the grab has a CPU surface to raycast.
  const pickMesh = gpuSkin ? new THREE.Mesh(new THREE.BufferGeometry(), material) : mesh;
  if (gpuSkin) {
    pickMesh.geometry.setAttribute('position', new THREE.BufferAttribute(gpuSkin.positions, 3));
    pickMesh.geometry.setIndex(new THREE.BufferAttribute(gpuSkin.indices, 1));
  }

  ui.say('Growing the field');
  const world = await createWorld(scene, renderer, { cheapShadows: COARSE });
  bindScratch(new THREE.Vector3());
  const locomotion = createLocomotion(body);
  const conga = createConga(locomotion, body);
  const breath = createBreath(body);
  const sprite = createSprite('./');
  const audio = createAudio('./', sprite);
  const disco = createDisco(scene, world, { reduced: REDUCED, sprite });

  const putBack = () => {
    body.x.set(restPose);
    body.velocity.fill(0);
    locomotion.reset();
    orbit.target.set(0, 0.020, 0);
  };

  let entered = false;
  ui.bind({
    onForm: (hex, form) => {
      audio.shiny = form === 'shiny';
      if (entered) transform.sweep(hex, form === 'shiny'); else transform.set(hex);
    },
    onReset: putBack,
    onSound: (on) => { audio.muted = !on; },
    onConga: (on) => {
      conga.on = on;
      disco.on = on;
      if (on) { audio.rewind(); audio.play(); } else audio.pause();
    },
    setStick: (x, z) => locomotion.setStick(x, z),
    onHoldHop: () => locomotion.hold(),
    onReleaseHop: () => locomotion.release(),
  });
  mesh.castShadow = true;
  // One tap on a 512 map stripes his own surface, and a blob has little to
  // self-shadow anyway. He still throws his shadow on the field.
  mesh.receiveShadow = !COARSE;

  // camera: orbit by drag on the ground, grab by drag on the body
  // Front on at start, so the pixel sprite the entrance shows hands over to the
  // real model in the same pose and roughly the same place on screen.
  const orbit = { yaw: 0, pitch: 0.52, dist: 0.34, target: new THREE.Vector3(0, 0.020, 0) };
  const placeCamera = () => {
    const cp = Math.cos(orbit.pitch);
    camera.position.set(
      orbit.target.x + Math.sin(orbit.yaw) * cp * orbit.dist,
      orbit.target.y + Math.sin(orbit.pitch) * orbit.dist,
      orbit.target.z + Math.cos(orbit.yaw) * cp * orbit.dist,
    );
    camera.lookAt(orbit.target);
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3();
  const hitPoint = new THREE.Vector3();
  let drag = null;

  const nearestVertex = (point, tri) => {
    let best = tri.a, bestDist = Infinity;
    for (const idx of [tri.a, tri.b, tri.c]) {
      const dx = skin.positions[idx * 3] - point.x;
      const dy = skin.positions[idx * 3 + 1] - point.y;
      const dz = skin.positions[idx * 3 + 2] - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) { bestDist = d; best = idx; }
    }
    return best;
  };

  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // The raycast rejects on the bounding volume before it looks at a triangle,
    // and these are built from the rest pose. Once he deforms or is lifted, a
    // stale volume makes him unclickable.
    if (gpuSkin) gpuSkin.skinForPick();
    pickMesh.geometry.computeBoundingSphere();
    pickMesh.geometry.computeBoundingBox();
    const hit = raycaster.intersectObject(pickMesh, false)[0];
    if (hit) {
      const vertex = nearestVertex(hit.point, hit.face);
      // Drag on the plane parallel to the screen, so screen motion maps to the
      // motion you expect: up-screen carries him up and away, which is what
      // makes a throw go where you aimed it. A vertical plane cannot express
      // "away" at all, so every forward throw came out as straight up.
      body.startGrab(vertex, [hit.point.x, hit.point.y, hit.point.z]);
      drag = { kind: 'grab', at: hit.point.clone() };
    } else {
      drag = { kind: 'orbit', x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'orbit') {
      orbit.yaw -= (e.clientX - drag.x) * 0.006;
      // Keep the distance down. The half fov is 0.314 rad, so the top of the
      // frame looks (pitch - 0.314) below horizontal and lands h/tan(that)
      // away: 5.1 m at pitch 0.34, which is past the fog and reads as a pale
      // empty band, against 1.5 m at 0.42.
      orbit.pitch = Math.max(0.42, Math.min(1.35, orbit.pitch + (e.clientY - drag.y) * 0.005));
      drag.x = e.clientX; drag.y = e.clientY;
      return;
    }
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // Re-anchor the drag plane every move, at the depth he is already held at.
    // Fixing it once at grab time looks right until the camera moves, and the
    // camera follows him: a pixel then maps to a steadily shifting world point,
    // so a slow steady drag slid him 38 px out from under the cursor.
    plane.setFromNormalAndCoplanarPoint(
      camera.getWorldDirection(planeNormal).negate(), drag.at);
    if (raycaster.ray.intersectPlane(plane, hitPoint)) {
      drag.at.copy(hitPoint);
      body.moveGrab([hitPoint.x, hitPoint.y, hitPoint.z]);
    }
  });
  const release = () => { if (drag?.kind === 'grab') body.endGrab(); drag = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const showHud = q.has('hud');
  let carry = 0, last = performance.now(), lagFrames = 0, frames = 0, tuftCount = 0;
  let simMs = 0, skinMs = 0, substepsLastSecond = 0, secondMark = last, fps = 0, shownSubsteps = 0, gpuMs = 0;

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    carry += dt;
    let steps = Math.floor(carry / SUBSTEP);
    if (steps > MAX_SUBSTEPS) { steps = MAX_SUBSTEPS; carry = 0; lagFrames++; }
    else carry -= steps * SUBSTEP;

    // The conga sets the posture the rig then springs him into, so it runs
    // first. The audio clock, not accumulated dt: a dropped frame loses a slice
    // of the bounce instead of sliding the whole dance off the beat.
    const beatClock = conga.on && audio.playing ? audio.time : undefined;
    conga.step(dt, beatClock);
    disco.step(dt, beatClock);
    if (conga.on && audio.playing) audio.spin(audio.time);
    const gait = locomotion.step(dt, camera);
    breath.step(dt);
    transform.step(dt, camera);
    eyes.step(dt);
    const tSim = performance.now();
    // The rig's posture spring integrates on the substep, not the frame: it is
    // stiff enough that a frame-sized step overshoots and inverts the crouch.
    for (let i = 0; i < steps; i++) { locomotion.posture(SUBSTEP); body.step(SUBSTEP); }
    simMs = simMs * 0.9 + (performance.now() - tSim) * 0.1;
    substepsLastSecond += steps;

    const tSkin = performance.now();
    skin.update();
    skinMs = skinMs * 0.9 + (performance.now() - tSkin) * 0.1;
    if (!gpuSkin) {
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.normal.needsUpdate = true;
    }

    // follow his centre, so hopping does not walk him out of frame and the
    // tuft field keeps generating around him
    let cx = 0, cz = 0, cm = 0;
    for (let i = 0; i < body.nodeCount; i++) {
      const m = 1 / body.invMass[i] || 0, j = i * 3;
      cx += m * body.x[j]; cz += m * body.x[j + 2]; cm += m;
    }
    // Not while he is held. Chasing him then moves the camera under the cursor,
    // which is half of why a drag drifted, and the view should stay put while
    // you are playing with him anyway.
    if (cm > 0 && !body.grabbing) {
      const follow = Math.min(1, 6 * dt);
      orbit.target.x += (cx / cm - orbit.target.x) * follow;
      orbit.target.z += (cz / cm - orbit.target.z) * follow;
    }
    placeCamera();
    world.follow(orbit.target);
    tuftCount = world.updateTufts(orbit.target,
      { x: cx / (cm || 1), z: cz / (cm || 1), grounded: gait.grounded });
    renderer.render(scene, camera);

    frames++;
    if (now - secondMark >= 1000) {
      fps = frames * 1000 / (now - secondMark);
      shownSubsteps = substepsLastSecond * 1000 / (now - secondMark);
      if (gpuTimed) renderer.resolveTimestampsAsync('render')
        .then((v) => { if (typeof v === 'number') gpuMs = v; }).catch(() => {});
      frames = 0; substepsLastSecond = 0; secondMark = now;
    }
    // Only when it is on screen. Five template strings a frame is real garbage
    // to collect, and the readout is hidden unless ?hud=1 asks for it.
    if (showHud) {
      hud.textContent =
        `${fps.toFixed(0)} fps   sim ${simMs.toFixed(2)} ms   skin ${skinMs.toFixed(2)} ms\n` +
        `substeps/s ${shownSubsteps.toFixed(0)} of ${(1/SUBSTEP).toFixed(0)}` +
        `   per frame ${(shownSubsteps / Math.max(fps, 1)).toFixed(1)}` +
        `${gpuMs ? `   gpu ${gpuMs.toFixed(2)} ms` : ''}   sim lag frames ${lagFrames}\n` +
        `shear ${body.params.shear}   minJ ${body.minJacobian.toFixed(3)}   contacts ${body.contactCount}` +
        `   tufts ${tuftCount}${gait.grounded ? '' : '   airborne'}${gait.moving ? '   walking' : ''}${conga.on ? '   conga' : ''}` +
        (body.grabbing ? '   grabbing' : '');
    }
    requestAnimationFrame(frame);
  };

  // Built once. Rebuilding this object literal inside the frame loop allocated a
  // fresh nineteen-property object 120 times a second for nothing; the live
  // numbers are getters, so it stays current without being rebuilt.
  globalThis.__engine = { body, skin, cpuSkin, gpuSkin, renderer, mesh, geometry, camera, raycaster, orbit,
    locomotion, conga, disco, breath, audio, sprite, world, model, scene, ui, transform, eyes,
    createSoftBody, colourElements, verifyColouring,
    get fps() { return fps; }, get simMs() { return simMs; },
    get skinMs() { return skinMs; }, get shownSubsteps() { return shownSubsteps; },
    get lagFrames() { return lagFrames; }, get tuftCount() { return tuftCount; },
    audit: () => { const out = [];
      scene.traverse(o => { if (o.isMesh) out.push({ name: o.name || o.type,
        attrs: Object.keys(o.geometry.attributes),
        arrays: Object.fromEntries(Object.entries(o.geometry.attributes)
          .map(([k, a]) => [k, a.array ? a.array.length : 'NO ARRAY'])) }); });
      return out; } };
  if (q.get('gpu') === 'bench') {
    ui.say('Benchmarking the compute solver');
    // Split out on purpose: it is not the live solver, so it should not reach
    // anyone who did not ask for the benchmark.
    const { benchGpu } = await import('./gpu.js');
    console.table(await benchGpu(model, createSoftBody, colourElements, verifyColouring));
  }
  placeCamera();
  requestAnimationFrame(frame);
  ui.say('Ready');
  await ui.ready();
  entered = true;   // the rolled form paints plain; only a click earns the sweep
}

main().catch((err) => {
  document.getElementById('loading')?.remove();
  fail.classList.add('shown');
  document.getElementById('fail-detail').textContent = String(err?.stack || err?.message || err);
  document.getElementById('retry').addEventListener('click', () => location.reload());
  console.error(err);
});
