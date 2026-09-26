/**
 * `.seq` — PETSCII art the way a Commodore BBS sent it.
 *
 * The C64 equivalent of `.ans`: a stream of PETSCII bytes with control codes
 * inline. What it can say is narrower than ANSI, and the limits are the
 * machine's, not the format's:
 *
 *  - **foreground only.** Character mode has one background colour for the
 *    whole screen, held in a hardware register, so a `.seq` cannot change it
 *    per cell. Cells whose background differs from the chosen one lose it.
 *  - **reverse instead of a second colour.** A cell drawn in the background
 *    colour on the foreground is written as the reversed character.
 *  - **screen codes are not PETSCII codes.** The font bitmap is indexed by
 *    screen code — index 1 is `A`, index 65 is the spade — while the file
 *    carries PETSCII, where `A` is 65. The two differ by range.
 *
 * Colour codes and control codes are from Synchronet's `xpdev/petdefs.h`.
 */
import { type Color, C64_COLOR_CODES } from "../color.js";
import { CH_FG, CH_GLYPH, type CellGrid } from "../grid.js";

export const PET_REVERSE_ON = 18, PET_REVERSE_OFF = 146, PET_CR = 13;
/** 142 = upper case + graphics (what art uses); 14 = upper + lower case. */
export const PET_UPPER_GRAPHICS = 142, PET_UPPER_LOWER = 14;
export const PET_CLEAR = 147;

/**
 * A screen code (what the font bitmap is indexed by, and what a cell holds) as
 * the PETSCII code a file carries. The top bit of a screen code means reverse
 * video, which the file expresses with a control code instead, so this maps
 * the low 7 bits and the caller emits RVS.
 */
export function screenToPetscii(screen: number): number {
  const c = screen & 0x7f;
  if (c < 0x20) return c + 0x40;    // 0 -> '@', 1 -> 'A'
  if (c < 0x40) return c;           // 32 -> space, digits and punctuation
  if (c < 0x60) return c + 0x80;    // 64 -> 192, the graphics range
  return c + 0x40;                  // 96 -> 160
}

export interface SeqOptions {
  /**
   * The one background colour, as a C64 palette index. Cells whose background
   * is something else cannot keep it. Defaults to the commonest background in
   * the picture, which loses the least.
   */
  background?: number;
  /** start with clear-screen, so the art lands on a known screen */
  clear?: boolean;
  /** 142 upper+graphics (default, what art uses) or 14 upper+lower */
  charset?: number;
}

/** The background colour that the fewest cells would have to give up. */
export function commonestBackground(grid: CellGrid): number {
  const tally = new Map<number, number>();
  for (let i = 0; i < grid.bg.length; i++) {
    if (!grid.present[i]) continue;
    const b = grid.bg[i] & 15;
    tally.set(b, (tally.get(b) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [c, n] of tally) if (n > bestN) { bestN = n; best = c; }
  return best;
}

/**
 * Write the grid as a `.seq`. Returns the bytes; `background` says which
 * colour the whole screen is, since the file itself cannot carry it.
 */
export function encodeSeq(grid: CellGrid, opts: SeqOptions = {}): { bytes: Uint8Array; background: number; lostBackgrounds: number } {
  const background = opts.background ?? commonestBackground(grid);
  const out: number[] = [];
  if (opts.charset !== 0) out.push(opts.charset ?? PET_UPPER_GRAPHICS);
  if (opts.clear) out.push(PET_CLEAR);
  if (background < C64_COLOR_CODES.length) out.push(C64_COLOR_CODES[background]);

  let colour = -1, reversed = false, lost = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x, p = grid.present[i];
      let screen = p & CH_GLYPH ? grid.glyph[i] : 32;
      let fg: Color = p & CH_FG ? grid.fg[i] & 15 : 1;
      const bg = grid.bg[i] & 15;

      // a cell whose background is not the screen's: draw it reversed in that
      // colour instead, which is the one thing the machine can actually do
      if (p && bg !== background) {
        if (screen === 32 || !(p & CH_GLYPH)) { screen = 32 | 0x80; fg = bg; }
        else lost++;
      }
      const wantReverse = (screen & 0x80) !== 0;
      if (fg !== colour) { out.push(C64_COLOR_CODES[fg & 15]); colour = fg; }
      if (wantReverse !== reversed) { out.push(wantReverse ? PET_REVERSE_ON : PET_REVERSE_OFF); reversed = wantReverse; }
      out.push(screenToPetscii(screen));
    }
    if (reversed) { out.push(PET_REVERSE_OFF); reversed = false; }
    if (y < grid.height - 1) out.push(PET_CR);
  }
  return { bytes: Uint8Array.from(out), background, lostBackgrounds: lost };
}
