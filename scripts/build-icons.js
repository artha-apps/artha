#!/usr/bin/env node
/**
 * build-icons — regenerate platform icon files from `assets/icon.png`.
 *
 * Produces:
 *   assets/icon.icns  — macOS, multi-size (16, 32, 64, 128, 256, 512, 1024)
 *   assets/icon.ico   — Windows, multi-size (16, 32, 48, 64, 128, 256)
 *   assets/icon.png   — Linux, untouched (electron-builder reads it directly)
 *
 * Why this exists:
 *   The previous `icon.icns` only contained a single `icp4` (16×16) entry,
 *   which made macOS render a degraded / fallback icon at every other size
 *   (Dock, Finder, About box, Cmd-Tab). Same risk on Windows when the .ico
 *   has only one size. This script rebuilds both as proper multi-size files
 *   from a single 1024×1024 master PNG.
 *
 * Usage:
 *   node scripts/build-icons.js
 *   npm run build:icons
 *
 * Requires (macOS only): `sips`, `iconutil` — both ship with the OS.
 * The .ico build is pure JS (no ImageMagick needed).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.png');
const ICNS_OUT = path.join(ROOT, 'assets', 'icon.icns');
const ICO_OUT  = path.join(ROOT, 'assets', 'icon.ico');

if (!fs.existsSync(SRC)) {
  console.error(`[build-icons] source missing: ${SRC}`);
  process.exit(1);
}

// ── 1. macOS .icns ──────────────────────────────────────────────────────────
//
// iconutil reads an `.iconset/` directory containing PNGs named per Apple's
// convention (icon_16x16.png, icon_16x16@2x.png, icon_32x32.png, …) and emits
// a proper multi-resolution .icns.
function buildIcns() {
  if (process.platform !== 'darwin') {
    console.warn('[build-icons] not on macOS — skipping .icns rebuild');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-iconset-'));
  const set  = path.join(work, 'icon.iconset');
  fs.mkdirSync(set);

  // Apple's required matrix. Each entry is [logical size, retina suffix, pixel size].
  const sizes = [
    [16, '',    16],   [16, '@2x', 32],
    [32, '',    32],   [32, '@2x', 64],
    [128, '',  128],   [128, '@2x', 256],
    [256, '',  256],   [256, '@2x', 512],
    [512, '',  512],   [512, '@2x', 1024],
  ];

  for (const [s, suffix, px] of sizes) {
    const out = path.join(set, `icon_${s}x${s}${suffix}.png`);
    execFileSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px), SRC, '--out', out], { stdio: 'ignore' });
  }

  execFileSync('iconutil', ['-c', 'icns', set, '-o', ICNS_OUT]);
  console.log(`[build-icons] wrote ${path.relative(ROOT, ICNS_OUT)}`);
  fs.rmSync(work, { recursive: true, force: true });
}

// ── 2. Windows .ico ────────────────────────────────────────────────────────
//
// The .ico format since Vista accepts PNG data embedded per directory entry.
// Layout:
//   ICONDIR        (6 bytes)
//   ICONDIRENTRY × N (16 bytes each)
//   <PNG data concatenated>
//
// We resize the source to each required size with sips (cheap, lossless-ish
// for a downscale), then stitch the bytes ourselves so we don't need
// ImageMagick or a runtime npm dep.
function buildIco() {
  if (process.platform !== 'darwin') {
    console.warn('[build-icons] not on macOS — sips needed for .ico rebuild; skipping');
    return;
  }

  const sizes = [16, 32, 48, 64, 128, 256];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-ico-'));
  const pngs = sizes.map(px => {
    const out = path.join(work, `${px}.png`);
    execFileSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px), SRC, '--out', out], { stdio: 'ignore' });
    return { px, buf: fs.readFileSync(out) };
  });

  // Header + directory entries
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);             // reserved
  header.writeUInt16LE(1, 2);             // type 1 = .ico
  header.writeUInt16LE(pngs.length, 4);   // image count

  const entrySize = 16;
  const dirSize = entrySize * pngs.length;
  let offset = header.length + dirSize;
  const entries = pngs.map(({ px, buf }) => {
    const e = Buffer.alloc(entrySize);
    // Per spec, 0 in the width/height byte means 256.
    e.writeUInt8(px === 256 ? 0 : px, 0);
    e.writeUInt8(px === 256 ? 0 : px, 1);
    e.writeUInt8(0, 2);                   // colors in palette (none — true colour)
    e.writeUInt8(0, 3);                   // reserved
    e.writeUInt16LE(1, 4);                // colour planes
    e.writeUInt16LE(32, 6);               // bits per pixel
    e.writeUInt32LE(buf.length, 8);       // size of image data
    e.writeUInt32LE(offset, 12);          // offset of image data
    offset += buf.length;
    return e;
  });

  fs.writeFileSync(ICO_OUT, Buffer.concat([header, ...entries, ...pngs.map(p => p.buf)]));
  console.log(`[build-icons] wrote ${path.relative(ROOT, ICO_OUT)}`);
  fs.rmSync(work, { recursive: true, force: true });
}

buildIcns();
buildIco();
console.log('[build-icons] done.');
