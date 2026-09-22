import { type BitmapFont, glyphRow } from "./font.js";

/**
 * How a glyph divides its cell. Drives "appears solid" matching and the
 * half-block merge in the compositor.
 */
export const GlyphClass = {
  Other: 0,
  /** no foreground pixels: only the background shows (space, NUL, 255) */
  Empty: 1,
  /** all foreground pixels (█) */
  Full: 2,
  /** ▀ foreground on top */
  Upper: 3,
  /** ▄ foreground on the bottom */
  Lower: 4,
  /** ▌ foreground on the left */
  Left: 5,
  /** ▐ foreground on the right */
  Right: 6,
} as const;

export interface GlyphInfo {
  readonly classes: Uint8Array;
  /** Fraction of foreground pixels per glyph; only known when built from a font. */
  readonly coverage?: Float32Array;
}

/** CP437 by code point, for when no font bitmap is at hand. */
export function defaultGlyphInfo(): GlyphInfo {
  const classes = new Uint8Array(256);
  classes[0] = classes[32] = classes[255] = GlyphClass.Empty;
  classes[219] = GlyphClass.Full;
  classes[223] = GlyphClass.Upper;
  classes[220] = GlyphClass.Lower;
  classes[221] = GlyphClass.Left;
  classes[222] = GlyphClass.Right;
  return { classes };
}

/**
 * Classify from the actual bitmaps, so custom (XBIN) fonts are handled. A half
 * block need not split exactly in the middle: the VGA ▀ is 7 rows and ▄ is 9.
 */
export function glyphInfoFromFont(font: BitmapFont): GlyphInfo {
  const classes = new Uint8Array(256);
  const coverage = new Float32Array(256);
  const h = font.height;
  for (let code = 0; code < 256; code++) {
    let bits = 0;
    let rowsUniform = true;   // every row is 0x00 or 0xff
    let colsUniform = true;   // every row is identical
    const first = glyphRow(font, code, 0);
    let flips = 0;
    let prev = first;
    for (let y = 0; y < h; y++) {
      const row = glyphRow(font, code, y);
      for (let b = row; b; b &= b - 1) bits++;
      if (row !== 0x00 && row !== 0xff) rowsUniform = false;
      if (row !== first) colsUniform = false;
      if (row !== prev) flips++;
      prev = row;
    }
    coverage[code] = bits / (8 * h);
    if (bits === 0) classes[code] = GlyphClass.Empty;
    else if (bits === 8 * h) classes[code] = GlyphClass.Full;
    else if (rowsUniform && flips === 1) {
      const frac = bits / (8 * h);
      if (frac >= 0.25 && frac <= 0.75) classes[code] = first === 0xff ? GlyphClass.Upper : GlyphClass.Lower;
    } else if (colsUniform) {
      if (first === 0xf0) classes[code] = GlyphClass.Left;
      else if (first === 0x0f) classes[code] = GlyphClass.Right;
    }
  }
  return { classes, coverage };
}
