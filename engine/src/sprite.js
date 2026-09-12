import { FORMS } from './ui.js';

export const FRAMES = 4;

const CELL = 33;                   // the padded square make_favicon.py writes
const BODY = [0xb8, 0x60, 0xe0];   // the strip's only body colour, so the swap is exact

export function createSprite(base = './') {
  const shinyHex = FORMS.shiny.hex;
  const sr = (shinyHex >> 16) & 255, sg = (shinyHex >> 8) & 255, sb = shinyHex & 255;

  const canvas = { ditto: [], shiny: [] };
  const url = { ditto: [], shiny: [] };
  let loaded = 0;

  const bake = (img, recolour) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || CELL; c.height = img.naturalHeight || CELL;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    if (recolour) {
      const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] !== BODY[0] || px[i + 1] !== BODY[1] || px[i + 2] !== BODY[2]) continue;
        px[i] = sr; px[i + 1] = sg; px[i + 2] = sb;
      }
      g.putImageData(d, 0, 0);
    }
    return c;
  };

  const waiting = [];
  const images = [];
  for (let i = 0; i < FRAMES; i++) {
    const img = new Image();
    // a failed bake must not hold the parade back, so it still counts as loaded
    img.addEventListener('load', () => {
      try {
        canvas.ditto[i] = bake(img, false);
        canvas.shiny[i] = bake(img, true);
        url.ditto[i] = canvas.ditto[i].toDataURL();
        url.shiny[i] = canvas.shiny[i].toDataURL();
      } catch { canvas.ditto[i] = img; }
      if (++loaded === FRAMES) { for (const cb of waiting) cb(); waiting.length = 0; }
    });
    img.src = `${base}favicon-${i}.png`;
    images.push(img);
  }

  const key = (shiny) => (shiny ? 'shiny' : 'ditto');
  return {
    get ready() { return loaded >= FRAMES; },
    onReady(cb) { if (loaded >= FRAMES) cb(); else waiting.push(cb); },
    frame(i, shiny) { return canvas[key(shiny)][i] || canvas.ditto[i] || images[i]; },
    // a data URL, so the tab stops re-fetching a png eight times a second
    href(i, shiny) { return url[key(shiny)][i] || url.ditto[i]; },
  };
}
