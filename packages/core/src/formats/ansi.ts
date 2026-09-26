import { type Color, type Rgb, VGA_PALETTE, isRgb, nearestIndex, rgb, toRgb } from "../color.js";
import { CH_ALL, CellGrid } from "../grid.js";
import {
  SAUCE_DATATYPE_CHARACTER, SAUCE_FILETYPE_ANSI, SAUCE_FLAG_8PX, SAUCE_FLAG_9PX, SAUCE_FLAG_ICE,
  SAUCE_MASK_SPACING, type AspectRatio, type Sauce, type SauceRecord, aspectFromFlags, aspectToFlags,
  encodeSauce, parseSauce,
} from "./sauce.js";

export interface ImportedArt {
  grid: CellGrid;
  iceColors: boolean;
  letterSpacing9px: boolean;
  aspectRatio: AspectRatio;
  fontName: string;
  sauce: SauceRecord | null;
  palette?: Rgb[];
  /** raw font bitmap (XBIN only) */
  fontBytes?: Uint8Array;
  /**
   * 3dBBS text depth, when the file used `CSI = … z`: the protocol layer each
   * cell was written on, and each layer's Pd (centi-units behind the glass).
   */
  depthLayer?: Uint8Array;
  depths?: number[];
}

/** SGR colour number <-> VGA attribute colour. The mapping is its own inverse. */
const ANSI_VGA = [0, 4, 2, 6, 1, 5, 3, 7];

/** xterm 256-colour index to a Color. */
function color256(n: number): Color {
  if (n < 8) return ANSI_VGA[n];
  if (n < 16) return ANSI_VGA[n - 8] + 8;
  if (n < 232) {
    const c = n - 16, lv = [0, 95, 135, 175, 215, 255];
    return rgb(lv[Math.floor(c / 36)], lv[Math.floor(c / 6) % 6], lv[c % 6]);
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

/**
 * Parse ANSI art into a fully-present grid. Width comes from `width`, else
 * SAUCE, else 80. Writing the last column wraps immediately, as ANSI art
 * viewers do. Bold is fg + 8; blink is bg + 8 (see color.ts on iCE).
 */
export function parseAnsi(bytes: Uint8Array, opts: { width?: number } = {}): ImportedArt {
  const found = parseSauce(bytes);
  const sauce = found?.sauce ?? null;
  const end = found ? found.dataLength : bytes.length;
  const isText = sauce?.dataType === SAUCE_DATATYPE_CHARACTER;
  const W = opts.width ?? (isText && sauce!.tinfo1 > 0 ? sauce!.tinfo1 : 80);

  let cap = 64;
  let glyph = new Uint8Array(W * cap).fill(32);
  let fgs = new Uint32Array(W * cap).fill(7);
  let bgs = new Uint32Array(W * cap);
  let layers = new Uint8Array(W * cap);
  let curLayer = 0, sawDepth = false;
  const depths: number[] = [];
  let rows = 0;
  const ensure = (y: number): void => {
    if (y >= cap) {
      let n = cap;
      while (y >= n) n *= 2;
      const g = new Uint8Array(W * n).fill(32), f = new Uint32Array(W * n).fill(7), b = new Uint32Array(W * n), ly = new Uint8Array(W * n);
      g.set(glyph); f.set(fgs); b.set(bgs); ly.set(layers);
      glyph = g; fgs = f; bgs = b; layers = ly; cap = n;
    }
    if (y + 1 > rows) rows = y + 1;
  };

  let x = 0, y = 0, sx = 0, sy = 0;
  let bold = false, blink = false, inverse = false, fgBase = 7, bgBase = 0;
  let fgRgb: Color = -1, bgRgb: Color = -1;

  const sgr = (ps: number[]): void => {
    if (!ps.length) ps = [0];
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (p === 0) { bold = blink = inverse = false; fgBase = 7; bgBase = 0; fgRgb = bgRgb = -1; }
      else if (p === 1) { bold = true; fgRgb = -1; }   // as Moebius: bold drops a 24-bit foreground
      else if (p === 5 || p === 6) blink = true;
      else if (p === 7) inverse = true;
      else if (p === 21 || p === 22) bold = false;
      else if (p === 25) blink = false;
      else if (p === 27) inverse = false;
      else if (p >= 30 && p <= 37) { fgBase = ANSI_VGA[p - 30]; fgRgb = -1; }
      else if (p === 39) { fgBase = 7; fgRgb = -1; }
      else if (p >= 40 && p <= 47) { bgBase = ANSI_VGA[p - 40]; bgRgb = -1; }
      else if (p === 49) { bgBase = 0; bgRgb = -1; }
      else if (p >= 90 && p <= 97) { fgBase = ANSI_VGA[p - 90]; bold = true; fgRgb = -1; }
      else if (p >= 100 && p <= 107) { bgBase = ANSI_VGA[p - 100]; blink = true; bgRgb = -1; }
      else if (p === 38 || p === 48) {
        let c: Color = -1;
        if (ps[k + 1] === 5 && k + 2 < ps.length) { c = color256(ps[k + 2] & 255); k += 2; }
        else if (ps[k + 1] === 2 && k + 4 < ps.length) { c = rgb(ps[k + 2], ps[k + 3], ps[k + 4]); k += 4; }
        else break;
        if (p === 38) {
          if (isRgb(c)) fgRgb = c; else { fgRgb = -1; fgBase = c & 7; bold = c >= 8; }
        } else if (isRgb(c)) bgRgb = c; else { bgRgb = -1; bgBase = c & 7; blink = c >= 8; }
      }
    }
  };

  let i = 0;
  while (i < end) {
    const c = bytes[i++];
    if (c === 0x1a) break;
    if (c === 0x0d) { x = 0; continue; }
    if (c === 0x0a) { y++; continue; }
    if (c === 0x09) { x = Math.min(W - 1, (x + 8) & ~7); continue; }
    if (c === 0x1b) {
      if (bytes[i] !== 0x5b) continue;
      i++;
      const start = i;
      while (i < end && bytes[i] >= 0x20 && bytes[i] <= 0x3f) i++;
      if (i >= end) break;
      const final = bytes[i++];
      const body = String.fromCharCode(...bytes.subarray(start, i - 1));
      // 3dBBS text depth: CSI = Ps z selects a layer, CSI = Ps ; Pd * z sets a layer's depth
      if (final === 0x7a && body.startsWith("=")) {
        const m = /^=(\d*)(?:;(\d*))?([*+])?$/.exec(body);
        if (m) {
          sawDepth = true;
          const ps = Math.min(15, Number(m[1] || 0));
          if (m[3] === "*") depths[ps] = Math.min(1800, Number(m[2] || 0));
          else if (m[3] === "+") depths[ps] = -Math.min(1800, Number(m[2] || 0));   // in front of the glass (extension)
          else curLayer = ps;
        }
        continue;
      }
      if (body !== "" && !/^[0-9;]*$/.test(body)) continue;   // private/intermediate forms: not ours
      const ps = body === "" ? [] : body.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10)));
      const n = ps[0] || 1;
      switch (final) {
        case 0x6d: sgr(ps); break;                                        // m
        case 0x41: y = Math.max(0, y - n); break;                         // A
        case 0x42: y += n; break;                                         // B
        case 0x43: x = Math.min(W - 1, x + n); break;                     // C
        case 0x44: x = Math.max(0, x - n); break;                         // D
        case 0x48: case 0x66:                                             // H f
          y = Math.max(0, (ps[0] || 1) - 1);
          x = Math.min(W - 1, Math.max(0, (ps[1] || 1) - 1));
          break;
        case 0x73: sx = x; sy = y; break;                                 // s
        case 0x75: x = sx; y = sy; break;                                 // u
        case 0x4a:                                                        // J
          if (ps[0] === 2) { glyph.fill(32); fgs.fill(7); bgs.fill(0); x = 0; y = 0; }
          break;
        case 0x4b:                                                        // K
          if (!ps[0] && y < rows) { glyph.fill(32, y * W + x, (y + 1) * W); bgs.fill(0, y * W + x, (y + 1) * W); }
          break;
        case 0x74:                                                        // t: 24-bit colour
          if (ps.length === 4) {
            const col = rgb(ps[1], ps[2], ps[3]);
            if (ps[0] === 0) bgRgb = col; else if (ps[0] === 1) fgRgb = col;
          }
          break;
      }
      continue;
    }
    ensure(y);
    // inverse swaps whole attributes, so the bright bit travels with its colour (as Moebius does)
    const nf = fgRgb >= 0 ? fgRgb : fgBase + (bold ? 8 : 0);
    const nb = bgRgb >= 0 ? bgRgb : bgBase + (blink ? 8 : 0);
    const f = inverse ? nb : nf, b = inverse ? nf : nb;
    const o = y * W + x;
    glyph[o] = c; fgs[o] = f; bgs[o] = b; layers[o] = curLayer;
    if (++x >= W) { x = 0; y++; }
  }

  const H = Math.max(rows, 1, isText && sauce!.tinfo2 <= 10000 ? sauce!.tinfo2 : 0);
  ensure(H - 1);
  const grid = new CellGrid(W, H);
  grid.glyph.set(glyph.subarray(0, W * H));
  grid.fg.set(fgs.subarray(0, W * H));
  grid.bg.set(bgs.subarray(0, W * H));
  grid.present.fill(CH_ALL);
  const flags = sauce?.flags ?? 0;
  const depth = sawDepth ? { depthLayer: layers.slice(0, W * H), depths: Array.from({ length: 16 }, (_, n) => depths[n] ?? 0) } : {};
  return {
    grid, sauce,
    iceColors: (flags & SAUCE_FLAG_ICE) !== 0,
    letterSpacing9px: (flags & SAUCE_MASK_SPACING) === SAUCE_FLAG_9PX,
    aspectRatio: aspectFromFlags(flags),
    fontName: sauce?.fontName || "IBM VGA",
    ...depth,
  };
}

export interface AnsiExportOptions {
  iceColors: boolean;
  palette?: readonly Rgb[];
  /** omit or pass false to leave the SAUCE record off */
  sauce?: Sauce | false;
  fontName?: string;
  letterSpacing9px?: boolean;
  aspectRatio?: AspectRatio;
  /** CRLF after every row, for plain terminals that know nothing about SAUCE */
  forceNewlines?: boolean;
  /**
   * 3dBBS text depth layers (see depth.ts): `levels[n]` is layer n's signed Pd
   * and `cellLevel` says which layer each cell belongs to. Behind-the-glass
   * depths are written as `CSI = Ps ; Pd * z`; in-front ones as
   * `CSI = Ps ; Pd + z` (extension; a 0.3 client shows them at the glass).
   * Other terminals ignore all of it.
   */
  depth?: { levels: readonly number[]; cellLevel: Uint8Array };
}

/** Bytes that cannot appear as glyphs in an ANSI stream; written as a space. */
const UNWRITABLE = new Set([0x09, 0x0a, 0x0d, 0x1a, 0x1b]);

/**
 * Encode a flattened grid. Follows shadeans' conventions: full-width rows get
 * no newline (viewers wrap at the SAUCE width), rows ending in black are
 * trimmed and end with CRLF, and 24-bit colours are a complete 16-colour code
 * followed by `ESC[0;R;G;Bt` / `ESC[1;R;G;Bt`, so other viewers fall back to
 * the nearest palette colour.
 */
export function encodeAnsi(grid: CellGrid, opts: AnsiExportOptions): Uint8Array {
  const palette = opts.palette ?? VGA_PALETTE;
  const W = grid.width, H = grid.height;
  const out: number[] = [];
  const emit = (s: string): void => { for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k)); };

  let bold = false, blink = false, fgBase = 7, bgBase = 0;
  let curFg: Color = 7, curBg: Color = 0;
  emit("\x1b[0m");
  let depthLayer = 0;
  if (opts.depth) {
    // layer 0 at depth 0 is the protocol default and needs no definition
    opts.depth.levels.forEach((pd, n) => { if (n || pd) emit(pd < 0 ? `\x1b[=${n};${-pd}+z` : `\x1b[=${n};${pd}*z`); });
    emit("\x1b[=0z");   // a 0.3 client reads the `+ z` form as a layer select: start writing on layer 0 regardless
  }

  const setColors = (fg: Color, bg: Color): void => {
    if (fg === curFg && bg === curBg) return;
    const fi = nearestIndex(fg, palette, 16);
    const bi = nearestIndex(bg, palette, isRgb(bg) && !opts.iceColors ? 8 : 16);
    const wantBold = fi >= 8, wantBlink = bi >= 8;
    const truecolor = isRgb(fg) || isRgb(bg) || isRgb(curFg) || isRgb(curBg);
    const ps: number[] = [];
    if (truecolor || (bold && !wantBold) || (blink && !wantBlink)) {
      ps.push(0);
      bold = blink = false; fgBase = 7; bgBase = 0;
    }
    if (wantBold && !bold) { ps.push(1); bold = true; }
    if (wantBlink && !blink) { ps.push(5); blink = true; }
    if ((fi & 7) !== fgBase || truecolor) { fgBase = fi & 7; ps.push(30 + ANSI_VGA[fgBase]); }
    if ((bi & 7) !== bgBase || truecolor) { bgBase = bi & 7; ps.push(40 + ANSI_VGA[bgBase]); }
    if (ps.length) emit(`\x1b[${ps.join(";")}m`);
    if (isRgb(bg)) { const c = toRgb(bg); emit(`\x1b[0;${c[0]};${c[1]};${c[2]}t`); }
    if (isRgb(fg)) { const c = toRgb(fg); emit(`\x1b[1;${c[0]};${c[1]};${c[2]}t`); }
    curFg = fg; curBg = bg;
  };

  const cellAt = (i: number): [number, Color, Color] => {
    const p = grid.present[i];
    return [p & 1 ? grid.glyph[i] : 32, p & 2 ? grid.fg[i] : 7, p & 4 ? grid.bg[i] : 0];
  };
  const isBlank = (i: number): boolean => {
    const [g, , b] = cellAt(i);
    return (g === 32 || g === 0 || g === 255) && nearestIndex(b, palette) === 0 && (!isRgb(b) || toRgb(b).every((v) => v === 0));
  };

  for (let y = 0; y < H; y++) {
    let last = W - 1;
    while (last >= 0 && isBlank(y * W + last)) last--;
    for (let x = 0; x <= last; x++) {
      const [g, f, b] = cellAt(y * W + x);
      if (opts.depth && opts.depth.cellLevel[y * W + x] !== depthLayer) {
        depthLayer = opts.depth.cellLevel[y * W + x];
        emit(`\x1b[=${depthLayer}z`);
      }
      setColors(f, b);
      out.push(UNWRITABLE.has(g) ? 32 : g);
    }
    const fullRow = last === W - 1;
    if (y < H - 1 && (!fullRow || opts.forceNewlines)) {
      setColors(curFg, 0);   // some terminals paint the new line with the current background
      emit("\r\n");
    }
  }
  if (depthLayer) emit("\x1b[=0z");   // leave the terminal writing at the screen plane
  emit("\x1b[0m");

  const data = Uint8Array.from(out);
  if (!opts.sauce) return data;
  const tail = encodeSauce({
    ...opts.sauce,
    fileSize: data.length,
    dataType: SAUCE_DATATYPE_CHARACTER,
    fileType: SAUCE_FILETYPE_ANSI,
    tinfo1: W, tinfo2: H, tinfo3: 0, tinfo4: 0,
    flags: (opts.iceColors ? SAUCE_FLAG_ICE : 0) | (opts.letterSpacing9px ? SAUCE_FLAG_9PX : SAUCE_FLAG_8PX)
      | aspectToFlags(opts.aspectRatio ?? "none"),
    fontName: opts.fontName ?? "IBM VGA",
  });
  const file = new Uint8Array(data.length + tail.length);
  file.set(data);
  file.set(tail, data.length);
  return file;
}
