import * as THREE from 'three/webgpu';
import { uniform, mix, smoothstep, positionWorld, texture, exp } from 'three/tsl';

const SWEEP = 0.58;        // seconds for the front to cross him
const BAND = 0.009;        // metres the colour takes to turn over
const RIDGE = 0.0031;      // metres of the lit wavefront
const SPARK = 0xfff4c0;    // star.png's core, so the front and the stars agree
const PARKED = -1;         // a front this low reads as "all of him, old colour"

const GLOW = 0.82;           // full strength clips the gold ridge to white
const STARS = 7;
const STAR_LIFE = 0.44;
const STAR_SIZE = 0.0058;    // the entrance draws its stars at a twelfth of him
const STAR_SPREAD = 0.042;   // clear of his 26 mm half width, or he hides them
const STAR_DRIFT = 0.045;    // m/s outward, so the burst reads as thrown
const STAR_POP = [0.35, 1.0, 0.85, 0.4];   // read off the entrance's @keyframes pop

export async function createTransform(scene, body, base = './') {
  const tint = uniform(new THREE.Color(0xffffff));
  const next = uniform(new THREE.Color(0xffffff));
  const front = uniform(PARKED);
  const glow = uniform(0);

  // positionWorld, not positionLocal: the local one is a vertex-stage variable
  // and reads zero in the fragment shader, which snaps the whole body at once.
  const ahead = smoothstep(front, front.add(BAND), positionWorld.y);
  const edge = positionWorld.y.sub(front).div(RIDGE);

  const star = await new THREE.TextureLoader().loadAsync(base + 'star.png');
  star.colorSpace = THREE.SRGBColorSpace;
  star.magFilter = THREE.NearestFilter;
  star.minFilter = THREE.NearestFilter;
  star.generateMipmaps = false;

  const positions = new Float32Array(STARS * 12);
  const normals = new Float32Array(STARS * 12);
  const uvs = new Float32Array(STARS * 8);
  const index = new Uint32Array(STARS * 6);
  for (let i = 0; i < STARS; i++) {
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
    // unlit, but the node graph still asks for a normal and warns without one
    normals.set([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], i * 12);
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);

  // No depth at all: a star stands in the tuft field, and the tufts write depth,
  // so a tested sparkle spends most of its life hidden inside the grass.
  const starMaterial = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide, transparent: false, alphaTest: 0.5,
    depthWrite: false, depthTest: false,
  });
  const starTex = texture(star);
  starMaterial.colorNode = starTex.rgb;
  starMaterial.opacityNode = starTex.a;
  const sprites = new THREE.Mesh(geometry, starMaterial);
  sprites.renderOrder = 10;
  sprites.visible = false;
  sprites.frustumCulled = false;
  sprites.castShadow = false;
  sprites.receiveShadow = false;
  scene.add(sprites);

  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const live = [];
  let sweeping = false, elapsed = 0, from = PARKED, to = PARKED;

  const bounds = () => {
    const x = body.x;
    let lo = Infinity, hi = -Infinity, cx = 0, cz = 0;
    for (let i = 1; i < x.length; i += 3) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
      cx += x[i - 1]; cz += x[i + 1];
    }
    const n = x.length / 3;
    return { lo, hi, cx: cx / n, cz: cz / n };
  };

  const land = () => {
    tint.value.copy(next.value);
    front.value = PARKED;
    glow.value = 0;
    sweeping = false;
  };

  const right = new THREE.Vector3();

  return {
    bodyNode: mix(next, tint, ahead),
    // main.js masks the eyes out of this: ink that glows reads as a highlight.
    ridgeNode: exp(edge.mul(edge).negate()).mul(glow),

    set(hex) { tint.value.setHex(hex); next.value.setHex(hex); },

    sweep(hex, sparkle) {
      if (sweeping) land();
      next.value.setHex(hex);
      if (calm.matches) { land(); return; }
      const { lo, hi, cx, cz } = bounds();
      from = lo - BAND;
      to = hi + BAND;
      front.value = from;
      glow.value = GLOW;
      elapsed = 0;
      sweeping = true;
      live.length = 0;
      if (!sparkle) return;
      for (let i = 0; i < STARS; i++) {
        // a jittered ring, so the burst reads as a volume around him
        const a = (i / STARS) * Math.PI * 2 + Math.random() * 0.7;
        const r = STAR_SPREAD * (0.9 + Math.random() * 0.45);
        live.push({
          x: cx + Math.cos(a) * r,
          y: lo + (hi - lo) * (0.25 + Math.random() * 0.75),
          z: cz + Math.sin(a) * r,
          vx: Math.cos(a) * STAR_DRIFT,
          vz: Math.sin(a) * STAR_DRIFT,
          vy: STAR_DRIFT * 0.6,
          size: STAR_SIZE * (0.7 + Math.random() * 0.7),
          delay: (i / STARS) * SWEEP * 0.5 + Math.random() * 0.05,
          age: 0,
        });
      }
    },

    step(dt, camera) {
      if (sweeping) {
        elapsed += dt;
        const p = elapsed / SWEEP;
        // eased both ends, and the slow parts fall in the BAND either side of him
        if (p >= 1) land();
        else front.value = from + (to - from) * p * p * (3 - 2 * p);
      }

      // hidden rather than an empty draw range: a zero index count still issues
      // a draw call, and WebGPU warns about it every frame
      if (!live.length) { sprites.visible = false; return; }
      sprites.visible = true;
      let quad = 0, alive = 0;
      for (const s of live) {
        s.age += dt;
        const u = (s.age - s.delay) / STAR_LIFE;
        if (u >= 1) continue;
        alive++;
        if (u < 0) continue;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        const h = s.size * STAR_POP[Math.min(STAR_POP.length - 1, Math.floor(u * STAR_POP.length))];
        // the tufts' billboard rule: turn about the vertical axis only, so a
        // star stands in the field like the grass does
        right.set(camera.position.x - s.x, 0, camera.position.z - s.z);
        if (right.lengthSq() < 1e-9) right.set(0, 0, 1);
        right.normalize();
        const rx = right.z * h, rz = -right.x * h;
        const o = quad * 12;
        positions[o]      = s.x - rx; positions[o + 1]  = s.y - h; positions[o + 2]  = s.z - rz;
        positions[o + 3]  = s.x + rx; positions[o + 4]  = s.y - h; positions[o + 5]  = s.z + rz;
        positions[o + 6]  = s.x + rx; positions[o + 7]  = s.y + h; positions[o + 8]  = s.z + rz;
        positions[o + 9]  = s.x - rx; positions[o + 10] = s.y + h; positions[o + 11] = s.z - rz;
        quad++;
      }
      if (!alive) live.length = 0;
      sprites.visible = quad > 0;
      geometry.setDrawRange(0, quad * 6);
      positionAttr.needsUpdate = true;
    },

    spark: SPARK,
    uniforms: { tint, next, front, glow },
    get sweeping() { return sweeping; },
  };
}
