/**
 * Contour ASCII: drawing the edges, not the tone.
 *
 * The other converters answer "how dark is this cell" and pick a character to
 * match. That is the wrong question for ASCII. Measured over 13,162 pure
 * low-ASCII files in a 111k-file corpus, real ASCII art is 60% stroke
 * characters (`_ - / \ | . , : ;`) against about 11% of the density ramp
 * (`@ # % & * +`), and 81% of those files are stroke-led. `_` alone is 12.6%
 * of everything drawn — an underscore is the top of a shape, not a grey level.
 * Artists are tracing outlines.
 *
 * There is also nothing else ASCII can do well. Printable ASCII reaches 39%
 * ink at its densest (`Q` in IBM VGA) where CP437's ░▒▓█ run 25/50/75/100, so
 * there is no upper half of the tonal range to shade with. Contours do not
 * need one: a line either is there or is not.
 *
 * So: blur, find the edges, thin them to a single ridge, and give each cell the
 * character whose stroke runs the way the edge through it runs — leaving
 * everything that is not an edge empty. The emptiness is most of what makes it
 * read as a drawing.
 */
import { type Color, type Rgb, VGA_PALETTE, nearestIndex, rgb } from "./color.js";
import type { BitmapFont } from "./font.js";
import { fontCandidates, isLowAscii } from "./fontmatch.js";
import { CellGrid } from "./grid.js";

export interface ContourOptions {
  /**
   * The share of edge pixels to keep, as a fraction. Relative rather than an
   * absolute level so one setting suits a flat drawing and a busy photograph:
   * low is a bare outline, high traces every crease.
   */
  keep: number;
  /**
   * How much the picture is blurred before its edges are found, in pixels.
   * This is the detail control — without any blur a photograph's grain and
   * fabric texture are all edges, and the result is a field of strokes with no
   * drawing in it. Raise it to get only the big shapes.
   */
  smooth: number;
}

export const CONTOUR_DEFAULTS: ContourOptions = { keep: 0.16, smooth: 2.2 };

/**
 * The characters a contour may be drawn with: printable ASCII whose ink is
 * sparse enough to read as a line rather than as a tone.
 *
 * Derived from the font rather than listed, so it follows whatever codepage is
 * loaded. Measured in IBM VGA 8x16, the bands come out as:
 *
 *   3-10%   . ` - ' , : _ ; ~ = ^        the fine detail and the corners
 *   10-18%  " + / < > | ( ) \ i % l { }  the strokes and the brackets
 *   18-26%  ! * I [ ] c r ? s x t v 1 …  letters, which start to read as text
 *   26%+    M N Q W B R H @ # $ …        the density ramp — the other converter's job
 *
 * so the line-like characters are the ones between about 3% and 18%.
 */
const INK_MIN = 0.03, INK_MAX = 0.18;

function contourAlphabet(font: BitmapFont): ReturnType<typeof fontCandidates> {
  const coverage = (code: number): number => {
    let bits = 0;
    for (let y = 0; y < font.height; y++) for (let r = font.glyphs[code * font.height + y]; r; r &= r - 1) bits++;
    return bits / (8 * font.height);
  };
  const band = fontCandidates(font, (c) => isLowAscii(c) && coverage(c) >= INK_MIN && coverage(c) <= INK_MAX);
  // a font whose ASCII is nothing like this still has to draw something
  return band.length ? band : fontCandidates(font, (c) => isLowAscii(c) && coverage(c) > 0);
}

/**
 * Cells of `grid` holding a character outside printable ASCII, for a document
 * that says it is ASCII. Their positions, so they can be found and fixed —
 * a count alone tells you there is a problem and not where.
 */
export function nonAsciiCells(grid: CellGrid, limit = 500): { count: number; at: { x: number; y: number; glyph: number }[] } {
  const at: { x: number; y: number; glyph: number }[] = [];
  let count = 0;
  for (let i = 0; i < grid.glyph.length; i++) {
    if (!grid.present[i]) continue;
    const g = grid.glyph[i];
    if (g >= 32 && g <= 126) continue;
    count++;
    if (at.length < limit) at.push({ x: i % grid.width, y: Math.floor(i / grid.width), glyph: g });
  }
  return { count, at };
}

/** Separable Gaussian, reflecting at the edges so a border is not a contour. */
function blur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 2));
  const kernel = new Float32Array(2 * radius + 1);
  let ksum = 0;
  for (let i = 0; i <= 2 * radius; i++) { kernel[i] = Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)); ksum += kernel[i]; }
  for (let i = 0; i <= 2 * radius; i++) kernel[i] /= ksum;
  const pass = (from: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          acc += from[sy * w + sx] * kernel[k + radius];
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}

export interface ContourInput extends Partial<ContourOptions> {
  /** the one colour the picture sits on; the ink is whatever contrasts with it */
  background?: Color;
  /** mean alpha per cell (0-255); cells under `alphaThreshold` are left absent */
  coverage?: Uint8Array;
  alphaThreshold?: number;
  /** draw every stroke in this colour instead of taking it from the picture */
  ink?: Color;
}

/**
 * Trace `rgba` as strokes on a `cols` x `rows` grid of the font's cells.
 *
 * Cells with no edge through them are left absent, not blank — so a contour
 * layer sits over whatever is beneath it without punching a hole in it.
 */
export function contourAscii(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number,
  cols: number, rows: number, font: BitmapFont,
  palette: readonly Rgb[] = VGA_PALETTE, opts: ContourInput = {},
): CellGrid {
  const grid = new CellGrid(cols, rows);
  if (cols < 1 || rows < 1 || width < 1 || height < 1) return grid;
  const keep = Math.min(1, Math.max(0.005, opts.keep ?? CONTOUR_DEFAULTS.keep));
  const smooth = Math.max(0, opts.smooth ?? CONTOUR_DEFAULTS.smooth);
  const background = opts.background ?? 0;
  const threshold = opts.alphaThreshold ?? 128;
  const cw = 8, ch = font.height;
  const w = cols * cw, h = rows * ch;

  // luminance at cell-pixel resolution, plus the colours to draw with later
  const lum = new Float32Array(w * h);
  const sample = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / w));
      const s = (sy * width + sx) * 4, d = y * w + x;
      lum[d] = (0.2126 * rgba[s] + 0.7152 * rgba[s + 1] + 0.0722 * rgba[s + 2]) / 255;
      sample[d * 3] = rgba[s]; sample[d * 3 + 1] = rgba[s + 1]; sample[d * 3 + 2] = rgba[s + 2];
    }
  }
  const soft = blur(lum, w, h, smooth);

  // Sobel per pixel, not per cell. The thinning below has to happen where the
  // edge actually is: done on the 8x16 grid it chops a continuous line into
  // scattered cells, which does not read as a drawing at all.
  const at = (x: number, y: number): number => soft[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), gm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      gy[i] = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      gm[i] = Math.hypot(gx[i], gy[i]);
    }
  }

  // thin to the ridge: a pixel survives only where it beats the two neighbours
  // across the edge, which turns a soft band into a line
  const ridge = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (gm[i] <= 0) continue;
      const dx = Math.round(gx[i] / gm[i]), dy = Math.round(gy[i] / gm[i]);
      if (gm[i] >= gm[i + dy * w + dx] && gm[i] >= gm[i - dy * w - dx]) ridge[i] = gm[i];
    }
  }

  // Hysteresis, on a threshold taken from the picture's own edge strengths so
  // `keep` means the same thing whatever the subject: strong pixels start a
  // line, weaker ones continue it. Without the weak pass a line breaks into
  // dashes wherever the contrast dips.
  //
  // The floor is what stops a relative threshold being absurd. Ranking alone
  // always finds a strongest 16% — so a picture blurred until it holds nothing
  // still gets traced, out of the arithmetic noise left behind. Sobel on
  // luminance in 0..1 gives about 4x the step it crosses, so this ignores
  // anything under a 3% change in brightness, which is not an edge by any
  // reading of the word.
  const MIN_EDGE = 0.12;
  const ranked = Array.from(ridge).filter((v) => v > MIN_EDGE).sort((a, b) => b - a);
  if (!ranked.length) return grid;
  const strong = Math.max(MIN_EDGE, ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * keep * 0.45))]);
  const weak = Math.max(MIN_EDGE, strong * 0.4);
  const edge = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < ridge.length; i++) if (ridge[i] >= strong && ridge[i] > 0) { edge[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - x) / w;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = x + ox, ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!edge[j] && ridge[j] >= weak) { edge[j] = 1; stack.push(j); }
      }
    }
  }

  // the ground, so the ink can be chosen to stand away from it
  const groundRgb: Rgb = background >= 0x1000000
    ? [(background >> 16) & 255, (background >> 8) & 255, background & 255]
    : palette[background & 15] ?? [0, 0, 0];
  const groundLum = (0.2126 * groundRgb[0] + 0.7152 * groundRgb[1] + 0.0722 * groundRgb[2]) / 255;

  // Where the edges are, softened. Matching a one-pixel ridge against a font's
  // ink exactly would be far too strict — a stroke a pixel to the side of where
  // the character draws its own would score nothing — so each candidate is
  // scored against a field that falls off either side of the ridge.
  //
  // It has to fall off quickly. At a wider tolerance `+` beats `-` on a plain
  // horizontal line: its bar catches the ridge and its stem then collects the
  // blurred tails above and below, scoring more overlap than the character that
  // is actually right. Peak-normalised, so overlap can never exceed the ink.
  const FIELD_BLUR = 0.7;
  const field = blur(Float32Array.from(edge), w, h, FIELD_BLUR);
  let peak = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > peak) peak = field[i];
  if (peak > 0) for (let i = 0; i < field.length; i++) field[i] /= peak;

  const alphabet = contourAlphabet(font);
  const minPixels = Math.max(3, Math.floor((cw * ch) / 24));
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const cell = cy * cols + cx;
      if (opts.coverage && opts.coverage[cell] < threshold) continue;
      let n = 0;
      let ir = 0, ig = 0, ib = 0, iw = 0;
      for (let y = cy * ch; y < (cy + 1) * ch; y++) {
        for (let x = cx * cw; x < (cx + 1) * cw; x++) {
          const p = y * w + x;
          if (!edge[p]) continue;
          n++;
          // weight each pixel by how far it is from the ground: on black the
          // ink comes from the bright side of the edge, on white the dark one
          const away = Math.abs(lum[p] - groundLum);
          ir += sample[p * 3] * away; ig += sample[p * 3 + 1] * away; ib += sample[p * 3 + 2] * away;
          iw += away;
        }
      }
      if (n < minPixels) continue;   // a few stray pixels is noise, not a line

      // Pick the character whose own ink lies where this cell's edge lies,
      // by soft Dice — twice the overlap over the two areas. Scoring the
      // shape rather than fitting an angle is what lets the alphabet be more
      // than six strokes: `_` and `-` and `'` are the same angle at different
      // heights, `(` and `)` the same at different sides, and the ink decides
      // between them. It is also what brings in `.` and `,` for a corner,
      // where no straight stroke fits at all.
      let glyph = alphabet[0].code, bestScore = -Infinity;
      const cellX = cx * cw, cellY = cy * ch;
      for (const cand of alphabet) {
        let overlap = 0;
        for (let k = 0; k < cand.ink.length; k++) {
          const px = cand.ink[k] % cw, py = (cand.ink[k] - px) / cw;
          overlap += field[(cellY + py) * w + cellX + px];
        }
        // Dice against the cell's actual edge pixels. `n`, not the field's
        // total — the field's blurred tails would swamp the ink term and turn
        // this into "cover as much as possible", which picks the densest
        // character that reaches the line rather than the one shaped like it.
        const score = (2 * overlap) / (cand.ink.length + n);
        if (score > bestScore) { bestScore = score; glyph = cand.code; }
      }
      let fg: Color;
      if (opts.ink !== undefined) fg = opts.ink;
      else if (iw > 0) fg = nearestIndex(rgb(Math.round(ir / iw), Math.round(ig / iw), Math.round(ib / iw)), palette, 16);
      else fg = 7;
      // an edge the same colour as the ground would be invisible; the picture
      // said so, but a drawing nobody can see is not the answer
      if (fg === background) fg = groundLum > 0.5 ? 0 : 15;
      grid.setAt(cell, { glyph, fg, bg: background });
    }
  }
  return grid;
}
