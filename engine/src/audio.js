// The track and the dance are one state, so the conga owns this and every route
// in or out goes through it. Otherwise the music and the arms can disagree.
// "Conga" by Gloria Estefan and Miami Sound Machine, from matias.me/nsfw.

// Measured off the file by onset autocorrelation. The file starts on the
// downbeat, so there is no offset to subtract.
export const BEAT = 0.4902;
const VOLUME = 0.5;
const FRAMES = 4;      // one favicon frame per quarter beat

export function createAudio(base = './') {
  const el = new Audio(`${base}konga.mp3`);
  el.loop = true;
  el.volume = VOLUME;
  el.preload = 'auto';

  const link = document.querySelector('link[rel="icon"]');
  const icons = [];
  for (let i = 0; i < FRAMES; i++) icons.push(`${base}favicon-${i}.png`);
  let shown = -1;
  const spin = (time) => {
    if (!link) return;
    const f = Math.floor(time / (BEAT / FRAMES)) % FRAMES;
    if (f === shown) return;
    shown = f;
    link.href = icons[f];
  };
  const rest = () => { if (link && shown !== -1) { shown = -1; link.href = icons[0]; } };

  let muted = false;
  return {
    // Autoplay needs a gesture. Every caller here is behind a key or a tap, but
    // a rejected play must not throw and kill the frame.
    play() { if (!muted) el.play().catch(() => {}); },
    pause() { el.pause(); rest(); },
    rewind() { try { el.currentTime = 0; } catch {} },
    spin,
    get time() { return el.currentTime; },
    get playing() { return !el.paused; },
    get muted() { return muted; },
    set muted(v) {
      muted = !!v;
      if (muted) this.pause(); else this.play();
    },
  };
}
