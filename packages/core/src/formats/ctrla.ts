/**
 * Synchronet Ctrl-A colour codes, as used in message bodies and menus:
 * \x01 followed by K/B/G/C/R/M/Y/W (foreground), 0-7 (background, in ANSI
 * colour order), H (bright), I (blink), N (normal), and \x01 + 0x80-0xFF = a
 * run of (byte - 0x7f) blank cells. Compatible with PabloDraw's reader/writer
 * and with HERMedIT's fseditor-derived transition rules: bright and blink can
 * only be cleared by a full \x01N reset.
 */
import { CH_ALL, CellGrid } from "../grid.js";
import { type Rgb, VGA_PALETTE, nearestIndex } from "../color.js";
import type { ImportedArt } from "./ansi.js";
import { parseSauce } from "./sauce.js";

const FG = "KBGCRMYW";      // indexed by VGA colour 0-7
const BG = "04261537";      // Ctrl-A digit for VGA background 0-7

/** Looks like Ctrl-A text: has \x01 codes and no ANSI escapes. */
export function isCtrlA(bytes: Uint8Array): boolean {
  let codes = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x1b) return false;
    if (bytes[i] === 0x01 && bytes[i + 1] > 0x20) codes++;
  }
  return codes > 0;
}

export function parseCtrlA(bytes: Uint8Array, opts: { width?: number } = {}): ImportedArt {
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const W = opts.width ?? (found?.sauce.tinfo1 || 80);
  const rows: { glyph: number; fg: number; bg: number }[][] = [];
  let x = 0, y = 0, fg = 7, bg = 0, high = false, blink = false;
  const put = (glyph: number): void => {
    while (rows.length <= y) rows.push([]);
    if (x < W) rows[y][x] = { glyph, fg: fg + (high ? 8 : 0), bg: bg + (blink ? 8 : 0) };
    if (++x >= W) { x = 0; y++; }
  };
  let i = 0;
  while (i < end) {
    const c = bytes[i++];
    if (c === 0x0d) { x = 0; continue; }
    if (c === 0x0a) { y++; continue; }
    if (c !== 0x01) { put(c); continue; }
    if (i >= end) break;
    const code = bytes[i++];
    if (code >= 0x80) { for (let n = code - 0x7f; n > 0; n--) put(32); continue; }
    const ch = String.fromCharCode(code), up = ch.toUpperCase();
    const bgi = BG.indexOf(ch), fgi = FG.indexOf(up);
    if (bgi >= 0) bg = bgi;
    else if (fgi >= 0) fg = fgi;
    else if (up === "H") high = true;
    else if (up === "I") blink = true;
    else if (up === "N") { fg = 7; bg = 0; high = blink = false; }
    else if (up === "A") put(1);
    else if (up === "Z") break;
    else if (up === "L") { rows.length = 0; x = y = 0; }
    else if (ch === "<") { if (x > 0) x--; }
    else if (up === "J" || up === "[" || up === "]" || ch === ">" || up === "P" || up === "Q" || ch === "+" || ch === "-" || ch === "_") { /* screen and stack controls: nothing to draw */ }
  }
  const H = Math.max(1, rows.length);
  const grid = CellGrid.filled(W, H, 32, 7, 0);
  rows.forEach((row, ry) => row.forEach((cell, rx) => { if (cell) grid.set(rx, ry, cell); }));
  grid.present.fill(CH_ALL);
  return { grid, sauce: found?.sauce ?? null, iceColors: false, letterSpacing9px: false, fontName: found?.sauce.fontName || "IBM VGA" };
}

/** 24-bit colours fall to the nearest palette entry; a background of 8-15 is written as blink. */
export function encodeCtrlA(grid: CellGrid, palette: readonly Rgb[] = VGA_PALETTE): Uint8Array {
  const out: number[] = [];
  const code = (c: string): void => { out.push(1, c.charCodeAt(0)); };
  let fg = 7, bg = 0, high = false, blink = false;
  code("N");
  const transition = (nf: number, nb: number): void => {
    const nHigh = nf >= 8, nBlink = nb >= 8, f = nf & 7, b = nb & 7;
    if ((high && !nHigh) || (blink && !nBlink)) { code("N"); fg = 7; bg = 0; high = blink = false; }
    if (nBlink && !blink) { code("I"); blink = true; }
    if (nHigh && !high) { code("H"); high = true; }
    if (b !== bg) { code(BG[b]); bg = b; }
    if (f !== fg) { code(FG[f]); fg = f; }
  };
  let run = 0;
  const flushRun = (): void => {
    if (run > 2) out.push(1, run + 0x7f); else for (let n = 0; n < run; n++) out.push(32);
    run = 0;
  };
  for (let y = 0; y < grid.height; y++) {
    let last = grid.width - 1;
    const cellAt = (x: number): [number, number, number] => {
      const i = grid.index(x, y), p = grid.present[i];
      return [p & 1 ? grid.glyph[i] : 32, nearestIndex(p & 2 ? grid.fg[i] : 7, palette, 16), nearestIndex(p & 4 ? grid.bg[i] : 0, palette, 16)];
    };
    while (last >= 0) { const [g, , b] = cellAt(last); if ((g === 32 || g === 0 || g === 255) && b === 0) last--; else break; }
    for (let x = 0; x <= last; x++) {
      const [g, f, b] = cellAt(x);
      if ((g === 32 || g === 0 || g === 255) && (b & 7) === 0) {   // a black space: colour then count it, as PabloDraw does
        transition(f, b);
        if (++run === 128) flushRun();
        continue;
      }
      flushRun();
      transition(f, b);
      if (g === 1) code("A"); else out.push(g === 0 || g === 255 ? 32 : g);
    }
    flushRun();
    if (last < grid.width - 1 || y === grid.height - 1) out.push(13, 10);
  }
  code("Z");
  return Uint8Array.from(out);
}
