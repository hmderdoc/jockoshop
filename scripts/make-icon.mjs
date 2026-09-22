#!/usr/bin/env node
// The app icon, drawn as ANSI: CP437 shade blocks rendered with the VGA font,
// three overlapping "layers", scaled up pixel-for-pixel into a rounded square.
//   node scripts/make-icon.mjs            -> docs/icon.png (1024x1024), then run: npx tauri icon docs/icon.png
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const { CellGrid, createRaster, parseRawFont, renderGrid, rgb } = await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href);
const font = parseRawFont(new Uint8Array(readFileSync(join(root, "packages/core/assets/ibmstd.f16"))));

// 24 x 12 cells = 192 x 192 px
const W = 24, H = 12, BG = rgb(11, 14, 26);
const g = CellGrid.filled(W, H, 32, 7, BG);
const rect = (x0, y0, w, h, glyph, fg, edge) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const border = x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1;
    g.set(x, y, border ? { glyph: 219, fg: edge, bg: BG } : { glyph, fg, bg: BG });
  }
};
rect(2, 1, 11, 7, 176, rgb(70, 100, 255), rgb(120, 150, 255));    // back: light shade, blue
rect(7, 3, 11, 7, 177, rgb(255, 70, 210), rgb(255, 140, 235));    // middle: medium shade, magenta
rect(12, 5, 10, 6, 178, rgb(40, 230, 255), rgb(200, 250, 255));   // front: dark shade, cyan

const r = createRaster(W, H, font);
renderGrid(g, font, r, { iceColors: true });

// scale x5 with 32 px padding into 1024, rounded corners (macOS-style radius ≈ 22%)
const SIZE = 1024, SCALE = 5, PAD = (SIZE - r.width * SCALE) / 2, RADIUS = 225;
const out = new Uint8Array(SIZE * SIZE * 4);
const [br, bgc, bb] = [11, 14, 26];
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const o = (y * SIZE + x) * 4;
  // rounded square mask
  const cx = Math.max(RADIUS - x, x - (SIZE - 1 - RADIUS), 0), cy = Math.max(RADIUS - y, y - (SIZE - 1 - RADIUS), 0);
  if (cx * cx + cy * cy > RADIUS * RADIUS) continue;
  const sx = Math.floor((x - PAD) / SCALE), sy = Math.floor((y - PAD) / SCALE);
  if (sx >= 0 && sy >= 0 && sx < r.width && sy < r.height) { const i = (sy * r.width + sx) * 4; out[o] = r.data[i]; out[o + 1] = r.data[i + 1]; out[o + 2] = r.data[i + 2]; }
  else { out[o] = br; out[o + 1] = bgc; out[o + 2] = bb; }
  out[o + 3] = 255;
}

// RGBA PNG
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, body) => { const o = Buffer.alloc(12 + body.length); o.writeUInt32BE(body.length, 0); o.write(type, 4, "ascii"); body.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + body.length)), 8 + body.length); return o; };
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let y = 0; y < SIZE; y++) { raw[y * (1 + SIZE * 4)] = 0; Buffer.from(out.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (1 + SIZE * 4) + 1); }
const head = Buffer.alloc(13); head.writeUInt32BE(SIZE, 0); head.writeUInt32BE(SIZE, 4); head[8] = 8; head[9] = 6;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs/icon.png"), png);
console.log(`docs/icon.png ${SIZE}x${SIZE}`);
