// The chrome: name, form, sound, reset, credits, the entrance and the touch pad.
// Everything the page can do to the world goes through the handlers passed in,
// so this file never reaches into the scene.

// A phone or a tablet: no hover, coarse pointer. Drives the touch pad here and
// the render budget in main.js.
export const COARSE = matchMedia('(hover: none) and (pointer: coarse)').matches;
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const FORMS = {
  ditto: { hex: 0xc99ae2, css: '#c99ae2' },
  shiny: { hex: 0x79c2ec, css: '#79c2ec' },
};
const SHINY_ODDS = 4096;      // the real odds, rolled once per visit
const INTRO_MIN_MS = 1900;    // the entrance never flashes past faster than this
const INTRO_CAP_MS = 3200;    // a backgrounded tab draws no frames, so never wait on them
const CONGA_WORD = 'conga';
const NAMES = [
  { name: 'Ditto', eyebrow: 'the transform pokémon', lang: 'en' },
  { name: 'メタモン', eyebrow: 'へんしんポケモン', lang: 'ja' },
];

export function createUi() {
  // Built before the heavy work starts, so the entrance is on screen and can
  // report progress. main.js calls bind() once the world exists.
  let onForm, onReset, onSound, onConga, setStick, onHoldHop, onReleaseHop;
  const q = new URLSearchParams(location.search);
  const el = (id) => document.getElementById(id);
  const loading = el('loading');
  const message = el('load-message');

  // --- form -------------------------------------------------------------
  let form = q.has('shiny') ? 'shiny'
    : (Math.floor(Math.random() * SHINY_ODDS) === 0 ? 'shiny' : 'ditto');
  const paintForm = () => {
    document.documentElement.style.setProperty('--ditto', FORMS[form].css);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', FORMS[form].css);
    loading.classList.toggle('shiny', form === 'shiny');
    onForm?.(FORMS[form].hex, form);
  };
  const formBtn = el('form');
  formBtn.addEventListener('click', () => {
    form = form === 'ditto' ? 'shiny' : 'ditto';
    paintForm();
    formBtn.classList.remove('turning');
    void formBtn.offsetWidth;   // restart the pulse on a second click
    formBtn.classList.add('turning');
  });

  // --- name -------------------------------------------------------------
  let which = 0;
  const nameBtn = el('name');
  const eyebrow = document.querySelector('.eyebrow');
  el('name').addEventListener('click', () => {
    which = (which + 1) % NAMES.length;
    const n = NAMES[which];
    nameBtn.innerHTML = `${n.name}<b>.</b>`;
    nameBtn.lang = n.lang;
    eyebrow.textContent = n.eyebrow;
    eyebrow.lang = n.lang;
  });

  // --- sound ------------------------------------------------------------
  // Every route through the dance goes through this button, so the music and
  // the arms are one state and can never disagree.
  const sound = el('sound');
  const setSound = (on) => {
    sound.setAttribute('aria-pressed', String(on));
    el('sound-on').style.display = on ? '' : 'none';
    el('sound-off').style.display = on ? 'none' : '';
    onSound?.(on);
    onConga?.(on);
  };
  sound.addEventListener('click', () => setSound(sound.getAttribute('aria-pressed') !== 'true'));

  // --- reset and credits ------------------------------------------------
  el('reset').addEventListener('click', () => onReset?.());
  const credits = el('credits');
  el('about').addEventListener('click', () => credits.showModal());
  el('credits-close').addEventListener('click', () => credits.close());

  // --- the typed easter egg --------------------------------------------
  let typed = '';
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (e.code === 'Escape') { if (sound.getAttribute('aria-pressed') === 'true') setSound(false); return; }
    if (e.code === 'KeyR') { onReset?.(); return; }
    if (!e.key || e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-CONGA_WORD.length);
    if (typed === CONGA_WORD) { typed = ''; sound.click(); }
  });

  // --- touch pad --------------------------------------------------------
  if (COARSE) {
    document.body.classList.add('touch');

    const pad = el('stick'), knob = el('knob'), hop = el('hop');
    let id = null, hubX = 0, hubY = 0;
    const reach = 34;
    // on the press, not the move: a layout read after the knob's write reflows
    const findHub = () => {
      const r = pad.getBoundingClientRect();
      hubX = r.left + r.width / 2; hubY = r.top + r.height / 2;
    };
    const move = (e) => {
      let dx = e.clientX - hubX;
      let dy = e.clientY - hubY;
      const len = Math.hypot(dx, dy);
      if (len > reach) { dx = dx / len * reach; dy = dy / len * reach; }
      knob.style.translate = `${dx}px ${dy}px`;
      setStick?.(dx / reach, dy / reach);
    };
    pad.addEventListener('pointerdown', (e) => {
      id = e.pointerId; findHub();
      try { pad.setPointerCapture(id); } catch {}
      move(e);
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const drop = (e) => {
      if (e.pointerId !== id) return;
      id = null; knob.style.translate = '0 0'; setStick?.(0, 0);
    };
    pad.addEventListener('pointerup', drop);
    pad.addEventListener('pointercancel', drop);
    // held, not tapped, so the browser's own long press gesture has to go
    hop.addEventListener('pointerdown', (e) => {
      e.preventDefault(); hop.classList.add('held'); onHoldHop?.();
    });
    const release = () => { hop.classList.remove('held'); onReleaseHop?.(); };
    hop.addEventListener('pointerup', release);
    hop.addEventListener('pointercancel', release);
  }

  // --- the entrance -----------------------------------------------------
  if (q.has('hud')) document.body.classList.add('hud');
  paintForm();
  const opened = performance.now();
  requestAnimationFrame(() => loading.classList.add('go'));

  return {
    bind(h) {
      ({ onForm, onReset, onSound, onConga, setStick, onHoldHop, onReleaseHop } = h);
      paintForm();
    },
    say(text) { message.textContent = text; },
    get form() { return form; },
    async ready() {
      const spent = performance.now() - opened;
      await new Promise(r => setTimeout(r, Math.max(0, Math.min(INTRO_CAP_MS, INTRO_MIN_MS) - spent)));
      loading.classList.add('done');
      setTimeout(() => loading.remove(), 400);
    },
    fail(err) {
      loading.remove();
      document.getElementById('fail').classList.add('shown');
      document.getElementById('fail-detail').textContent = String(err?.stack || err?.message || err);
      document.getElementById('retry').addEventListener('click', () => location.reload());
    },
  };
}
