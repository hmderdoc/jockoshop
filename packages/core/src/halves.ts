/**
 * What the top and bottom of a cell show.
 *
 * A cell is one character with two colours, so the finest thing it can say is
 * "this half is one colour, that half is another" — the half blocks ▀ and ▄.
 * Matting an image and cleaning a silhouette both need to ask a cell what it
 * looks like up top and down below, and to rebuild it keeping only one half.
 */
import { type Color } from "./color.js";
import { type GlyphInfo, GlyphClass } from "./glyphs.js";
import { CH_BG, CH_FG, CH_GLYPH } from "./grid.js";

/** ▀ paints the foreground on top; ▄ paints it below. */
export const UPPER_HALF = 223, LOWER_HALF = 220, FULL_BLOCK = 219, SPACE = 32;

/**
 * The colour each half of a cell shows, or -1 where the channel it needs is
 * absent. A glyph that mixes its colours rather than splitting them (a shade,
 * a letter, ▌ or ▐) reports its dominant colour for both halves: the eye reads
 * such a cell as one colour, which is what a matte has to act on.
 */
export function cellHalves(glyph: number, fg: Color, bg: Color, present: number, glyphs: GlyphInfo): [Color, Color] {
  const f = present & CH_FG ? fg : -1, b = present & CH_BG ? bg : -1;
  if (!(present & CH_GLYPH)) return [f >= 0 ? f : b, f >= 0 ? f : b];
  switch (glyphs.classes[glyph]) {
    case GlyphClass.Empty: return [b, b];
    case GlyphClass.Full: return [f, f];
    case GlyphClass.Upper: return [f, b];
    case GlyphClass.Lower: return [b, f];
    default: {
      // ▌▐, shades and letters: whichever colour covers more of the cell
      const cov = glyphs.coverage?.[glyph];
      const inky = cov !== undefined ? cov >= 0.5 : glyph !== SPACE && glyph !== 0 && glyph !== 255;
      const d = inky ? (f >= 0 ? f : b) : (b >= 0 ? b : f);
      return [d, d];
    }
  }
}

/** The half block that shows `color` on the chosen half and lets the other half through. */
export function halfCell(keepTop: boolean, color: Color): { glyph: number; fg: Color } {
  return { glyph: keepTop ? UPPER_HALF : LOWER_HALF, fg: color };
}

/**
 * The glyph that keeps the *other* half of a split glyph — what is left when
 * the foreground half of ▀ is cut away is ▄, and so on. -1 when the glyph does
 * not split cleanly.
 */
export function flippedHalf(glyph: number, glyphs: GlyphInfo): number {
  switch (glyphs.classes[glyph]) {
    case GlyphClass.Upper: return LOWER_HALF;
    case GlyphClass.Lower: return UPPER_HALF;
    case GlyphClass.Left: return 222;    // ▌ -> ▐
    case GlyphClass.Right: return 221;   // ▐ -> ▌
    default: return -1;
  }
}
