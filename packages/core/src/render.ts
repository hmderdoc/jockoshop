import { type Rgb, VGA_PALETTE, isRgb } from "./color.js";
import { type BitmapFont } from "./font.js";
import { CH_BG, CH_FG, CH_GLYPH, type CellGrid, type Rect } from "./grid.js";

export interface RenderOptions {
  palette?: readonly Rgb[];
  /** off: background 8-15 is shown as its 0-7 colour (it would blink) */
  iceColors?: boolean;
  /** VGA 9-pixel cells: the 9th column repeats the 8th for the box-drawing range, else background */
  letterSpacing9px?: boolean;
  /** with iCE off, a background of 8-15 blinks: true draws the "off" phase (the foreground hidden) */
  blinkOff?: boolean;
}

/** Whether any cell would blink: iCE off and a palette background of 8-15. */
export function hasBlink(grid: CellGrid, iceColors: boolean): boolean {
  if (iceColors) return false;
  for (let i = 0; i < grid.bg.length; i++) if (grid.present[i] & CH_BG && grid.bg[i] >= 8 && grid.bg[i] < 16) return true;
  return false;
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major */
  data: Uint8ClampedArray;
  cellWidth: number;
  cellHeight: number;
}

export function createRaster(cols: number, rows: number, font: BitmapFont, ninePx = false): Raster {
  const cellWidth = ninePx ? 9 : 8, cellHeight = font.height;
  return {
    width: cols * cellWidth, height: rows * cellHeight, cellWidth, cellHeight,
    data: new Uint8ClampedArray(cols * cellWidth * rows * cellHeight * 4),
  };
}

/** Draw cells of `grid` (all of it, or `rect`) into a raster made by createRaster for the same grid size. */
export function renderGrid(grid: CellGrid, font: BitmapFont, raster: Raster, opts: RenderOptions = {}, rect?: Rect): void {
  const palette = opts.palette ?? VGA_PALETTE;
  const cw = raster.cellWidth, ch = raster.cellHeight, data = raster.data, stride = raster.width * 4;
  const x0 = rect ? Math.max(0, rect.x) : 0, y0 = rect ? Math.max(0, rect.y) : 0;
  const x1 = rect ? Math.min(grid.width, rect.x + rect.width) : grid.width;
  const y1 = rect ? Math.min(grid.height, rect.y + rect.height) : grid.height;
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) {
      const i = cy * grid.width + cx, p = grid.present[i];
      const code = p & CH_GLYPH ? grid.glyph[i] : 32;
      const fg = p & CH_FG ? grid.fg[i] : 7;
      let bg = p & CH_BG ? grid.bg[i] : 0;
      let hidden = false;
      if (!opts.iceColors && !isRgb(bg)) { hidden = !!opts.blinkOff && bg >= 8; bg &= 7; }
      const fr = isRgb(fg) ? (fg >> 16) & 255 : palette[fg & 15][0], fgG = isRgb(fg) ? (fg >> 8) & 255 : palette[fg & 15][1], fb = isRgb(fg) ? fg & 255 : palette[fg & 15][2];
      const br = isRgb(bg) ? (bg >> 16) & 255 : palette[bg & 15][0], bgG = isRgb(bg) ? (bg >> 8) & 255 : palette[bg & 15][1], bb = isRgb(bg) ? bg & 255 : palette[bg & 15][2];
      const extend = cw === 9 && code >= 192 && code <= 223;
      for (let y = 0; y < ch; y++) {
        const bits = font.glyphs[code * font.height + y];
        let o = (cy * ch + y) * stride + cx * cw * 4;
        for (let x = 0; x < cw; x++) {
          const on = hidden ? 0 : x < 8 ? (bits >> (7 - x)) & 1 : extend ? bits & 1 : 0;
          data[o++] = on ? fr : br;
          data[o++] = on ? fgG : bgG;
          data[o++] = on ? fb : bb;
          data[o++] = 255;
        }
      }
    }
  }
}

/**
 * A copy of `raster` scaled vertically by `factor`, for output only.
 *
 * Rows are repeated, never blended: ANSI art is 16 (or a few more) exact
 * colours, and interpolating would invent colours between them and soften
 * every block edge. Uneven row heights are the honest result of stretching a
 * character grid by a fraction — 1.2 repeats every fifth row.
 */
export function stretchRows(raster: Raster, factor: number): Raster {
  const height = Math.max(1, Math.round(raster.height * factor));
  const stride = raster.width * 4;
  const out: Raster = {
    width: raster.width, height, data: new Uint8ClampedArray(stride * height),
    cellWidth: raster.cellWidth, cellHeight: raster.cellHeight * factor,
  };
  for (let y = 0; y < height; y++) {
    const src = Math.min(raster.height - 1, Math.floor(y / factor));
    out.data.set(raster.data.subarray(src * stride, src * stride + stride), y * stride);
  }
  return out;
}
