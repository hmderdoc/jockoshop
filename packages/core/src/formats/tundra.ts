/**
 * TundraDraw (.tnd): 24-bit colour art. Byte 24, "TUNDRA24", then a stream of
 * commands: 1 = position (y, x as big-endian u32), 2/4/6 = a character with a
 * new foreground and/or background (each as 0,r,g,b), any other byte = a
 * character in the current colours. Layout follows PabloDraw's writer.
 */
import { type Color, type Rgb, VGA_PALETTE, rgb, toRgb } from "../color.js";
import { CH_ALL, CellGrid } from "../grid.js";
import type { ImportedArt } from "./ansi.js";
import { aspectFromFlags, parseSauce } from "./sauce.js";

const ID = "TUNDRA24";

export function isTundra(bytes: Uint8Array): boolean {
  return bytes.length > 9 && bytes[0] === 24 && String.fromCharCode(...bytes.subarray(1, 9)) === ID;
}

export function parseTundra(bytes: Uint8Array, opts: { width?: number } = {}): ImportedArt {
  if (!isTundra(bytes)) throw new Error("not a TundraDraw file");
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const W = opts.width ?? (found?.sauce.tinfo1 || 80);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: { glyph: number; fg: Color; bg: Color }[][] = [];
  const put = (x: number, y: number, glyph: number, fg: Color, bg: Color): void => {
    while (rows.length <= y) rows.push([]);
    rows[y][x] = { glyph, fg, bg };
  };
  let x = 0, y = 0, fg: Color = rgb(170, 170, 170), bg: Color = rgb(0, 0, 0), i = 9;
  const advance = (): void => { if (++x >= W) { x = 0; y++; } };
  while (i < end) {
    const c = bytes[i++];
    if (c === 1) {
      if (i + 8 > end) break;
      y = v.getUint32(i, false); x = v.getUint32(i + 4, false); i += 8;
      continue;
    }
    if (c >= 2 && c <= 6) {
      if (i >= end) break;
      const ch = bytes[i++];
      if (c & 2) { if (i + 4 > end) break; fg = rgb(bytes[i + 1], bytes[i + 2], bytes[i + 3]); i += 4; }
      if (c & 4) { if (i + 4 > end) break; bg = rgb(bytes[i + 1], bytes[i + 2], bytes[i + 3]); i += 4; }
      put(x, y, ch, fg, bg);
      advance();
      continue;
    }
    put(x, y, c, fg, bg);
    advance();
  }
  const H = Math.max(1, rows.length);
  const grid = CellGrid.filled(W, H, 32, 7, 0);
  rows.forEach((row, ry) => row.forEach((cell, rx) => { if (cell && rx < W) grid.set(rx, ry, cell); }));
  grid.present.fill(CH_ALL);
  return { grid, sauce: found?.sauce ?? null, iceColors: true, letterSpacing9px: false, aspectRatio: aspectFromFlags(found?.sauce.flags ?? 0), fontName: found?.sauce.fontName || "IBM VGA" };
}

/** Every cell gets exact colours; palette colours are written through the palette. Trailing blank cells are skipped. */
export function encodeTundra(grid: CellGrid, palette: readonly Rgb[] = VGA_PALETTE): Uint8Array {
  const out: number[] = [24, ...Array.from(ID, (c) => c.charCodeAt(0))];
  const be32 = (n: number): void => { out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); };
  const col = (c: Color): void => { const [r, g, b] = toRgb(c, palette); out.push(0, r, g, b); };
  let fg = -1, bg = -1, blank = true;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = grid.index(x, y), p = grid.present[i];
      const raw = p & 1 ? grid.glyph[i] : 32, f = p & 2 ? grid.fg[i] : 7, b = p & 4 ? grid.bg[i] : 0;
      // bytes 1-6 are commands in this format, so those glyphs cannot be written: they become spaces
      const glyph = raw >= 1 && raw <= 6 ? 32 : raw;
      // a black space is nothing: the position command resumes after it
      if ((glyph === 32 || glyph === 0) && toRgb(b, palette).every((v) => v === 0)) { blank = true; continue; }
      if (blank) { out.push(1); be32(y); be32(x); blank = false; }
      let cmd = 0;
      if (glyph !== 32 && f !== fg) { cmd |= 2; fg = f; }
      if (b !== bg) { cmd |= 4; bg = b; }
      if (cmd) out.push(cmd);
      out.push(glyph);
      if (cmd & 2) col(f);
      if (cmd & 4) col(b);
    }
  }
  return Uint8Array.from(out);
}
