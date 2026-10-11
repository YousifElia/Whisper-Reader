/**
 * Generates the toolbar icons.
 *
 * Written by hand rather than pulled from a design tool so the icons are
 * reproducible from source and the repo carries no binary blobs it cannot
 * regenerate. PNG encoding is done directly: node's zlib supplies the only
 * hard part, so this needs no dependencies.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon');
mkdirSync(outDir, { recursive: true });

const AMBER = [240, 165, 0];
const INK = [33, 22, 10];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixel buffer -> PNG. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with a filter byte; 0 means "none".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An amber disc with three rising bars: a level meter, which reads as "sound"
 * at 16px far better than a speech bubble or a mouth does.
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.47;
  // Supersample the disc edge and the bars, otherwise 16px looks ragged.
  const SS = 4;

  // At 16px three bars collapse into a smudge: the gaps land under one pixel
  // and the whole glyph reads as a dot. Small sizes drop to two thicker bars,
  // which is the usual favicon compromise -- legibility over fidelity.
  const small = size <= 20;
  const bars = small
    ? [
        { x: 0.28, h: 0.34 },
        { x: 0.54, h: 0.56 },
      ]
    : [
        { x: 0.30, h: 0.30 },
        { x: 0.46, h: 0.52 },
        { x: 0.62, h: 0.38 },
      ];
  const barW = small ? 0.18 : 0.1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inDisc = 0;
      let inBar = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px1 = x + (sx + 0.5) / SS;
          const py1 = y + (sy + 0.5) / SS;
          const dx = px1 - c - 0.5;
          const dy = py1 - c - 0.5;
          if (dx * dx + dy * dy <= radius * radius) inDisc++;

          const u = px1 / size;
          const v = py1 / size;
          for (const bar of bars) {
            if (u >= bar.x && u <= bar.x + barW) {
              const half = bar.h / 2;
              if (v >= 0.5 - half && v <= 0.5 + half) inBar++;
            }
          }
        }
      }

      const total = SS * SS;
      const discA = inDisc / total;
      const barA = Math.min(inBar / total, 1);
      const i = (y * size + x) * 4;

      if (discA === 0) continue;
      // Bars are drawn in ink over the amber disc.
      const mix = barA;
      px[i] = Math.round(AMBER[0] * (1 - mix) + INK[0] * mix);
      px[i + 1] = Math.round(AMBER[1] * (1 - mix) + INK[1] * mix);
      px[i + 2] = Math.round(AMBER[2] * (1 - mix) + INK[2] * mix);
      px[i + 3] = Math.round(255 * discA);
    }
  }
  return px;
}

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `${size}.png`);
  writeFileSync(file, encodePng(size, draw(size)));
  console.log(`wrote ${file}`);
}
