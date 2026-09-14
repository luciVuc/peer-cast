// Generates solid brand-colored PWA PNG icons with no external deps.
// Encodes a minimal valid RGBA PNG (IHDR + IDAT + IEND) with a rounded look
// approximated by a filled square (good enough for install prompts).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "../public/icons");
mkdirSync(outDir, { recursive: true });

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
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makePng(size, [r, g, b], mark) {
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (rowBytes + 1) + 1 + x * 4;
      // Simple centered white ring "mark" for a little identity.
      const cx = size / 2;
      const cy = size / 2;
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      const ring = mark && d > 0.45 && d < 0.62;
      const dot = mark && d < 0.12;
      if (ring || dot) {
        raw[o] = 255;
        raw[o + 1] = 255;
        raw[o + 2] = 255;
      } else {
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
      }
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const brand = [14, 165, 233];
writeFileSync(resolve(outDir, "icon-192.png"), makePng(192, brand, true));
writeFileSync(resolve(outDir, "icon-512.png"), makePng(512, brand, true));
writeFileSync(
  resolve(outDir, "icon-512-maskable.png"),
  makePng(512, brand, false),
);
console.log("icons written to", outDir);
