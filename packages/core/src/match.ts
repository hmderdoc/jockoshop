import { type Color, type Rgb, VGA_PALETTE, colorsEqual } from "./color.js";
import { type GlyphInfo, GlyphClass, defaultGlyphInfo } from "./glyphs.js";
import { CH_BG, CH_FG, CH_GLYPH } from "./grid.js";

export type SetMatch<T> = { oneOf: readonly T[] } | { not: readonly T[] };

/**
 * A pattern over cells. A field left out matches anything. One matcher drives
 * key rules, find & replace, and select-by-match.
 */
export interface CellMatch {
  glyph?: SetMatch<number>;
  fg?: SetMatch<Color>;
  bg?: SetMatch<Color>;
  /**
   * Match by rendered look instead of literal values: the cell displays as a
   * flat block of this colour. Catches every spelling of "empty" — space on
   * black, NUL/255 on black, any glyph with fg = bg, █ with that foreground.
   */
  appearsSolid?: Color;
}

export interface MatchContext {
  readonly palette: readonly Rgb[];
  readonly glyphs: GlyphInfo;
}

export function defaultMatchContext(): MatchContext {
  return { palette: VGA_PALETTE, glyphs: defaultGlyphInfo() };
}

/**
 * The single colour a cell displays as, or -1 if it shows two colours or
 * can't be known because a channel it depends on is absent.
 */
export function solidColor(glyph: number, fg: Color, bg: Color, present: number, ctx: MatchContext): Color {
  if (!(present & CH_GLYPH)) return -1;
  const cls = ctx.glyphs.classes[glyph];
  if (cls === GlyphClass.Empty) return present & CH_BG ? bg : -1;
  if (cls === GlyphClass.Full) return present & CH_FG ? fg : -1;
  if ((present & (CH_FG | CH_BG)) === (CH_FG | CH_BG) && colorsEqual(fg, bg, ctx.palette)) return bg;
  return -1;
}

function inColorSet(set: SetMatch<Color>, c: Color, palette: readonly Rgb[]): boolean {
  if ("oneOf" in set) return set.oneOf.some((s) => colorsEqual(s, c, palette));
  return !set.not.some((s) => colorsEqual(s, c, palette));
}

function inGlyphSet(set: SetMatch<number>, g: number): boolean {
  return "oneOf" in set ? set.oneOf.includes(g) : !set.not.includes(g);
}

/**
 * A constraint on a channel only matches where that channel is present; a cell
 * with nothing present never matches.
 */
export function matchesCell(
  m: CellMatch, glyph: number, fg: Color, bg: Color, present: number, ctx: MatchContext,
): boolean {
  if (!present) return false;
  if (m.glyph && !(present & CH_GLYPH && inGlyphSet(m.glyph, glyph))) return false;
  if (m.fg && !(present & CH_FG && inColorSet(m.fg, fg, ctx.palette))) return false;
  if (m.bg && !(present & CH_BG && inColorSet(m.bg, bg, ctx.palette))) return false;
  if (m.appearsSolid !== undefined) {
    const s = solidColor(glyph, fg, bg, present, ctx);
    if (s < 0 || !colorsEqual(s, m.appearsSolid, ctx.palette)) return false;
  }
  return true;
}
