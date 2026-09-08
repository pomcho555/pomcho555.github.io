// Headless preview: runs the WASM ocean simulation in Node and rasterizes
// frames to PNG so the orca silhouette can be checked without a browser.
//
//   node tools/preview.mjs [seconds] [out.png]

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, Ocean } from '../wasm/pkg/orca_ocean.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const seconds = Number(process.argv[2] ?? '0');
const outPath = process.argv[3] ?? join(root, 'dist', 'preview.png');

const W = 1280;
const H = 800;

// Dark "abyss" theme palette, same mapping the page uses.
const BG = [0x07, 0x10, 0x19];
const SHADE_COLORS = [
  { at: 0.0, rgb: [0x3d, 0x5d, 0x74] }, // body: blue-slate against the abyss
  { at: 0.45, rgb: [0x7f, 0x9d, 0xb0] }, // saddle patch
  { at: 0.62, rgb: [0x56, 0x84, 0x93] }, // drifting specks
  { at: 1.0, rgb: [0xe9, 0xf2, 0xf4] }, // white patches
];

function colorFor(shade) {
  let best = SHADE_COLORS[0];
  for (const c of SHADE_COLORS) {
    if (Math.abs(c.at - shade) < Math.abs(best.at - shade)) best = c;
  }
  return best.rgb;
}

const wasmBytes = readFileSync(join(root, 'wasm', 'pkg', 'orca_ocean_bg.wasm'));
const wasm = initSync({ module: wasmBytes });

const ocean = new Ocean(W, H, 20260908);
if (seconds === 0) {
  ocean.settle();
} else {
  for (let t = 0; t < seconds * 60; t++) ocean.tick(1 / 60);
}

const view = new Float32Array(
  wasm.memory.buffer,
  ocean.particles_ptr(),
  ocean.particles_len(),
);

// Rasterize: alpha-blend square dots over the background.
const px = new Uint8Array(W * H * 3);
for (let i = 0; i < px.length; i += 3) {
  px[i] = BG[0];
  px[i + 1] = BG[1];
  px[i + 2] = BG[2];
}

for (let i = 0; i < view.length; i += 5) {
  const x = view[i];
  const y = view[i + 1];
  const size = view[i + 2];
  const [r, g, b] = colorFor(view[i + 3]);
  const alpha = view[i + 4];
  const side = Math.max(1, Math.round(size * 2));
  const x0 = Math.round(x - side / 2);
  const y0 = Math.round(y - side / 2);
  for (let yy = y0; yy < y0 + side; yy++) {
    if (yy < 0 || yy >= H) continue;
    for (let xx = x0; xx < x0 + side; xx++) {
      if (xx < 0 || xx >= W) continue;
      const o = (yy * W + xx) * 3;
      px[o] = px[o] * (1 - alpha) + r * alpha;
      px[o + 1] = px[o + 1] * (1 - alpha) + g * alpha;
      px[o + 2] = px[o + 2] * (1 - alpha) + b * alpha;
    }
  }
}

writeFileSync(outPath, encodePng(W, H, px));
console.log(`wrote ${outPath} (${ocean.dot_count()} dots, t=${seconds}s)`);

// --- Minimal PNG encoder (RGB8, no filter) --------------------------------

function encodePng(width, height, rgb) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    rgb.subarray(y * width * 3, (y + 1) * width * 3)
      .forEach((v, i) => (raw[row + 1 + i] = v));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const buf = Buffer.alloc(12 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, 'ascii');
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(buf.subarray(4, 8 + data.length)), 8 + data.length);
  return buf;
}

var crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
