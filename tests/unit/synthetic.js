/** Testler için sentetik plaka sahnesi üretir (RGBA). Karakterler 5x7 bitmap yazı tipiyle çizilir. */
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

export function makeScene({ width = 960, height = 540, text = '34 ABC 123', x = 380, y = 330, scale = 4, blueBand = true, noise = 12 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < width * height; i++) {
    const yy = Math.floor(i / width);
    const v = 70 + (yy / height) * 50 + (rnd() - 0.5) * noise;
    data[i * 4] = v; data[i * 4 + 1] = v + 4; data[i * 4 + 2] = v + 8; data[i * 4 + 3] = 255;
  }
  const set = (px, py, r, g, b) => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const o = (py * width + px) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b;
  };
  const charW = 6 * scale;
  const band = blueBand ? Math.round(3 * scale) : 0;
  const pw = band + text.length * charW + 4 * scale;
  const ph = 11 * scale;
  // gövde (araç) koyu dikdörtgen
  for (let yy = y - ph * 3; yy < y + ph * 2; yy++) for (let xx = x - pw * 0.6; xx < x + pw * 1.6; xx++) set(Math.round(xx), yy, 40, 45, 60);
  // plaka zemini + çerçeve
  for (let yy = 0; yy < ph; yy++) for (let xx = 0; xx < pw; xx++) {
    const border = yy < 2 || yy >= ph - 2 || xx < 2 || xx >= pw - 2;
    if (border) set(x + xx, y + yy, 20, 20, 20);
    else if (xx < band) set(x + xx, y + yy, 20, 50, 170);
    else set(x + xx, y + yy, 235, 235, 235);
  }
  let cx = x + band + 2 * scale;
  const cy = y + 2 * scale;
  for (const ch of text) {
    const g = FONT[ch];
    if (g) {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
        if (g[r][c] === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(cx + c * scale + dx, cy + r * scale + dy, 15, 15, 15);
      }
    }
    cx += charW;
  }
  return { img: { data, width, height }, plate: { x, y, w: pw, h: ph } };
}
