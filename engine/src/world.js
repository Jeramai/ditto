import * as THREE from 'three/webgpu';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { texture, attribute, positionGeometry, cameraPosition, uniform, vec2, vec3 } from 'three/tsl';

// The floor sheet, the tuft sprite and the sky probe all come out of our own
// Python. One 16 px tile of the sheet covers TILE_UNITS of world, and the sheet
// is 64 tiles across, so it repeats every TILE_UNITS * 64. The tuft layout says
// which of those cells carries an upright rosette.
const TILE_UNITS = 0.04;
const SHEET_TILES = 64;
const SHEET_SPAN = TILE_UNITS * SHEET_TILES;
const GROUND_SPAN = 6;
const GRASS_ROUGHNESS = 0.62;
const TUFT_RADIUS = 0.8;
const TUFT_TALL = 0.030;
// Tufts flatten under his weight and spring back a few seconds after he leaves,
// so you can see where he has been. TRAMPLE_IN is fully flat, TRAMPLE_OUT is
// where the dent ends, TRAMPLE_LOW is how short a flattened tuft gets.
const TRAMPLE_IN = 0.030;
const TRAMPLE_OUT = 0.078;
const TRAMPLE_LOW = 0.14;
const TRAIL_LIFE = 7.0;
const TRAIL_STEP = 0.009;    // a mark this close to the last one just refreshes it
const TRAIL_MARKS = 260;     // prune expired marks once this many accumulate
// make_sky.py puts the sun 38 degrees up; match it so the cast shadow agrees
// with the probe the image lighting comes from.
const SUN_DIR = new THREE.Vector3(-0.5865, 0.6157, 0.5262).normalize();
const SUN_TINT = 0xfff4e6;
// The ground plane is 6 m across and its edge is visible against the sky. Fade
// it out instead, in the sky's own horizon colour so the two meet invisibly.
const HAZE = 0xb3c4d9;
const HAZE_NEAR = 1.1;
const HAZE_FAR = 3.4;

export async function createWorld(scene, renderer, { shadows = true, cheapShadows = false } = {}) {
  const loader = new THREE.TextureLoader();
  const pixel = (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.generateMipmaps = true;
    return tex;
  };

  const [sheet, tuft, layout, sky] = await Promise.all([
    loader.loadAsync('./grass_tiles.webp').then(pixel),
    loader.loadAsync('./grass_tuft.webp').then(pixel),
    fetch('./grass_layout.json').then(r => r.json()),
    new EXRLoader().loadAsync('./sky.exr'),
  ]);

  sky.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = sky;
  scene.fog = new THREE.Fog(HAZE, HAZE_NEAR, HAZE_FAR);
  scene.environment = sky;
  scene.environmentIntensity = 0.50;

  // ground
  sheet.wrapS = sheet.wrapT = THREE.RepeatWrapping;
  const repeat = GROUND_SPAN / SHEET_SPAN;
  sheet.repeat.set(repeat, repeat);
  // world origin must land on the middle of the sheet, the same place the tuft
  // cells are indexed from, or the painted rosettes and the sprites disagree
  sheet.offset.set(0.5 - 0.5 * repeat, 0.5 - 0.5 * repeat);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SPAN, GROUND_SPAN).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ map: sheet, roughness: GRASS_ROUGHNESS, metalness: 0 }),
  );
  ground.receiveShadow = shadows;
  scene.add(ground);

  // upright tufts: one instanced quad per tuft cell within TUFT_RADIUS
  const bits = layout.rows.join('');
  const nt = layout.tiles;
  const cells = Math.ceil(TUFT_RADIUS / TILE_UNITS);
  const span = 2 * cells + 1;
  const cellR2 = cells * cells;
  // every cell in the circle, not the layout's average density: a clump fills its own
  let cap = 0;
  for (let dz = -cells; dz <= cells; dz++) {
    for (let dx = -cells; dx <= cells; dx++) if (dx * dx + dz * dz <= cellR2) cap++;
  }

  const half = TILE_UNITS / 2;
  const quadPos = new Float32Array([-half, 0, 0, half, 0, 0, half, 1, 0, -half, 1, 0]);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
  // upward facing normals: a billboard has no real surface, and lighting them
  // like the ground they grow from reads correctly for grass
  geometry.setAttribute('normal', new THREE.BufferAttribute(
    new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const centres = new Float32Array(cap * 2);
  const talls = new Float32Array(cap);
  const centreAttr = new THREE.InstancedBufferAttribute(centres, 2).setUsage(THREE.DynamicDrawUsage);
  const tallAttr = new THREE.InstancedBufferAttribute(talls, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('tuftCentre', centreAttr);
  geometry.setAttribute('tuftTall', tallAttr);
  geometry.instanceCount = 0;

  // The alphaTest constructor option is not wired into the node pipeline, so
  // every quad drew opaque including its transparent border: hard rectangles of
  // grass over whatever was behind them. Drive the cut from the texture instead.
  // Alpha tested foliage, not blended: the cut has to discard the fragment so it
  // never writes depth, otherwise the transparent corners of each quad punch a
  // rectangular hole through whatever is behind them.
  const tuftMaterial = new THREE.MeshStandardNodeMaterial({
    roughness: GRASS_ROUGHNESS, metalness: 0, side: THREE.DoubleSide,
    transparent: false, alphaTest: 0.5, depthWrite: true,
  });
  const tuftTex = texture(tuft);
  tuftMaterial.colorNode = tuftTex.rgb;
  tuftMaterial.opacityNode = tuftTex.a;

  // shared, not per tuft: the camera rides with him, so this angle holds the field still
  const fieldCentre = uniform(new THREE.Vector2());
  const iCentre = attribute('tuftCentre', 'vec2');
  const iTall = attribute('tuftTall', 'float');
  const toCam = cameraPosition.xz.sub(fieldCentre);
  const look = toCam.div(toCam.length().max(1e-6));
  const wide = vec2(look.y, look.x.negate()).mul(positionGeometry.x);
  tuftMaterial.positionNode = vec3(
    iCentre.x.add(wide.x), positionGeometry.y.mul(iTall), iCentre.y.add(wide.y));

  const tufts = new THREE.Mesh(geometry, tuftMaterial);
  tufts.frustumCulled = false;
  tufts.castShadow = false;
  scene.add(tufts);

  const hasTuft = (ix, iz) => {
    const cx = ((ix % nt) + nt) % nt, cz = ((iz % nt) + nt) % nt;
    return bits.charCodeAt(cz * nt + cx) === 103;   // 'g'
  };

  // the trample walks the marks, not the tufts, so a tuft off his path costs nothing
  const trail = new Float32Array(TRAIL_MARKS * 3);
  let marks = 0, lastMark = 0;

  const tread = (x, z, grounded, now) => {
    if (!grounded || now - lastMark < 0.05) return;
    lastMark = now;
    // Standing still refreshes the mark he is on. Moving it with him dragged one
    // dent along instead of leaving a trail, because the distance from the mark
    // never accumulated past TRAIL_STEP.
    if (marks) {
      const i = (marks - 1) * 3;
      if (Math.hypot(x - trail[i], z - trail[i + 1]) <= TRAIL_STEP) { trail[i + 2] = now; return; }
    }
    if (marks === TRAIL_MARKS) {
      let w = 0;
      for (let r = 0; r < marks; r++) {
        const i = r * 3;
        if (now - trail[i + 2] >= TRAIL_LIFE) continue;
        trail[w * 3] = trail[i]; trail[w * 3 + 1] = trail[i + 1]; trail[w * 3 + 2] = trail[i + 2];
        w++;
      }
      marks = w;
      // unreachable at the current cadence, but a changed constant must not overrun
      if (marks === TRAIL_MARKS) { trail.copyWithin(0, 3); marks--; }
    }
    const o = marks * 3;
    trail[o] = x; trail[o + 1] = z; trail[o + 2] = now;
    marks++;
  };

  // which instance holds a cell of the window, or -1
  const slotOf = new Int16Array(span * span);
  const reach = Math.ceil(TRAMPLE_OUT / TILE_UNITS);
  let baseX = NaN, baseZ = NaN, live = 0;

  const rebuild = (bx, bz) => {
    slotOf.fill(-1);
    live = 0;
    for (let dz = -cells; dz <= cells; dz++) {
      for (let dx = -cells; dx <= cells; dx++) {
        if (dx * dx + dz * dz > cellR2) continue;
        const ix = bx + dx, iz = bz + dz;
        if (!hasTuft(ix, iz)) continue;
        centres[live * 2] = (ix - nt / 2 + 0.5) * TILE_UNITS;
        centres[live * 2 + 1] = (iz - nt / 2 + 0.5) * TILE_UNITS;
        slotOf[(dz + cells) * span + (dx + cells)] = live;
        live++;
      }
    }
    geometry.instanceCount = live;
    centreAttr.needsUpdate = true;
  };

  const trample = (now) => {
    talls.fill(TUFT_TALL, 0, live);
    for (let r = 0; r < marks; r++) {
      const o = r * 3;
      const age = (now - trail[o + 2]) / TRAIL_LIFE;
      if (age >= 1) continue;
      const mx = trail[o], mz = trail[o + 1];
      const back = age * age * (3 - 2 * age);
      const cx = Math.floor(mx / TILE_UNITS) + nt / 2 - baseX;
      const cz = Math.floor(mz / TILE_UNITS) + nt / 2 - baseZ;
      for (let dz = Math.max(-cells, cz - reach); dz <= Math.min(cells, cz + reach); dz++) {
        for (let dx = Math.max(-cells, cx - reach); dx <= Math.min(cells, cx + reach); dx++) {
          const s = slotOf[(dz + cells) * span + (dx + cells)];
          if (s < 0) continue;
          const d = Math.hypot(centres[s * 2] - mx, centres[s * 2 + 1] - mz);
          if (d >= TRAMPLE_OUT) continue;
          const t = d <= TRAMPLE_IN ? 0 : (d - TRAMPLE_IN) / (TRAMPLE_OUT - TRAMPLE_IN);
          const base = TRAMPLE_LOW + (1 - TRAMPLE_LOW) * (t * t * (3 - 2 * t));
          const tall = (base + (1 - base) * back) * TUFT_TALL;
          if (tall < talls[s]) talls[s] = tall;
        }
      }
    }
    tallAttr.needsUpdate = true;
  };

  // Half the shadow passes, but only while he is down: a hop peaks at 1.4 m/s,
  // and one stale frame there drags his shadow 23 mm behind a 54 mm body.
  let shadowTick = 0;
  const refreshShadow = (grounded) => {
    if (!cheapShadows || !shadows) return;
    sun.shadow.needsUpdate = !grounded || (shadowTick++ & 1) === 0;
  };

  const updateTufts = (centre, walker) => {
    const now = performance.now() / 1000;
    if (walker) { tread(walker.x, walker.z, walker.grounded, now); refreshShadow(walker.grounded); }
    // The floor samples the sheet as xz / SHEET_SPAN + 0.5, so world zero sits
    // on the middle cell, not cell zero. The sprites have to index the same way
    // or they stand somewhere other than the rosettes painted on the ground.
    const bx = Math.floor(centre.x / TILE_UNITS) + nt / 2;
    const bz = Math.floor(centre.z / TILE_UNITS) + nt / 2;
    if (bx !== baseX || bz !== baseZ) { baseX = bx; baseZ = bz; rebuild(bx, bz); }
    fieldCentre.value.set(centre.x, centre.z);
    trample(now);
    tufts.visible = live > 0;
    return live;
  };

  // A clear day is mostly direct sun with the sky as fill. Letting the probe
  // carry it instead desaturates the grass to mint, because a blue sky lighting
  // green is cyan.
  const sun = new THREE.DirectionalLight(SUN_TINT, 1.6);
  sun.position.copy(SUN_DIR).multiplyScalar(1.2);
  // The shadow camera is a 24 cm box, and it hangs off the light's target. Leave
  // that target at the origin and he walks out of his own shadow map, which
  // clips the shadow off at the edge of the box. Both follow him instead.
  scene.add(sun.target);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(cheapShadows ? 512 : 1024);
    const c = sun.shadow.camera;
    c.left = -0.12; c.right = 0.12; c.top = 0.12; c.bottom = -0.12;
    c.near = 0.4; c.far = 2.2;
    sun.shadow.bias = -0.0006;
    // the tongue sits near edge on inside the mouth, where depth bias alone
    // leaves the shadow map striping it
    sun.shadow.normalBias = cheapShadows ? 0.0024 : 0.0012;
    // setSize only runs inside an update, so the map must be built once before
    // any frame is allowed to skip, or WebGPU rejects an unsized texture.
    if (cheapShadows) { sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true; }
  }
  scene.add(sun);
  const fill = new THREE.HemisphereLight(0xcfe4ff, 0x8a9463, 0.25);
  scene.add(fill);

  // Everything that is sized around him has to travel with him. The ground was
  // the last thing still pinned to the world origin, so at 84 mm/s he walked off
  // the edge of a 6 m plane in about half a minute and was left standing in the
  // void with the tuft sprites hovering around him.
  //
  // Snap it to whole multiples of the sheet's own repeat. The texture period is
  // exactly SHEET_SPAN, so a shift of one period leaves the pattern where it was
  // in world space: no UV correction, and nothing swims under him. A 2.56 m snap
  // on a 6 m plane keeps at least 1.7 m of ground ahead, against the 0.9 m he
  // can actually see.
  const follow = (centre) => {
    sun.target.position.set(centre.x, 0, centre.z);
    sun.position.set(centre.x, 0, centre.z).addScaledVector(SUN_DIR, 1.2);
    ground.position.x = Math.round(centre.x / SHEET_SPAN) * SHEET_SPAN;
    ground.position.z = Math.round(centre.z / SHEET_SPAN) * SHEET_SPAN;
  };

  return { ground, tufts, sun, fill, follow, updateTufts, tuftCapacity: cap,
    get markCount() { return marks; } };
}
