#!/usr/bin/env node
'use strict';

/**
 * Draw the Verity app icon (`npm run icon`).
 *
 * Writes two files from the blocky mascot, scaled up with hard pixel edges:
 *   - assets/icon.png  — 256x256, what the running window passes to Electron;
 *   - assets/icon.ico  — multi-size, what Windows shows for the packaged app and
 *                        the installer.
 *
 * Both are drawn from `globalThis.VERITY_MARK` in src/renderer/icons.js, which is
 * also what the chrome strip, the new tab page and the panel render from — so the
 * face on the taskbar cannot drift from the face in the browser.
 *
 * Plain Node, no Electron: the images are encoded here rather than rendered, which
 * keeps this runnable anywhere and byte-identical between runs.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Loading the renderer's icon set is enough: it publishes the mark on globalThis.
require(path.join(__dirname, '..', 'src', 'renderer', 'icons.js'));

const MARK = globalThis.VERITY_MARK;
const OUT_DIR = path.join(__dirname, '..', 'assets');

/** Windows picks from these; 256 is the largest size it asks for. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const PNG_SIZE = 256;

if (!MARK || !MARK.cells || MARK.size !== 16) {
  console.error('[icon] could not read VERITY_MARK from src/renderer/icons.js');
  process.exit(1);
}

function channels(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
    255,
  ];
}

/** The mark, rasterised into a square RGBA buffer at `size` pixels. */
function rasterise(size) {
  if (size % MARK.size !== 0) throw new Error(`size ${size} is not a multiple of the ${MARK.size}-cell grid`);
  const scale = size / MARK.size;
  const buffer = Buffer.alloc(size * size * 4, 0); // transparent
  for (const cell of MARK.cells) {
    const [x, y, w, h] = cell.rect;
    const [r, g, b, a] = channels(MARK.colors[cell.key]);
    for (let py = y * scale; py < (y + h) * scale; py += 1) {
      for (let px = x * scale; px < (x + w) * scale; px += 1) {
        const offset = (py * size + px) * 4;
        buffer[offset] = r;
        buffer[offset + 1] = g;
        buffer[offset + 2] = b;
        buffer[offset + 3] = a;
      }
    }
  }
  return buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A square RGBA PNG of the mark, at `size`. */
function png(size) {
  const rgba = rasterise(size);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * An ICO container of PNG-compressed entries.
 *
 * The directory is 6 bytes of header plus 16 per entry; each entry points at its
 * own PNG further down the file. Windows has read PNG entries since Vista, and
 * Explorer, the taskbar and the installer all pick the size they need from here.
 */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    // 256 is encoded as 0, because the field is a single byte.
    directory[at] = image.size === 256 ? 0 : image.size;
    directory[at + 1] = image.size === 256 ? 0 : image.size;
    directory[at + 2] = 0; // palette colours
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const pngPath = path.join(OUT_DIR, 'icon.png');
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(pngPath, png(PNG_SIZE));
fs.writeFileSync(icoPath, ico(ICO_SIZES));

console.log(`[icon] wrote ${path.relative(process.cwd(), pngPath)} (${PNG_SIZE}x${PNG_SIZE})`);
console.log(`[icon] wrote ${path.relative(process.cwd(), icoPath)} (${ICO_SIZES.join(', ')})`);
