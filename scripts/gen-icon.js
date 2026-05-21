/**
 * Dependency-free Artha app-icon generator.
 *
 * Renders a branded "diya" (oil lamp) mark — the app's 🪔 motif — to a 1024px
 * RGBA master PNG using only Node's zlib for PNG encoding. Anti-aliasing comes
 * from 3x supersampling + box downsample. Downstream, sips/iconutil turn the
 * master into .icns and we hand-pack a multi-size .ico.
 *
 *   node scripts/gen-icon.js  ->  assets/icon-master.png (1024) + assets/icon.png (512)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 3; // supersample factor
const N = SIZE * SS;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Signed distance to a rounded rectangle centered at origin (normalized coords).
function roundRectSDF(nx, ny, half, r) {
  const qx = Math.abs(nx) - (half - r);
  const qy = Math.abs(ny) - (half - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Brand palette
const BG_TOP = [24, 32, 48];     // #182030
const BG_BOT = [11, 14, 20];     // #0b0e14
const CLAY_RIM = [231, 167, 101]; // #E7A765
const CLAY_BODY = [150, 86, 38];  // #965626
const FLAME_OUT = [255, 94, 26];  // #FF5E1A
const FLAME_MID = [255, 160, 46]; // #FFA02E
const FLAME_IN = [255, 233, 168]; // #FFE9A8
const GLOW = [255, 157, 46];      // #FF9D2E

// Composite the icon at a single normalized point; returns [r,g,b,a] 0..255.
function shade(nx, ny) {
  // Outside the squircle → transparent.
  const d = roundRectSDF(nx, ny, 0.94, 0.44);
  if (d > 0) return [0, 0, 0, 0];

  // Background vertical gradient.
  let col = mix(BG_TOP, BG_BOT, clamp01((ny + 0.94) / 1.88));

  // Flame anchor — bottom sits just above the dish rim so it reads as one lamp.
  const fcx = 0, fcyBot = 0.21, fcyTop = -0.44;

  // Warm radial glow behind the flame (screen-ish additive blend).
  const gx = nx - fcx, gy = ny - (-0.12);
  const gd = Math.sqrt(gx * gx + gy * gy);
  const glowA = 0.55 * Math.exp(-(gd * gd) / (2 * 0.30 * 0.30));
  col = [
    col[0] + (255 - col[0]) * (GLOW[0] / 255) * glowA,
    col[1] + (255 - col[1]) * (GLOW[1] / 255) * glowA,
    col[2] + (255 - col[2]) * (GLOW[2] / 255) * glowA,
  ];

  // Diya bowl: lower portion of a wide ellipse, with a brighter rim.
  const bcx = 0, bcy = 0.34, brx = 0.56, bry = 0.20;
  const ex = (nx - bcx) / brx, ey = (ny - bcy) / bry;
  const eInside = ex * ex + ey * ey <= 1;
  if (eInside && ny >= bcy - 0.085) {
    // Rim highlight near the top edge of the dish, clay body below.
    const rim = clamp01(1 - (ny - (bcy - 0.085)) / 0.16);
    col = mix(CLAY_BODY, CLAY_RIM, rim * 0.9);
  }

  // Flame teardrop: pointed top, bulging lower-middle.
  const t = (ny - fcyTop) / (fcyBot - fcyTop); // 0 at top → 1 at bottom
  if (t >= 0 && t <= 1) {
    const maxw = 0.165;
    const width = maxw * Math.pow(t, 0.62) * (1 - 0.22 * Math.pow(t, 3));
    const dxn = Math.abs(nx - fcx);
    if (dxn <= width) {
      const edge = dxn / Math.max(width, 1e-6); // 0 center → 1 edge
      // Cooler/brighter toward the lower core, hotter-orange at edges/top.
      const core = (1 - edge) * (0.35 + 0.65 * t);
      let fc = mix(FLAME_OUT, FLAME_MID, clamp01(1 - edge));
      fc = mix(fc, FLAME_IN, clamp01(core));
      col = fc;
    }
  }

  return [Math.round(col[0]), Math.round(col[1]), Math.round(col[2]), 255];
}

// Render supersampled, then box-downsample to SIZE.
console.log(`Rendering ${N}x${N} → ${SIZE}x${SIZE}...`);
const out = Buffer.alloc(SIZE * SIZE * 4);
const inv = SS * SS;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x * SS + sx, py = y * SS + sy;
        const nx = ((px + 0.5) / N) * 2 - 1;
        const ny = ((py + 0.5) / N) * 2 - 1;
        const [cr, cg, cb, ca] = shade(nx, ny);
        const af = ca / 255;
        r += cr * af; g += cg * af; b += cb * af; a += ca;
      }
    }
    const o = (y * SIZE + x) * 4;
    const af = a / 255 / inv;
    out[o] = af > 0 ? Math.round(r / inv / af) : 0;
    out[o + 1] = af > 0 ? Math.round(g / inv / af) : 0;
    out[o + 2] = af > 0 ? Math.round(b / inv / af) : 0;
    out[o + 3] = Math.round(a / inv);
  }
}

// Minimal PNG encoder (RGBA, no filtering).
function encodePNG(buf, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    buf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([tb, data])) >>> 0, 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon-master.png'), encodePNG(out, SIZE, SIZE));
console.log('Wrote assets/icon-master.png');
