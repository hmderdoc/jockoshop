import { type Rgb, VGA_PALETTE, colorsEqual } from "./color.js";
import { type GlyphInfo, defaultGlyphInfo } from "./glyphs.js";
import { CH_BG, CH_FG, CH_GLYPH, type CellGrid, type Rect } from "./grid.js";
import type { ContentLayer, LayerMask } from "./document.js";
import { solidColor } from "./match.js";

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

/** A set of document cells. */
export class Selection {
  readonly mask: Uint8Array;

  constructor(readonly width: number, readonly height: number, mask?: Uint8Array) {
    this.mask = mask ?? new Uint8Array(width * height);
  }

  static all(width: number, height: number): Selection {
    const s = new Selection(width, height);
    s.mask.fill(1);
    return s;
  }

  static rect(width: number, height: number, rect: Rect): Selection {
    const s = new Selection(width, height);
    const x0 = Math.max(0, rect.x), x1 = Math.min(width, rect.x + rect.width);
    for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.height); y++) {
      if (x1 > x0) s.mask.fill(1, y * width + x0, y * width + x1);
    }
    return s;
  }

  static fromIndices(width: number, height: number, indices: Iterable<number>): Selection {
    const s = new Selection(width, height);
    for (const i of indices) if (i >= 0 && i < s.mask.length) s.mask[i] = 1;
    return s;
  }

  /**
   * Cells enclosed by a closed path through the given cells (a lasso): every
   * cell whose centre is inside the polygon, plus the cells the path crosses.
   */
  static polygon(width: number, height: number, path: readonly (readonly [number, number])[]): Selection {
    const s = new Selection(width, height);
    if (!path.length) return s;
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of path) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let y = Math.max(0, minY); y <= Math.min(height - 1, maxY); y++) {
      for (let x = 0; x < width; x++) {
        let inside = false;
        for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
          const [xi, yi] = path[i], [xj, yj] = path[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) s.mask[y * width + x] = 1;
      }
    }
    const mark = (x: number, y: number): void => { if (x >= 0 && y >= 0 && x < width && y < height) s.mask[y * width + x] = 1; };
    for (let i = 0; i < path.length; i++) {
      let [x0, y0] = path[i];
      const [x1, y1] = path[(i + 1) % path.length];
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      for (let err = dx + dy; ;) {
        mark(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    return s;
  }

  has(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && this.mask[y * this.width + x] === 1;
  }

  count(): number {
    let n = 0;
    for (const v of this.mask) n += v;
    return n;
  }

  bounds(): Rect | null {
    let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.mask[y * this.width + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  inverted(): Selection {
    const s = new Selection(this.width, this.height);
    for (let i = 0; i < s.mask.length; i++) s.mask[i] = this.mask[i] ? 0 : 1;
    return s;
  }

  /** Combine with a newly made selection, the way Shift/Alt-dragging does. Returns null if nothing is left. */
  static combine(current: Selection | null, made: Selection, mode: SelectMode): Selection | null {
    let out = made;
    if (current && mode !== "replace" && current.width === made.width && current.height === made.height) {
      out = new Selection(made.width, made.height);
      for (let i = 0; i < out.mask.length; i++) {
        const a = current.mask[i], b = made.mask[i];
        out.mask[i] = mode === "add" ? a | b : mode === "subtract" ? a & (b ^ 1) : a & b;
      }
    } else if (!current && (mode === "subtract" || mode === "intersect")) return null;
    return out.count() ? out : null;
  }
}

export interface WandOptions {
  /** which channels must be the same for a cell to count as "like" the clicked one; none ticked = all */
  glyph: boolean;
  fg: boolean;
  bg: boolean;
  /**
   * Compare how cells look rather than how they are spelled: every cell that
   * shows as the same flat colour matches (space on black = black █ = black on
   * black text). Cells that show two colours still compare channel by channel.
   */
  byLook: boolean;
  /** only cells connected to the clicked one; off = everywhere */
  contiguous: boolean;
  /** with contiguous: corner-touching cells count as connected */
  diagonals: boolean;
}

export const WAND_DEFAULTS: WandOptions = { glyph: true, fg: true, bg: true, byLook: false, contiguous: true, diagonals: false };

/**
 * Magic wand over a document-sized grid (one layer placed in document space, or
 * the composite). Absent channels compare equal to absent channels, so
 * clicking an empty area selects the empty area.
 */
export function selectWand(
  grid: CellGrid, x: number, y: number, opts: WandOptions,
  ctx: { palette?: readonly Rgb[]; glyphs?: GlyphInfo } = {},
): Selection {
  const W = grid.width, H = grid.height, out = new Selection(W, H);
  if (!grid.inBounds(x, y)) return out;
  const palette = ctx.palette ?? VGA_PALETTE, mc = { palette, glyphs: ctx.glyphs ?? defaultGlyphInfo() };
  const all = !opts.glyph && !opts.fg && !opts.bg;
  const useG = all || opts.glyph, useF = all || opts.fg, useB = all || opts.bg;
  const t = grid.index(x, y);
  const look = (i: number): number => solidColor(grid.glyph[i], grid.fg[i], grid.bg[i], grid.present[i], mc);
  const tLook = opts.byLook ? look(t) : -1;

  const like = (i: number): boolean => {
    if (opts.byLook) {
      const l = look(i);
      if (tLook >= 0 || l >= 0) return tLook >= 0 && l >= 0 && colorsEqual(tLook, l, palette);
    }
    const p = grid.present[i], tp = grid.present[t];
    if (useG && ((p & CH_GLYPH) !== (tp & CH_GLYPH) || (p & CH_GLYPH && grid.glyph[i] !== grid.glyph[t]))) return false;
    if (useF && ((p & CH_FG) !== (tp & CH_FG) || (p & CH_FG && !colorsEqual(grid.fg[i], grid.fg[t], palette)))) return false;
    if (useB && ((p & CH_BG) !== (tp & CH_BG) || (p & CH_BG && !colorsEqual(grid.bg[i], grid.bg[t], palette)))) return false;
    return true;
  };

  if (!opts.contiguous) {
    for (let i = 0; i < W * H; i++) if (like(i)) out.mask[i] = 1;
    return out;
  }
  const seen = new Uint8Array(W * H), stack = [t];
  seen[t] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    if (!like(i)) continue;
    out.mask[i] = 1;
    const cx = i % W, cy = (i - cx) / W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!opts.diagonals && dx && dy)) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
  }
  return out;
}

/**
 * A layer mask from a selection: the layer shows only inside the selection
 * (or only outside it, with `hide`). Sized to cover the layer's cells and the
 * selection, in the layer's own coordinates.
 */
export function maskFromSelection(layer: ContentLayer, gridWidth: number, gridHeight: number, sel: Selection, hide = false): LayerMask {
  const b = sel.bounds();
  const width = Math.max(gridWidth, b ? b.x + b.width - layer.x : 0), height = Math.max(gridHeight, b ? b.y + b.height - layer.y : 0);
  const data = new Uint8Array(Math.max(0, width) * Math.max(0, height));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = sel.has(x + layer.x, y + layer.y) !== hide ? 1 : 0;
  }
  return { width, height, data, enabled: true };
}

/** The visible part of a layer's mask, as a document selection. */
export function selectionFromMask(layer: ContentLayer, mask: LayerMask, docWidth: number, docHeight: number): Selection {
  const s = new Selection(docWidth, docHeight);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const dx = x + layer.x, dy = y + layer.y;
      if (mask.data[y * mask.width + x] && dx >= 0 && dy >= 0 && dx < docWidth && dy < docHeight) s.mask[dy * docWidth + dx] = 1;
    }
  }
  return s;
}
