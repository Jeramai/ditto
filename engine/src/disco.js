import { BEAT } from './audio.js';

export const DISCO = {
  ease: 3.4,             // 1/s onto the lit state
  tint: 0.62,            // how far the sun and the fill travel to the beat colour
  fogTint: 0.45,
  env: 0.34,             // the sky probe drops out of the coloured lights' way
  frames: 4,             // one sprite frame per quarter beat, as the favicon runs
  ceiling: 0.55,         // the overlay's own strength; past this a dark beat colour blacks the field out
  scale: [0.06, 0.30],   // sprite height as a fraction of the viewport
  speed: [400, 1000],    // px/s
  alpha: [0.12, 0.55],   // he is the star here, so the parade never buries him
  shinyOdds: 64,         // per sprite; the real 1 in 4096 would never show inside one dance
  pool: 24,
  reduced: false,
};

const CELL = 33;         // the padded square make_favicon.py writes

const pick = ([lo, hi]) => lo + Math.random() * (hi - lo);

export function createDisco(scene, world, options = {}) {
  const P = { ...DISCO, ...options };
  const sprite = P.sprite;
  const root = document.documentElement;
  const lights = document.getElementById('disco');
  const canvas = document.getElementById('crowd');
  const ctx = canvas.getContext('2d');

  const sun = world.sun, fill = world.fill;
  const sunBase = sun.color.clone();
  const fillBase = fill.color.clone();
  const groundBase = fill.groundColor.clone();
  const fogBase = scene.fog.color.clone();
  const envBase = scene.environmentIntensity;
  const lit = sunBase.clone();

  // a fixed pool, because nothing may allocate in the frame loop
  const pool = [];
  for (let i = 0; i < P.pool; i++)
    pool.push({ live: false, x: 0, y: 0, size: 0, vx: 0, alpha: 1, shiny: false });

  // cached, not read per frame: a layout read after the opacity write reflows
  let w = 0, h = 0;
  const resize = () => {
    w = Math.floor(innerWidth); h = Math.floor(innerHeight);
    canvas.width = w; canvas.height = h;
    ctx.imageSmoothingEnabled = false;   // a resize resets the context state
  };
  addEventListener('resize', resize);
  resize();

  let on = false, level = 0, phase = 0, index = -1;

  const hex = () => `#${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`;

  const recolour = () => {
    root.style.setProperty('--disco-a', hex());
    root.style.setProperty('--disco-b', hex());
    // clamped: an even random colour has no channel above half one beat in eight, which lights him black
    lit.setHSL(Math.random(), 0.85, 0.6);
  };

  const spawn = () => {
    let e = null;
    for (let i = 0; i < pool.length; i++) if (!pool[i].live) { e = pool[i]; break; }
    if (!e) return;
    const right = Math.random() < 0.5;
    e.size = Math.max(1, Math.round(h * pick(P.scale) / CELL)) * CELL;   // whole pixels, so the art stays square
    e.vx = pick(P.speed) * (right ? 1 : -1);
    e.x = right ? -e.size : w;
    e.y = Math.random() * Math.max(0, h - e.size);
    e.alpha = pick(P.alpha);
    e.shiny = Math.random() * P.shinyOdds < 1;
    e.live = true;
  };

  const restore = () => {
    sun.color.copy(sunBase);
    fill.color.copy(fillBase);
    fill.groundColor.copy(groundBase);
    scene.fog.color.copy(fogBase);
    scene.environmentIntensity = envBase;
    for (let i = 0; i < pool.length; i++) pool[i].live = false;
    ctx.clearRect(0, 0, w, h);
    lights.hidden = canvas.hidden = true;
  };

  const step = (dt, clock) => {
    if (dt <= 0) return;
    if (!on && level < 0.002) { if (level !== 0) { level = 0; restore(); } return; }

    if (on) {
      // the audio clock, so the flash lands on his bounce and not beside it
      phase = clock === undefined ? phase + dt : clock;
      const i = Math.floor(phase / BEAT);
      if (i !== index) { index = i; recolour(); spawn(); }
    }
    level += ((on ? 1 : 0) - level) * Math.min(1, P.ease * dt);

    const t = P.tint * level;
    sun.color.copy(sunBase).lerp(lit, t);
    fill.color.copy(fillBase).lerp(lit, t);
    fill.groundColor.copy(groundBase).lerp(lit, t);
    scene.fog.color.copy(fogBase).lerp(lit, P.fogTint * level);
    scene.environmentIntensity = envBase + (P.env - envBase) * level;
    root.style.setProperty('--disco-level', level * P.ceiling);

    const ready = sprite.ready;
    const fi = Math.floor(phase / (BEAT / P.frames)) % P.frames;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.live) continue;
      e.x += e.vx * dt;
      if (e.x > w || e.x <= -e.size) { e.live = false; continue; }
      if (!ready) continue;
      ctx.globalAlpha = e.alpha;
      ctx.drawImage(sprite.frame(fi, e.shiny), Math.round(e.x), Math.round(e.y), e.size, e.size);
    }
    ctx.globalAlpha = 1;
  };

  return {
    step, params: P,
    get on() { return on; },
    get level() { return level; },
    get crowd() { let n = 0; for (const e of pool) if (e.live) n++; return n; },
    get shinyCrowd() { let n = 0; for (const e of pool) if (e.live && e.shiny) n++; return n; },
    set on(value) {
      on = !!value && !P.reduced;
      if (on) { phase = 0; index = -1; lights.hidden = canvas.hidden = false; recolour(); }
    },
  };
}
