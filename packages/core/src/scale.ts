/**
 * Scaling hand-drawn cells. Two ways, because there is no right answer for
 * text: `nearest` stretches the grid of cells (exact at whole multiples,
 * drops or repeats cells otherwise, and never invents characters);
 * re-matching (in the app, through shadeans) renders the cells to pixels,
 * scales the picture and finds new characters for it — which redraws the art
 * in shadeans' style.
 */
import { CellGrid } from "./grid.js";
import { mirrorGlyph } from "./shapes.js";

export function scaleCellsNearest(grid: CellGrid, width: number, height: number): CellGrid {
  const out = new CellGrid(Math.max(1, width), Math.max(1, height));
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(grid.height - 1, Math.floor((y + 0.5) * grid.height / out.height));
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(grid.width - 1, Math.floor((x + 0.5) * grid.width / out.width));
      const i = grid.index(sx, sy), o = out.index(x, y);
      out.glyph[o] = grid.glyph[i]; out.fg[o] = grid.fg[i]; out.bg[o] = grid.bg[i]; out.present[o] = grid.present[i];
    }
  }
  return out;
}

/** Flip left-right (glyphs that have a mirror image are swapped) or top-bottom (▀ ↔ ▄). */
export function flipCells(grid: CellGrid, axis: "x" | "y"): CellGrid {
  const out = new CellGrid(grid.width, grid.height);
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = grid.index(x, y), o = axis === "x" ? out.index(grid.width - 1 - x, y) : out.index(x, grid.height - 1 - y);
      let g = grid.glyph[i];
      if (axis === "x") g = mirrorGlyph(g);
      else if (g === 223) g = 220; else if (g === 220) g = 223;
      out.glyph[o] = g; out.fg[o] = grid.fg[i]; out.bg[o] = grid.bg[i]; out.present[o] = grid.present[i];
    }
  }
  return out;
}
