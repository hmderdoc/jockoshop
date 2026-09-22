/**
 * A Color is a number: 0-15 is a palette index (VGA attribute order, so
 * 1 = blue, 4 = red), anything with RGB_FLAG set is a 24-bit colour.
 *
 * Background 8-15 follows the Moebius convention: it is a bright background
 * when the document has iCE colours on, and "blink + background 0-7" when off.
 */
export type Color = number;
export type Rgb = readonly [number, number, number];

const RGB_FLAG = 0x1000000;

export const BLACK = 0, BLUE = 1, GREEN = 2, CYAN = 3, RED = 4, MAGENTA = 5, BROWN = 6, LIGHT_GRAY = 7,
  DARK_GRAY = 8, LIGHT_BLUE = 9, LIGHT_GREEN = 10, LIGHT_CYAN = 11, LIGHT_RED = 12, LIGHT_MAGENTA = 13,
  YELLOW = 14, WHITE = 15;

export const VGA_PALETTE: readonly Rgb[] = [
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
  [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
  [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
];

export function rgb(r: number, g: number, b: number): Color {
  return RGB_FLAG | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export function isRgb(c: Color): boolean {
  return c >= RGB_FLAG;
}

/** A palette index in the bright half (8-15). RGB colours are never "high". */
export function isHigh(c: Color): boolean {
  return c >= 8 && c < 16;
}

export function toRgb(c: Color, palette: readonly Rgb[] = VGA_PALETTE): Rgb {
  if (isRgb(c)) return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
  return palette[c & 15];
}

/** Equal as displayed: palette black and rgb(0,0,0) are the same colour. */
export function colorsEqual(a: Color, b: Color, palette: readonly Rgb[] = VGA_PALETTE): boolean {
  if (a === b) return true;
  if (!isRgb(a) && !isRgb(b)) return false;
  const x = toRgb(a, palette), y = toRgb(b, palette);
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB to Oklab, where distance tracks what the eye sees. Same constants as shadeans. */
export function rgbToOklab(c: Rgb): [number, number, number] {
  const r = srgbToLinear(c[0]), g = srgbToLinear(c[1]), b = srgbToLinear(c[2]);
  const l = Math.cbrt(0.41222147 * r + 0.53633255 * g + 0.051445995 * b);
  const m = Math.cbrt(0.2119035 * r + 0.6806995 * g + 0.10739696 * b);
  const s = Math.cbrt(0.08830246 * r + 0.28171885 * g + 0.6299787 * b);
  return [
    0.21045426 * l + 0.7936178 * m - 0.004072047 * s,
    1.9779985 * l - 2.4285922 * m + 0.4505937 * s,
    0.025904037 * l + 0.78277177 * m - 0.80867577 * s,
  ];
}

let vgaLabs: [number, number, number][] | undefined;

/**
 * Nearest of the first `count` palette entries, measured in Oklab like
 * shadeans. Plain RGB distance sends dark blues and greys to black, which
 * turns dark two-colour cells into black-on-black in the 16-colour fallback.
 */
export function nearestIndex(c: Color, palette: readonly Rgb[] = VGA_PALETTE, count = 16): number {
  if (!isRgb(c)) return c;
  // only the constant VGA palette is cached: a document palette can be edited in place
  const labs = palette === VGA_PALETTE ? (vgaLabs ??= VGA_PALETTE.map(rgbToOklab)) : palette.map(rgbToOklab);
  const [L, A, B] = rgbToOklab(toRgb(c, palette));
  let best = 0, bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const p = labs[i];
    const d = (p[0] - L) ** 2 + (p[1] - A) ** 2 + (p[2] - B) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
