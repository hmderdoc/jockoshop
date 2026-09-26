/**
 * The bitmap fonts a piece of ANSI art can ask for, by the name SAUCE records.
 *
 * SAUCE stores a 22-character font name (offset 106) and that name is the only
 * thing most .ans files say about how they should look. The vocabulary is not
 * free text: these are the names viewers agree on. The bitmaps themselves are
 * 8 pixels wide and 8, 14, 16 or 19 rows tall — the 9th column of a 9-pixel
 * cell is a rendering rule, not stored data (see `letterSpacing9px`).
 *
 * Names and file mapping taken from Moebius (Apache-2.0)
 * `app/libtextmode/font.js`; the bitmaps are its `app/fonts` directory. See
 * `packages/app/public/fonts/NOTICE.md`. Moebius names 66 more fonts than it
 * ships files for (CP720, CP819, CP858, CP872, Atari ATASCII and most of the
 * F19 variants); those are left out here rather than listed and then failing
 * to load — `resolveFontName` falls back to IBM VGA and says so. Upstream also
 * lists the CP866 names twice (a duplicate `case` is dead code in a switch, a
 * duplicate row here); those are folded together.
 */

export interface StandardFont {
  /** the name as SAUCE spells it */
  readonly name: string;
  /** path under the app's served fonts/ directory */
  readonly file: string;
  /** rows per glyph: the cell height */
  readonly height: number;
}

export const DEFAULT_FONT_NAME = "IBM VGA";

export const STANDARD_FONTS: readonly StandardFont[] = [
  { name: "IBM VGA", file: "ibm/CP437.F16", height: 16 },
  { name: "IBM VGA50", file: "ibm/CP437.F08", height: 8 },
  { name: "IBM VGA25G", file: "ibm/CP437.F19", height: 19 },
  { name: "IBM EGA", file: "ibm/CP437.F14", height: 14 },
  { name: "IBM EGA43", file: "ibm/CP437.F08", height: 8 },
  { name: "IBM VGA 437", file: "ibm/CP437.F16", height: 16 },
  { name: "IBM VGA50 437", file: "ibm/CP437.F08", height: 8 },
  { name: "IBM VGA25G 437", file: "ibm/CP437.F19", height: 19 },
  { name: "IBM EGA 437", file: "ibm/CP437.F14", height: 14 },
  { name: "IBM EGA43 437", file: "ibm/CP437.F08", height: 8 },
  { name: "IBM VGA 737", file: "ibm/CP737.F16", height: 16 },
  { name: "IBM VGA50 737", file: "ibm/CP737.F08", height: 8 },
  { name: "IBM EGA 737", file: "ibm/CP737.F14", height: 14 },
  { name: "IBM EGA43 737", file: "ibm/CP737.F08", height: 8 },
  { name: "IBM VGA 775", file: "ibm/CP775.F16", height: 16 },
  { name: "IBM VGA50 775", file: "ibm/CP775.F08", height: 8 },
  { name: "IBM EGA 775", file: "ibm/CP775.F14", height: 14 },
  { name: "IBM EGA43 775", file: "ibm/CP775.F08", height: 8 },
  { name: "IBM VGA 850", file: "ibm/CP850.F16", height: 16 },
  { name: "IBM VGA50 850", file: "ibm/CP850.F08", height: 8 },
  { name: "IBM VGA25G 850", file: "ibm/CP850.F19", height: 19 },
  { name: "IBM EGA 850", file: "ibm/CP850.F14", height: 14 },
  { name: "IBM EGA43 850", file: "ibm/CP850.F08", height: 8 },
  { name: "IBM VGA 852", file: "ibm/CP852.F16", height: 16 },
  { name: "IBM VGA50 852", file: "ibm/CP852.F08", height: 8 },
  { name: "IBM VGA25G 852", file: "ibm/CP852.F19", height: 19 },
  { name: "IBM EGA 852", file: "ibm/CP852.F14", height: 14 },
  { name: "IBM EGA43 852", file: "ibm/CP852.F08", height: 8 },
  { name: "IBM VGA 855", file: "ibm/CP855.F16", height: 16 },
  { name: "IBM VGA50 855", file: "ibm/CP855.F08", height: 8 },
  { name: "IBM EGA 855", file: "ibm/CP855.F14", height: 14 },
  { name: "IBM EGA43 855", file: "ibm/CP855.F08", height: 8 },
  { name: "IBM VGA 857", file: "ibm/CP857.F16", height: 16 },
  { name: "IBM VGA50 857", file: "ibm/CP857.F08", height: 8 },
  { name: "IBM EGA 857", file: "ibm/CP857.F14", height: 14 },
  { name: "IBM EGA43 857", file: "ibm/CP857.F08", height: 8 },
  { name: "IBM VGA 860", file: "ibm/CP860.F16", height: 16 },
  { name: "IBM VGA50 860", file: "ibm/CP860.F08", height: 8 },
  { name: "IBM VGA25G 860", file: "ibm/CP860.F19", height: 19 },
  { name: "IBM EGA 860", file: "ibm/CP860.F14", height: 14 },
  { name: "IBM EGA43 860", file: "ibm/CP860.F08", height: 8 },
  { name: "IBM VGA 861", file: "ibm/CP861.F16", height: 16 },
  { name: "IBM VGA50 861", file: "ibm/CP861.F08", height: 8 },
  { name: "IBM VGA25G 861", file: "ibm/CP861.F19", height: 19 },
  { name: "IBM EGA 861", file: "ibm/CP861.F14", height: 14 },
  { name: "IBM EGA43 861", file: "ibm/CP861.F08", height: 8 },
  { name: "IBM VGA 862", file: "ibm/CP862.F16", height: 16 },
  { name: "IBM VGA50 862", file: "ibm/CP862.F08", height: 8 },
  { name: "IBM EGA 862", file: "ibm/CP862.F14", height: 14 },
  { name: "IBM EGA43 862", file: "ibm/CP862.F08", height: 8 },
  { name: "IBM VGA 863", file: "ibm/CP863.F16", height: 16 },
  { name: "IBM VGA50 863", file: "ibm/CP863.F08", height: 8 },
  { name: "IBM VGA25G 863", file: "ibm/CP863.F19", height: 19 },
  { name: "IBM EGA 863", file: "ibm/CP863.F14", height: 14 },
  { name: "IBM EGA43 863", file: "ibm/CP863.F08", height: 8 },
  { name: "IBM VGA 864", file: "ibm/CP864.F16", height: 16 },
  { name: "IBM VGA50 864", file: "ibm/CP864.F08", height: 8 },
  { name: "IBM EGA 864", file: "ibm/CP864.F14", height: 14 },
  { name: "IBM EGA43 864", file: "ibm/CP864.F08", height: 8 },
  { name: "IBM VGA 865", file: "ibm/CP865.F16", height: 16 },
  { name: "IBM VGA50 865", file: "ibm/CP865.F08", height: 8 },
  { name: "IBM VGA25G 865", file: "ibm/CP865.F19", height: 19 },
  { name: "IBM EGA 865", file: "ibm/CP865.F14", height: 14 },
  { name: "IBM EGA43 865", file: "ibm/CP865.F08", height: 8 },
  { name: "IBM VGA 866", file: "ibm/CP866.F16", height: 16 },
  { name: "IBM VGA50 866", file: "ibm/CP866.F08", height: 8 },
  { name: "IBM EGA 866", file: "ibm/CP866.F14", height: 14 },
  { name: "IBM EGA43 866", file: "ibm/CP866.F08", height: 8 },
  { name: "IBM VGA 869", file: "ibm/CP869.F16", height: 16 },
  { name: "IBM VGA50 869", file: "ibm/CP869.F08", height: 8 },
  { name: "IBM EGA 869", file: "ibm/CP869.F14", height: 14 },
  { name: "IBM EGA43 869", file: "ibm/CP869.F08", height: 8 },
  { name: "IBM VGA MIK", file: "ibm/CP866.F16", height: 16 },
  { name: "IBM VGA50 MIK", file: "ibm/CP866.F08", height: 8 },
  { name: "IBM EGA MIK", file: "ibm/CP866.F14", height: 14 },
  { name: "IBM EGA43 MIK", file: "ibm/CP866.F08", height: 8 },
  { name: "Amiga Topaz 1", file: "amiga/Topaz_a500.F16", height: 16 },
  { name: "Amiga Topaz 1+", file: "amiga/TopazPlus_a500.F16", height: 16 },
  { name: "Amiga Topaz 2", file: "amiga/Topaz_a1200.F16", height: 16 },
  { name: "Amiga Topaz 2+", file: "amiga/TopazPlus_a1200.F16", height: 16 },
  { name: "Amiga P0T-NOoDLE", file: "amiga/P0T-NOoDLE.F16", height: 16 },
  { name: "Amiga MicroKnight", file: "amiga/MicroKnight.F16", height: 16 },
  { name: "Amiga MicroKnight+", file: "amiga/MicroKnightPlus.F16", height: 16 },
  { name: "Amiga mOsOul", file: "amiga/mO'sOul.F16", height: 16 },
  { name: "C64 PETSCII unshifted", file: "c64/PETSCII unshifted.F08", height: 8 },
  { name: "C64 PETSCII shifted", file: "c64/PETSCII shifted.F08", height: 8 },
];

const BY_NAME = new Map(STANDARD_FONTS.map((f) => [f.name.toLowerCase(), f]));

/** The font a name asks for, or undefined when it is not one we have. */
export function standardFont(name: string): StandardFont | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

/**
 * The font to draw a document in, given the name it asks for. An unknown name
 * is not an error: the document keeps it (so an export still records what the
 * art asks for) and the picture is drawn in IBM VGA. `known` is false then, so
 * the editor can say which font it could not supply.
 */
export function resolveFontName(name: string): { font: StandardFont; known: boolean } {
  const wanted = standardFont(name);
  return wanted ? { font: wanted, known: true } : { font: standardFont(DEFAULT_FONT_NAME)!, known: false };
}

/** Where a font layer's own embedded bitmap lives, for art that carries one (XBIN, ADF, IDF). */
export const EMBEDDED_FONT_ASSET = "assets/fonts/document.fnt";
