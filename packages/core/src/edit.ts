import type { Color } from "./color.js";
import { CH_BG, CH_FG, CH_GLYPH, type CellGrid, type Rect } from "./grid.js";
import { type CellMatch, type MatchContext, matchesCell } from "./match.js";

/** Before/after state of a set of cells in one grid: the unit of undo for drawing. */
export interface CellPatch {
  indices: Uint32Array;
  before: CellData;
  after: CellData;
}

export interface CellData {
  glyph: Uint8Array;
  fg: Uint32Array;
  bg: Uint32Array;
  present: Uint8Array;
}

export function applyPatch(grid: CellGrid, patch: CellPatch, side: "before" | "after"): void {
  const d = patch[side];
  for (let k = 0; k < patch.indices.length; k++) {
    const i = patch.indices[k];
    grid.glyph[i] = d.glyph[k];
    grid.fg[i] = d.fg[k];
    grid.bg[i] = d.bg[k];
    grid.present[i] = d.present[k];
  }
}

/**
 * Records edits to a grid as they are made. Tools write through this, then
 * commit() yields one patch for the whole stroke/shape/replace.
 */
export class GridEdit {
  private readonly touched = new Map<number, { glyph: number; fg: Color; bg: Color; present: number }>();

  constructor(readonly grid: CellGrid) {}

  private remember(i: number): void {
    if (!this.touched.has(i)) this.touched.set(i, this.grid.getAt(i));
  }

  set(x: number, y: number, cell: { glyph?: number; fg?: Color; bg?: Color }): void {
    if (!this.grid.inBounds(x, y)) return;
    const i = this.grid.index(x, y);
    this.remember(i);
    this.grid.setAt(i, cell);
  }

  clear(x: number, y: number, channels?: number): void {
    if (!this.grid.inBounds(x, y)) return;
    this.remember(this.grid.index(x, y));
    this.grid.clear(x, y, channels);
  }

  /** The patch for everything that actually changed, or null if nothing did. */
  commit(): CellPatch | null {
    const idx: number[] = [];
    for (const [i, was] of this.touched) {
      const now = this.grid.getAt(i);
      const same = was.present === now.present
        && (!(now.present & CH_GLYPH) || was.glyph === now.glyph)
        && (!(now.present & CH_FG) || was.fg === now.fg)
        && (!(now.present & CH_BG) || was.bg === now.bg);
      if (!same) idx.push(i);
    }
    if (!idx.length) return null;
    idx.sort((a, b) => a - b);
    const n = idx.length;
    const mk = (): CellData => ({
      glyph: new Uint8Array(n), fg: new Uint32Array(n), bg: new Uint32Array(n), present: new Uint8Array(n),
    });
    const before = mk(), after = mk();
    idx.forEach((i, k) => {
      const was = this.touched.get(i)!;
      before.glyph[k] = was.glyph; before.fg[k] = was.fg; before.bg[k] = was.bg; before.present[k] = was.present;
      after.glyph[k] = this.grid.glyph[i]; after.fg[k] = this.grid.fg[i];
      after.bg[k] = this.grid.bg[i]; after.present[k] = this.grid.present[i];
    });
    this.touched.clear();
    return { indices: Uint32Array.from(idx), before, after };
  }
}

function clip(grid: CellGrid, rect?: Rect): [number, number, number, number] {
  if (!rect) return [0, 0, grid.width, grid.height];
  return [
    Math.max(0, rect.x), Math.max(0, rect.y),
    Math.min(grid.width, rect.x + rect.width), Math.min(grid.height, rect.y + rect.height),
  ];
}

/** Indices of matching cells, in reading order. Also the basis of select-by-match. */
export function findCells(grid: CellGrid, match: CellMatch, ctx: MatchContext, rect?: Rect): number[] {
  const [x0, y0, x1, y1] = clip(grid, rect);
  const hits: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * grid.width + x;
      if (matchesCell(match, grid.glyph[i], grid.fg[i], grid.bg[i], grid.present[i], ctx)) hits.push(i);
    }
  }
  return hits;
}

/** Channels left out of the replacement are kept as they are. */
export interface Replacement {
  glyph?: number;
  fg?: Color;
  bg?: Color;
}

/** Replace in place; returns the undo patch, or null if nothing matched or changed. */
export function replaceCells(
  grid: CellGrid, match: CellMatch, replacement: Replacement, ctx: MatchContext, rect?: Rect,
): CellPatch | null {
  const edit = new GridEdit(grid);
  for (const i of findCells(grid, match, ctx, rect)) {
    edit.set(i % grid.width, Math.floor(i / grid.width), replacement);
  }
  return edit.commit();
}
