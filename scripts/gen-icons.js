#!/usr/bin/env node
/**
 * Generate minimal placeholder PNG icons for the extension.
 * Produces solid-colour squares at 16×16, 48×48, 128×128 pixels.
 * No external dependencies — uses raw PNG binary encoding.
 *
 * Run:  node scripts/gen-icons.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '../extension/assets');
fs.mkdirSync(OUT, { recursive: true });

// Background colour: ISRO orange #E67E22 → R=230 G=126 B=34
const R = 230, G = 126, B = 34;

function buildPNG(size) {
  // PNG signature
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR chunk: width, height, bit depth 8, colour type 2 (RGB), compression 0, filter 0, interlace 0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 2;  // colour type RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);

  // IDAT: raw image data — each row prefixed with filter byte 0
  const rowSize = size * 3;
  const rawData = Buffer.alloc((1 + rowSize) * size);
  for (let y = 0; y < size; y++) {
    rawData[y * (1 + rowSize)] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const base = y * (1 + rowSize) + 1 + x * 3;
      rawData[base]     = R;
      rawData[base + 1] = G;
      rawData[base + 2] = B;
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);

  // IEND
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBytes, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

// CRC-32 (standard PNG checksum)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

for (const size of [16, 48, 128]) {
  const filename = `icon${size}.png`;
  fs.writeFileSync(path.join(OUT, filename), buildPNG(size));
  console.log(`Generated extension/assets/${filename} (${size}×${size} ISRO orange)`);
}
console.log('Done. Reload the extension in chrome://extensions.');
