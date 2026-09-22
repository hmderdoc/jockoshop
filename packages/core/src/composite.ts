/**
 * Flattens the layer stack into one fully-present grid.
 *
 * What an absent channel means, per cell of an upper layer:
 *  - nothing present, keyed out, or masked -> the cell is skipped
 *  - half block (▀▄▌▐) missing one colour -> that half is see-through. If the
 *    cell below also divides on that axis the halves merge exactly (▀ over ▄
 *    can become one ▀ with two colours); otherwise the general rule applies.
 *  - empty glyph (space) with no bg       -> skipped: nothing of it is visible
 *  - glyph with no bg                     -> the glyph sits on the colour the
 *    stack below *appears* to be there (a █ region counts as its foreground)
 *  - glyph with no fg                     -> ink takes the foreground below
 *  - no glyph                             -> only recolours what is below
 *
 * With iCE colours off, a background of 8-15 means blink, so a background the
 * compositor derives (rather than one the artist set) is dimmed to 0-7.
 */
import { type Color, type Rgb, colorsEqual, isHigh } from "./color.js";
import { type ContentLayer, type KdDocument, type KeyRule, layerGrid, visibleLayers } from "./document.js";
import { type GlyphInfo, GlyphClass, defaultGlyphInfo } from "./glyphs.js";
import { CH_ALL, CH_BG, CH_FG, CH_GLYPH, CellGrid, type Rect } from "./grid.js";
import { type MatchContext, matchesCell } from "./match.js";

export interface CompositeOptions {
  /**
   * Background inherited from a two-colour cell below: its literal background,
   * or whichever of its colours covers more of the cell (needs font coverage).
   */
  inheritBg?: "literal" | "dominant";
  glyphs?: GlyphInfo;
}

export interface Composite {
  grid: CellGrid;
  /** per cell: index into `layers` of the layer that supplied the glyph, -1 for the empty base */
  owner: Int16Array;
  /** the visible layers that were composited, bottom first */
  layers: ContentLayer[];
}

const BASE_GLYPH = 32, BASE_FG = 7, BASE_BG = 0;

/** Presence bits left after the layer's key rules; rules test the cell as stored. */
export function applyKeyRules(
  keys: readonly KeyRule[], glyph: number, fg: Color, bg: Color, present: number, ctx: MatchContext,
): number {
  let p = present;
  for (const k of keys) {
    if (!k.enabled || !matchesCell(k.match, glyph, fg, bg, present, ctx)) continue;
    if (k.drop === "cell") return 0;
    p &= ~(k.drop === "glyph" ? CH_GLYPH : k.drop === "fg" ? CH_FG : CH_BG);
  }
  return p;
}

// split() results: the two part colours along an axis, -1 = see-through
let partA = -1, partB = -1;

/** axis 0: A = upper, B = lower. axis 1: A = left, B = right. */
function split(cls: number, fg: Color, bg: Color, present: number, axis: number, palette: readonly Rgb[]): boolean {
  const f = present & CH_FG ? fg : -1, b = present & CH_BG ? bg : -1;
  if (cls === GlyphClass.Empty) { partA = partB = b; return true; }
  if (cls === GlyphClass.Full) { partA = partB = f; return true; }
  if (axis === 0) {
    if (cls === GlyphClass.Upper) { partA = f; partB = b; return true; }
    if (cls === GlyphClass.Lower) { partA = b; partB = f; return true; }
  } else {
    if (cls === GlyphClass.Left) { partA = f; partB = b; return true; }
    if (cls === GlyphClass.Right) { partA = b; partB = f; return true; }
  }
  if (f >= 0 && b >= 0 && colorsEqual(f, b, palette)) { partA = partB = b; return true; }
  return false;
}

/**
 * Composite the whole document, or just `rect` into an existing result
 * (dirty-rect update; `into.layers` is refreshed either way).
 */
export function composite(doc: KdDocument, opts: CompositeOptions = {}, rect?: Rect, into?: Composite): Composite {
  const glyphs = opts.glyphs ?? defaultGlyphInfo();
  const classes = glyphs.classes;
  const coverage = opts.inheritBg === "dominant" ? glyphs.coverage : undefined;
  const palette = doc.palette;
  const ice = doc.iceColors;
  const ctx: MatchContext = { palette, glyphs };

  const layers = visibleLayers(doc.layers);
  const W = doc.width, H = doc.height;
  const out: Composite = into && into.grid.width === W && into.grid.height === H
    ? into
    : { grid: new CellGrid(W, H), owner: new Int16Array(W * H), layers };
  out.layers = layers;
  const full = out !== into || !rect;
  const x0 = full ? 0 : Math.max(0, rect!.x), x1 = full ? W : Math.min(W, rect!.x + rect!.width);
  const y0 = full ? 0 : Math.max(0, rect!.y), y1 = full ? H : Math.min(H, rect!.y + rect!.height);

  const grids = layers.map(layerGrid);
  const og = out.grid;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let g = BASE_GLYPH, f: Color = BASE_FG, b: Color = BASE_BG, own = -1;

      for (let li = 0; li < layers.length; li++) {
        const grid = grids[li];
        if (!grid) continue;
        const L = layers[li];
        const lx = x - L.x, ly = y - L.y;
        if (lx < 0 || ly < 0 || lx >= grid.width || ly >= grid.height) continue;
        const i = ly * grid.width + lx;
        let p = grid.present[i];
        if (!p) continue;
        const mask = L.mask;
        if (mask && mask.enabled && (lx >= mask.width || ly >= mask.height || !mask.data[ly * mask.width + lx])) continue;
        const tg = grid.glyph[i];
        let tf = grid.fg[i], tb = grid.bg[i];
        if (L.keys.length) {   // key rules look at the colours as stored, before any palette swap
          p = applyKeyRules(L.keys, tg, tf, tb, p, ctx);
          if (!p) continue;
        }
        const remap = L.remap;
        if (remap) {
          if (tf < 16) tf = remap[tf];
          // with iCE off, bit 3 of a background is blink, not a colour: swap the colour, keep the flag
          if (tb < 16) tb = ice ? remap[tb] : (remap[tb & 7] & 7) | (tb & 8);
        }

        if (p === CH_ALL) { g = tg; f = tf; b = tb; own = li; continue; }

        const hasF = (p & CH_FG) !== 0, hasB = (p & CH_BG) !== 0;
        if (!(p & CH_GLYPH)) {
          if (hasF) f = tf;
          if (hasB) b = tb;
          continue;
        }

        const cls = classes[tg];
        if (cls === GlyphClass.Empty && !hasB) continue;

        if (cls >= GlyphClass.Upper && hasF !== hasB) {
          const axis = cls <= GlyphClass.Lower ? 0 : 1;
          split(cls, tf, tb, p, axis, palette);
          const tA = partA, tB = partB;
          if (split(classes[g], f, b, CH_ALL, axis, palette)) {
            const mA = tA >= 0 ? tA : partA, mB = tB >= 0 ? tB : partB;
            own = li;
            if (colorsEqual(mA, mB, palette)) {
              if (isHigh(mA)) { g = 219; f = mA; b = 0; } else { g = 32; b = mA; }
              continue;
            }
            // keep the upper layer's orientation unless that forces a blinking background
            let inkIsA = cls === GlyphClass.Upper || cls === GlyphClass.Left;
            if (!ice && isHigh(inkIsA ? mB : mA) && !isHigh(inkIsA ? mA : mB)) inkIsA = !inkIsA;
            f = inkIsA ? mA : mB;
            b = inkIsA ? mB : mA;
            if (!ice && isHigh(b)) b &= 7;
            g = axis === 0 ? (inkIsA ? 223 : 220) : (inkIsA ? 221 : 222);
            continue;
          }
        }

        // general rule
        let nb: Color;
        if (hasB) nb = tb;
        else {
          const bc = classes[g];
          if (bc === GlyphClass.Full) nb = f;
          else if (bc !== GlyphClass.Empty && coverage && coverage[g] >= 0.5) nb = f;
          else nb = b;
          if (!ice && isHigh(nb)) nb &= 7;
        }
        if (hasF) f = tf;
        g = tg; b = nb; own = li;
      }

      const o = y * W + x;
      og.glyph[o] = g; og.fg[o] = f; og.bg[o] = b; og.present[o] = CH_ALL;
      out.owner[o] = own;
    }
  }
  return out;
}
