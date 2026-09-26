/**
 * Matching an image to whatever characters a font actually has.
 *
 * shadeans is built around CP437: it spells cells with ░ ▒ ▓ █ and the half
 * blocks, at the code points DOS puts them. Every IBM codepage shares that
 * range, so it is right for all of them — but in an Amiga font those codes are
 * ° ± ² Û Ü Ý Þ ß, and in PETSCII they are something else again. Measured ink
 * coverage of the codes shadeans picks:
 *
 *   CP437    25%  50%  75% 100%   <- the ramp it assumes
 *   Topaz    19%  31%  23%  39%   <- not even in order
 *   PETSCII  53%  70%  66%  56%
 *
 * So for those fonts the answer is not a better ramp, it is to stop assuming
 * one: read the bitmaps, and for each cell pick the character whose own shape
 * splits the pixels best. That finds PETSCII's quarter blocks by itself, and
 * works the same for a font embedded in an XBIN that nothing has ever seen.
 *
 * It is a plain least-squares match, not shadeans' dithering — no texture
 * term, no neighbour coherence. Good enough to be worth doing; not a
 * replacement for shadeans where shadeans applies.
 */
import { type Color, type Rgb, VGA_PALETTE, nearestIndex, rgb } from "./color.js";
import type { BitmapFont } from "./font.js";
import { CellGrid } from "./grid.js";

export interface FontMatchOptions {
  /** exact colours per cell instead of matching the palette */
  truecolor?: boolean;
  /** with iCE off a background of 8-15 blinks, so backgrounds stay in 0-7 */
  iceColors?: boolean;
  /** mean alpha per cell (0-255); cells under `alphaThreshold` are left absent */
  coverage?: Uint8Array;
  alphaThreshold?: number;
  /**
   * How many of the best-fitting characters to re-check once their colours
   * have been forced onto the palette. Picking purely on free colours can
   * choose a shape whose two colours then round to the same palette entry,
   * which comes out flat.
   */
  shortlist?: number;
  /**
   * One background colour for the whole picture, the way a C64 screen works:
   * in character mode the background is a single global register and only the
   * foreground is per cell. Setting it changes what the match is allowed to
   * choose, not just what it is scored against. `pickFixedBg` finds the best one.
   */
  fixedBg?: Color;
}

const srgbToLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** The ink pixels of each character that is worth trying, one entry per distinct shape. */
interface Candidate {
  code: number;
  /** indices into the cell's 8 x height pixel grid where this character has ink */
  ink: Uint16Array;
}

/**
 * One entry per distinct bitmap in the font. Fonts repeat themselves — blanks,
 * and whole ranges that are the same shape — and there is no point scoring the
 * same shape twice.
 */
export function fontCandidates(font: BitmapFont): Candidate[] {
  const h = font.height;
  const seen = new Map<string, Candidate>();
  for (let code = 0; code < 256; code++) {
    let key = "";
    const ink: number[] = [];
    for (let y = 0; y < h; y++) {
      const row = font.glyphs[code * h + y];
      key += row.toString(16).padStart(2, "0");
      for (let x = 0; x < 8; x++) if ((row >> (7 - x)) & 1) ink.push(y * 8 + x);
    }
    if (seen.has(key)) continue;
    seen.set(key, { code, ink: Uint16Array.from(ink) });
  }
  return [...seen.values()];
}

/**
 * Box-average the source down to exactly one pixel per font pixel, in linear
 * light — averaging sRGB values directly darkens edges.
 */
function resample(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH * 3);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += srgbToLinear(rgba[i]); g += srgbToLinear(rgba[i + 1]); b += srgbToLinear(rgba[i + 2]);
          n++;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

/** Squared distance in linear RGB, which is what the match minimises. */
const d2 = (ar: number, ag: number, ab: number, br: number, bg: number, bb: number): number =>
  (ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2;

/**
 * Convert an image to cells using the characters a font really has.
 *
 * For every cell and every distinct character, the character's own shape
 * splits the cell's pixels into two groups; the best colour for each group is
 * its mean, and the error is what is left over. The shape with the least error
 * wins. Nothing here knows what a "shade" or a "half block" is — if the font
 * has them, they win on their own merits, and if it does not, something else does.
 */
export function matchImageToFont(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number,
  cols: number, rows: number, font: BitmapFont,
  palette: readonly Rgb[] = VGA_PALETTE, opts: FontMatchOptions = {},
): CellGrid {
  const fh = font.height, cw = 8;
  const cellPx = cw * fh;
  const grid = new CellGrid(cols, rows);
  if (cols < 1 || rows < 1 || width < 1 || height < 1) return grid;

  const px = resample(rgba, width, height, cols * cw, rows * fh);
  const cands = fontCandidates(font);
  const bgCount = opts.iceColors ? 16 : 8;
  const fixed = opts.fixedBg;
  const shortlist = Math.max(1, opts.shortlist ?? 6);
  const threshold = opts.alphaThreshold ?? 128;

  // the palette in linear light, so a quantised choice is scored the same way
  const palLin = palette.slice(0, 16).map((c) => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])] as const);

  const cellR = new Float32Array(cellPx), cellG = new Float32Array(cellPx), cellB = new Float32Array(cellPx);
  const best: { code: number; ink: Uint16Array; err: number }[] = [];

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = cy * cols + cx;
      if (opts.coverage && opts.coverage[cell] < threshold) continue;

      // gather the cell's pixels, and its totals
      let sr = 0, sg = 0, sb = 0, sq = 0;
      for (let y = 0; y < fh; y++) {
        const src = ((cy * fh + y) * cols * cw + cx * cw) * 3;
        for (let x = 0; x < cw; x++) {
          const o = src + x * 3, k = y * cw + x;
          const r = px[o], g = px[o + 1], b = px[o + 2];
          cellR[k] = r; cellG[k] = g; cellB[k] = b;
          sr += r; sg += g; sb += b; sq += r * r + g * g + b * b;
        }
      }

      // score every distinct shape with its two best (free) colours
      best.length = 0;
      let worst = Infinity;
      for (const c of cands) {
        const n1 = c.ink.length, n0 = cellPx - n1;
        let ir = 0, ig = 0, ib = 0, isq = 0;
        for (let k = 0; k < n1; k++) {
          const i = c.ink[k], r = cellR[i], g = cellG[i], b = cellB[i];
          ir += r; ig += g; ib += b; isq += r * r + g * g + b * b;
        }
        // within-group sum of squares: Σ|x|² − |Σx|²/n, for the ink and for the rest
        const err = (n1 ? isq - (ir * ir + ig * ig + ib * ib) / n1 : 0)
          + (n0 ? (sq - isq) - ((sr - ir) ** 2 + (sg - ig) ** 2 + (sb - ib) ** 2) / n0 : 0);
        if (best.length < shortlist) {
          best.push({ code: c.code, ink: c.ink, err });
          if (best.length === shortlist) { best.sort((a, b2) => a.err - b2.err); worst = best[best.length - 1].err; }
        } else if (err < worst) {
          best[best.length - 1] = { code: c.code, ink: c.ink, err };
          best.sort((a, b2) => a.err - b2.err);
          worst = best[best.length - 1].err;
        }
      }
      if (!best.length) continue;
      if (best.length < shortlist) best.sort((a, b2) => a.err - b2.err);

      // then re-score the shortlist with the colours it will really be drawn in
      let pick = best[0], pickFg: Color = 7, pickBg: Color = 0, pickErr = Infinity;
      for (const b of best) {
        const n1 = b.ink.length, n0 = cellPx - n1;
        let ir = 0, ig = 0, ib = 0;
        for (let k = 0; k < n1; k++) { const i = b.ink[k]; ir += cellR[i]; ig += cellG[i]; ib += cellB[i]; }
        const fr = n1 ? ir / n1 : sr / cellPx, fg2 = n1 ? ig / n1 : sg / cellPx, fb = n1 ? ib / n1 : sb / cellPx;
        const br = n0 ? (sr - ir) / n0 : sr / cellPx, bg2 = n0 ? (sg - ig) / n0 : sg / cellPx, bb = n0 ? (sb - ib) / n0 : sb / cellPx;
        if (opts.truecolor && fixed === undefined) {
          // free colours are exactly what the shortlist was scored on
          if (b.err < pickErr) {
            pickErr = b.err; pick = b;
            pickFg = rgb(linearToSrgb(fr), linearToSrgb(fg2), linearToSrgb(fb));
            pickBg = rgb(linearToSrgb(br), linearToSrgb(bg2), linearToSrgb(bb));
          }
          continue;
        }
        // nearest palette entry to each group's mean, then the error those really give
        const f = nearestIndex(rgb(linearToSrgb(fr), linearToSrgb(fg2), linearToSrgb(fb)), palette, 16);
        const g0 = fixed ?? nearestIndex(rgb(linearToSrgb(br), linearToSrgb(bg2), linearToSrgb(bb)), palette, bgCount);
        const pf = palLin[f], pb = palLin[g0 < 16 ? g0 : 0];
        const err = n1 * d2(fr, fg2, fb, pf[0], pf[1], pf[2]) + n0 * d2(br, bg2, bb, pb[0], pb[1], pb[2]) + b.err;
        if (err < pickErr) { pickErr = err; pick = b; pickFg = f; pickBg = g0; }
      }
      grid.setAt(cell, { glyph: pick.code, fg: pickFg, bg: pickBg });
    }
  }
  return grid;
}

/**
 * Whether shadeans' CP437 assumptions hold for a font: it needs ░ ▒ ▓ █ to
 * climb in that order and the full block to be solid. True for every IBM
 * codepage, false for Amiga and C64.
 */
export function hasCp437Ramp(font: BitmapFont): boolean {
  const h = font.height;
  const cover = (code: number): number => {
    let bits = 0;
    for (let y = 0; y < h; y++) for (let r = font.glyphs[code * h + y]; r; r &= r - 1) bits++;
    return bits / (8 * h);
  };
  const [light, medium, dark, full] = [0xb0, 0xb1, 0xb2, 0xdb].map(cover);
  return full > 0.98 && light < medium && medium < dark && dark < full;
}

/**
 * The one background a whole picture should use, when the target only has one
 * — a C64 screen in character mode, where the background is a global register
 * and only the foreground is per cell.
 *
 * Tries each palette entry and keeps the one the picture fits best. That is 16
 * conversions, so it runs on a reduced copy: the choice of background is a
 * coarse decision and does not need every pixel.
 */
export function pickFixedBg(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number,
  cols: number, rows: number, font: BitmapFont,
  palette: readonly Rgb[] = VGA_PALETTE, opts: FontMatchOptions = {},
): Color {
  const step = Math.max(1, Math.ceil(Math.max(cols, rows) / 24));   // ~24 cells across is plenty to choose on
  const c = Math.max(1, Math.round(cols / step)), r = Math.max(1, Math.round(rows / step));
  const limit = opts.iceColors ? 16 : 8;
  let best: Color = 0, bestErr = Infinity;
  for (let bg = 0; bg < limit; bg++) {
    const grid = matchImageToFont(rgba, width, height, c, r, font, palette, { ...opts, coverage: undefined, fixedBg: bg, shortlist: 2 });
    const err = cellError(grid, rgba, width, height, c, r, font, palette);
    if (err < bestErr) { bestErr = err; best = bg; }
  }
  return best;
}

/** How far a matched grid ends up from the source, for comparing two matches of the same picture. */
export function cellError(
  grid: CellGrid, rgba: Uint8ClampedArray | Uint8Array, width: number, height: number,
  cols: number, rows: number, font: BitmapFont, palette: readonly Rgb[] = VGA_PALETTE,
): number {
  const fh = font.height, cw = 8;
  const px = resample(rgba, width, height, cols * cw, rows * fh);
  const lin = (c: Color): readonly [number, number, number] => {
    const [r, g, b] = c >= 0x1000000 ? [(c >> 16) & 255, (c >> 8) & 255, c & 255] : palette[c & 15];
    return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  };
  let err = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      if (!grid.present[i]) continue;
      const f = lin(grid.fg[i]), b = lin(grid.bg[i]), code = grid.glyph[i];
      for (let y = 0; y < fh; y++) {
        const row = font.glyphs[code * fh + y];
        const src = ((cy * fh + y) * cols * cw + cx * cw) * 3;
        for (let x = 0; x < cw; x++) {
          const want = (row >> (7 - x)) & 1 ? f : b;
          const o = src + x * 3;
          err += d2(px[o], px[o + 1], px[o + 2], want[0], want[1], want[2]);
        }
      }
    }
  }
  return err;
}
