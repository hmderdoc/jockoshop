import type { Color } from "./color.js";

/** Channel presence bits. An absent channel is inherited from the layers below. */
export const CH_GLYPH = 1, CH_FG = 2, CH_BG = 4, CH_ALL = 7;

export interface Cell {
  glyph: number;
  fg: Color;
  bg: Color;
  present: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cell storage as parallel typed arrays, row-major. */
export class CellGrid {
  readonly width: number;
  readonly height: number;
  readonly glyph: Uint8Array;
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
  readonly present: Uint8Array;

  constructor(width: number, height: number) {
    if (width < 0 || height < 0) throw new Error("negative grid size");
    this.width = width;
    this.height = height;
    const n = width * height;
    this.glyph = new Uint8Array(n);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.present = new Uint8Array(n);
  }

  /** A grid where every cell is the same fully-present cell. */
  static filled(width: number, height: number, glyph: number, fg: Color, bg: Color): CellGrid {
    const g = new CellGrid(width, height);
    g.glyph.fill(glyph);
    g.fg.fill(fg);
    g.bg.fill(bg);
    g.present.fill(CH_ALL);
    return g;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): Cell {
    return this.getAt(this.index(x, y));
  }

  getAt(i: number): Cell {
    return { glyph: this.glyph[i], fg: this.fg[i], bg: this.bg[i], present: this.present[i] };
  }

  /** Write the given channels; channels left out keep their current state. */
  set(x: number, y: number, cell: { glyph?: number; fg?: Color; bg?: Color }): void {
    this.setAt(this.index(x, y), cell);
  }

  setAt(i: number, cell: { glyph?: number; fg?: Color; bg?: Color }): void {
    if (cell.glyph !== undefined) { this.glyph[i] = cell.glyph; this.present[i] |= CH_GLYPH; }
    if (cell.fg !== undefined) { this.fg[i] = cell.fg; this.present[i] |= CH_FG; }
    if (cell.bg !== undefined) { this.bg[i] = cell.bg; this.present[i] |= CH_BG; }
  }

  /** Make channels absent again (default: the whole cell). */
  clear(x: number, y: number, channels: number = CH_ALL): void {
    this.present[this.index(x, y)] &= ~channels;
  }

  clone(): CellGrid {
    const g = new CellGrid(this.width, this.height);
    g.glyph.set(this.glyph);
    g.fg.set(this.fg);
    g.bg.set(this.bg);
    g.present.set(this.present);
    return g;
  }

  /**
   * A new grid covering `rect` (in this grid's coordinates; may extend past
   * any edge). Cells outside the old bounds are absent.
   */
  reframed(rect: Rect): CellGrid {
    const out = new CellGrid(rect.width, rect.height);
    const x0 = Math.max(0, rect.x), x1 = Math.min(this.width, rect.x + rect.width);
    const y0 = Math.max(0, rect.y), y1 = Math.min(this.height, rect.y + rect.height);
    if (x1 <= x0) return out;
    for (let y = y0; y < y1; y++) {
      const src = y * this.width + x0, dst = (y - rect.y) * rect.width + (x0 - rect.x), n = x1 - x0;
      out.glyph.set(this.glyph.subarray(src, src + n), dst);
      out.fg.set(this.fg.subarray(src, src + n), dst);
      out.bg.set(this.bg.subarray(src, src + n), dst);
      out.present.set(this.present.subarray(src, src + n), dst);
    }
    return out;
  }

  /** Smallest rect holding every cell with any channel present, or null if empty. */
  contentBounds(): Rect | null {
    let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.present[y * this.width + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }

  equals(other: CellGrid): boolean {
    if (this.width !== other.width || this.height !== other.height) return false;
    for (let i = 0; i < this.present.length; i++) {
      const p = this.present[i];
      if (p !== other.present[i]) return false;
      if (p & CH_GLYPH && this.glyph[i] !== other.glyph[i]) return false;
      if (p & CH_FG && this.fg[i] !== other.fg[i]) return false;
      if (p & CH_BG && this.bg[i] !== other.bg[i]) return false;
    }
    return true;
  }
}
