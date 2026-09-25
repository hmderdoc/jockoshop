/**
 * Tidying a silhouette in cells.
 *
 * Photoshop's blur / smudge / smooth have no meaning on a character grid —
 * there are no pixels between the cells to push around. What does carry over
 * is *defringe*: after cutting a background away, the cells that straddled the
 * edge still hold some of it, because one character and two colours cannot say
 * "half of me is gone". This removes that leftover colour cell by cell,
 * keeping as much of the subject as the grid can express — a half block where
 * the cell split cleanly, the bare ink where the background was behind it.
 */
import { type Color, type Rgb, colorsEqual } from "./color.js";
import type { GridEdit } from "./edit.js";
import { type GlyphInfo, GlyphClass } from "./glyphs.js";
import { CH_BG, CH_FG, CH_GLYPH, type CellGrid } from "./grid.js";
import { SPACE, flippedHalf } from "./halves.js";

export interface CleanContext {
  readonly palette: readonly Rgb[];
  readonly glyphs: GlyphInfo;
}

/**
 * Take `key` out of every cell that `within` allows, so what is under the
 * layer shows through instead. Writes through a GridEdit, so the whole pass is
 * one undo step. Returns how many cells changed.
 *
 * Per cell, with the key colour found in:
 *  - both colours          -> the cell goes entirely
 *  - one half of ▀▄▌▐      -> the opposite half block keeps the other colour
 *  - the background        -> the background goes; the character's ink stays
 *  - the ink               -> the ink goes; the background colour stays
 */
export function defringe(
  edit: GridEdit, key: Color, ctx: CleanContext, within?: (x: number, y: number) => boolean,
): number {
  const { palette, glyphs } = ctx;
  const grid = edit.grid;
  let changed = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      const p = grid.present[i];
      if (!p || (within && !within(x, y))) continue;
      const fgKey = (p & CH_FG) !== 0 && colorsEqual(grid.fg[i], key, palette);
      const bgKey = (p & CH_BG) !== 0 && colorsEqual(grid.bg[i], key, palette);
      if (!fgKey && !bgKey) continue;
      const cls = p & CH_GLYPH ? glyphs.classes[grid.glyph[i]] : GlyphClass.Other;

      // nothing of the cell is anything but the key colour
      if ((fgKey && bgKey) || (fgKey && cls === GlyphClass.Full) || (bgKey && cls === GlyphClass.Empty)
        || (fgKey && !(p & CH_BG)) || (bgKey && !(p & CH_GLYPH))) {
        edit.clear(x, y);
        changed++;
        continue;
      }

      if (fgKey) {
        const flip = flippedHalf(grid.glyph[i], glyphs);
        if (flip >= 0) {   // ▀ whose top is background -> ▄ carrying what was below
          edit.set(x, y, { glyph: flip, fg: grid.bg[i] });
          edit.clear(x, y, CH_BG);
        } else {   // a shade or a letter drawn in the background colour: drop the ink
          edit.set(x, y, { glyph: SPACE });
          edit.clear(x, y, CH_FG);
        }
      } else {   // the background behind the character is background: let it through
        edit.clear(x, y, CH_BG);
      }
      changed++;
    }
  }
  return changed;
}

/**
 * Clear cells with fewer than `keep` neighbours still present — the stray
 * cells a matte leaves dotted around a subject. 4-connected; a cell on the
 * grid's edge counts its missing neighbours as absent. Decided against the
 * grid as it was, so a run of specks cannot eat itself one cell at a time.
 */
export function despeckle(edit: GridEdit, keep = 1, within?: (x: number, y: number) => boolean): number {
  const grid = edit.grid;
  const doomed: [number, number][] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      if (!grid.present[i] || (within && !within(x, y))) continue;
      let n = 0;
      if (x > 0 && grid.present[i - 1]) n++;
      if (x < grid.width - 1 && grid.present[i + 1]) n++;
      if (y > 0 && grid.present[i - grid.width]) n++;
      if (y < grid.height - 1 && grid.present[i + grid.width]) n++;
      if (n < keep) doomed.push([x, y]);
    }
  }
  for (const [x, y] of doomed) edit.clear(x, y);
  return doomed.length;
}

/**
 * The colour a set of cells is mostly made of, as displayed — what a wand
 * selection of a flat background was, so a defringe knows what to take out.
 * -1 when the cells show no single colour.
 */
export function dominantColor(
  grid: CellGrid, ctx: CleanContext, within: (x: number, y: number) => boolean,
): Color {
  const tally = new Map<Color, number>();
  const bump = (c: Color, n: number): void => { if (c >= 0) tally.set(c, (tally.get(c) ?? 0) + n); };
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      const p = grid.present[i];
      if (!p || !within(x, y)) continue;
      const cls = p & CH_GLYPH ? ctx.glyphs.classes[grid.glyph[i]] : GlyphClass.Other;
      // weight each colour by how much of the cell it covers
      if (cls === GlyphClass.Empty) bump(p & CH_BG ? grid.bg[i] : -1, 2);
      else if (cls === GlyphClass.Full) bump(p & CH_FG ? grid.fg[i] : -1, 2);
      else { bump(p & CH_FG ? grid.fg[i] : -1, 1); bump(p & CH_BG ? grid.bg[i] : -1, 1); }
    }
  }
  let best: Color = -1, bestN = 0;
  for (const [c, n] of tally) if (n > bestN) { bestN = n; best = c; }
  return best;
}
