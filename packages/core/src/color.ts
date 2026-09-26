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

/**
 * The Commodore 64's sixteen colours, in the order the machine numbers them —
 * which is not VGA's order and not VGA's colours. Matching PETSCII art against
 * the VGA palette gets the shapes right and the colours wrong, so a document
 * drawn for a C64 wants this as its palette.
 *
 * Values are the widely used Pepto measurements of the VIC-II's output.
 */
export const C64_PALETTE: readonly Rgb[] = [
  [0, 0, 0], [255, 255, 255], [136, 57, 50], [103, 182, 189],
  [139, 63, 150], [85, 160, 73], [64, 49, 141], [191, 206, 114],
  [139, 84, 41], [87, 66, 0], [184, 105, 98], [80, 80, 80],
  [120, 120, 120], [148, 224, 137], [120, 105, 196], [159, 159, 159],
];

/**
 * The PETSCII control code that selects each C64 colour, by palette index —
 * what a `.seq` file writes to change the foreground. Taken from Synchronet's
 * `xpdev/petdefs.h`.
 */
export const C64_COLOR_CODES: readonly number[] = [
  144, 5, 28, 159, 156, 30, 31, 158,
  129, 149, 150, 151, 152, 153, 154, 155,
];

/** Whether a palette is the plain VGA one, so a file need not carry a copy of it. */
export function isVgaPalette(palette: readonly Rgb[]): boolean {
  if (palette.length < 16) return false;
  for (let i = 0; i < 16; i++) {
    const a = palette[i], b = VGA_PALETTE[i];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
  }
  return true;
}

/** Oklab back to sRGB, the inverse of `rgbToOklab`. */
export function oklabToRgb(lab: readonly [number, number, number]): Rgb {
  const [L, A, B] = lab;
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  }) as unknown as Rgb;
}
