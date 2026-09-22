/**
 * F-key character sets: the drawing convention shared by TheDraw, PabloDraw
 * and Moebius — F1–F10 type CP437 glyphs from the active set, F11/F12 cycle
 * sets. The 16 stock sets from Moebius (app/prefs.js, which credits
 * PabloDraw), as HERMedIT carries them: ten F1..F10 slots each.
 */
export const CHARSETS: readonly (readonly number[])[] = [
  [218, 191, 192, 217, 196, 179, 195, 180, 193, 194], // single-line box
  [201, 187, 200, 188, 205, 186, 204, 185, 202, 203], // double-line box
  [213, 184, 212, 190, 205, 179, 198, 181, 207, 209], // double-H / single-V box
  [214, 183, 211, 189, 196, 186, 199, 182, 208, 210], // single-H / double-V box
  [197, 206, 216, 215, 232, 232, 155, 156, 153, 239], // crosses & currency
  [176, 177, 178, 219, 223, 220, 221, 222, 254, 250], // blocks (the classic)
  [1, 2, 3, 4, 5, 6, 240, 14, 15, 32],                // faces, suits, notes
  [24, 25, 30, 31, 16, 17, 18, 29, 20, 21],           // arrows & markers
  [174, 175, 242, 243, 169, 170, 253, 246, 171, 172], // guillemets & math
  [227, 241, 244, 245, 234, 157, 228, 248, 251, 252], // greek & math
  [224, 225, 226, 229, 230, 231, 235, 236, 237, 238], // greek
  [128, 135, 165, 164, 152, 159, 247, 249, 173, 168], // ç, ñ …
  [131, 132, 133, 160, 166, 134, 142, 143, 145, 146], // accented a
  [136, 137, 138, 130, 144, 140, 139, 141, 161, 158], // accented e / i
  [147, 148, 149, 162, 167, 150, 129, 151, 163, 154], // accented o / u
  [47, 92, 40, 41, 123, 125, 91, 93, 96, 39],         // ASCII slashes / brackets
];

export const CHARSET_NAMES = [
  "single box", "double box", "double-H box", "double-V box", "crosses", "blocks", "faces & suits", "arrows",
  "quotes & math", "greek & math", "greek", "ç ñ …", "accented a", "accented e i", "accented o u", "ASCII",
];

/** The blocks set — the conventional startup default (F1–F4 = ░ ▒ ▓ █). */
export const DEFAULT_CHARSET = 5;
