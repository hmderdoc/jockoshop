/**
 * Read-only formats from the DOS era, as PabloDraw reads them:
 *   Artworx ADF: version byte, 64-colour palette (6-bit), 4096-byte font, then 80-column char/attr pairs.
 *   iCE Draw IDF: "\x04" + "1.3"/"1.4", bounds (x0, y0, x1, y1 as u16), RLE char/attr pairs, then a
 *                 4096-byte font and a 16-colour palette (6-bit) at the end.
 *   Avatar AVT: text with ^V^A attr, ^V^B blink, ^V^C-^V^F cursor, ^V^G clear to EOL, ^V^H goto, ^Y repeat, ^L clear.
 */
import type { Rgb } from "../color.js";
import { CH_ALL, CellGrid } from "../grid.js";
import type { ImportedArt } from "./ansi.js";
import { cellsFromPairs } from "./bin.js";
import { aspectFromFlags, parseSauce } from "./sauce.js";

const six = (v: number): number => ((v & 63) << 2) | ((v & 63) >> 4);

/** The 16 EGA-mapped entries of a 64-colour ADF palette. */
const EGA_ORDER = [0, 1, 2, 3, 4, 5, 20, 7, 56, 57, 58, 59, 60, 61, 62, 63];

export function parseAdf(bytes: Uint8Array): ImportedArt {
  if (bytes.length < 1 + 192 + 4096) throw new Error("not an Artworx ADF file");
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const palette: Rgb[] = EGA_ORDER.map((n) => [six(bytes[1 + n * 3]), six(bytes[2 + n * 3]), six(bytes[3 + n * 3])]);
  const fontBytes = bytes.slice(193, 193 + 4096);
  const data = bytes.subarray(193 + 4096, end);
  const height = Math.max(1, Math.ceil(data.length / 160));
  return { grid: cellsFromPairs(data, 80, height), sauce: found?.sauce ?? null, iceColors: true, letterSpacing9px: false, aspectRatio: "none", fontName: "IBM VGA", palette, fontBytes };
}

export function isIdf(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 4 && bytes[1] === 0x31 && bytes[2] === 0x2e && (bytes[3] === 0x33 || bytes[3] === 0x34);
}

export function parseIdf(bytes: Uint8Array): ImportedArt {
  if (!isIdf(bytes)) throw new Error("not an iCE Draw IDF file");
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x0 = v.getUint16(4, true), y0 = v.getUint16(6, true), x1 = v.getUint16(8, true);
  let y1 = v.getUint16(10, true);
  if (bytes[3] === 0x33) y1 = y0 + 199;
  const W = Math.max(1, x1 - x0 + 1);
  const tail = end - 4096 - 48;
  const pairs: number[] = [];
  let i = 12;
  while (i + 1 < tail) {
    let count = 1, pair = v.getUint16(i, true);
    i += 2;
    if (pair === 1) { if (i + 3 >= tail) break; count = v.getUint16(i, true); pair = v.getUint16(i + 2, true); i += 4; }
    if (pair === 0) pair = 0x0700;
    for (let n = 0; n < count; n++) pairs.push(pair & 255, pair >> 8);
  }
  const fontBytes = tail >= 12 ? bytes.slice(tail, tail + 4096) : undefined;
  const palette: Rgb[] | undefined = tail >= 12 ? Array.from({ length: 16 }, (_, n) => [six(bytes[tail + 4096 + n * 3]), six(bytes[tail + 4097 + n * 3]), six(bytes[tail + 4098 + n * 3])] as Rgb) : undefined;
  const height = Math.max(1, Math.ceil(pairs.length / 2 / W));
  return { grid: cellsFromPairs(Uint8Array.from(pairs), W, height), sauce: found?.sauce ?? null, iceColors: true, letterSpacing9px: false, aspectRatio: "none", fontName: "IBM VGA", palette, fontBytes };
}

export function parseAvatar(bytes: Uint8Array, opts: { width?: number } = {}): ImportedArt {
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const W = opts.width ?? (found?.sauce.tinfo1 || 80);
  const rows: { glyph: number; fg: number; bg: number }[][] = [];
  let x = 0, y = 0, attr = 7;
  const put = (glyph: number): void => {
    while (rows.length <= y) rows.push([]);
    if (x < W) rows[y][x] = { glyph, fg: attr & 15, bg: attr >> 4 };
    if (++x >= W) { x = 0; y++; }
  };
  let i = 0;
  while (i < end) {
    const c = bytes[i++];
    if (c === 0x0a) { y++; x = 0; continue; }
    if (c === 0x0d) continue;
    if (c === 0x0c) { rows.length = 0; x = y = 0; attr = 7; continue; }
    if (c === 0x19) { if (i + 1 >= end) break; const ch = bytes[i], n = bytes[i + 1]; i += 2; for (let k = 0; k < n; k++) put(ch); continue; }
    if (c === 0x16) {
      if (i >= end) break;
      const sub = bytes[i++];
      if (sub === 1) { if (i >= end) break; attr = bytes[i++] & 0x7f; }
      else if (sub === 2) attr |= 0x80;
      else if (sub === 3) y = Math.max(0, y - 1);
      else if (sub === 4) y++;
      else if (sub === 5) x = Math.max(0, x - 1);
      else if (sub === 6) x = Math.min(W - 1, x + 1);
      else if (sub === 7) { while (rows.length <= y) rows.push([]); for (let k = x; k < W; k++) rows[y][k] = { glyph: 32, fg: attr & 15, bg: attr >> 4 }; }
      else if (sub === 8) { if (i + 1 >= end) break; x = Math.max(0, bytes[i] - 1); y = Math.max(0, bytes[i + 1] - 1); i += 2; }
      continue;
    }
    put(c);
  }
  const H = Math.max(1, rows.length);
  const grid = CellGrid.filled(W, H, 32, 7, 0);
  rows.forEach((row, ry) => row.forEach((cell, rx) => { if (cell) grid.set(rx, ry, cell); }));
  grid.present.fill(CH_ALL);
  return { grid, sauce: found?.sauce ?? null, iceColors: false, letterSpacing9px: false, aspectRatio: aspectFromFlags(found?.sauce.flags ?? 0), fontName: found?.sauce.fontName || "IBM VGA" };
}
