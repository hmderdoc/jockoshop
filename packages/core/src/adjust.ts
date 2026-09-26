/**
 * The source adjustments an image conversion makes before matching anything.
 *
 * shadeans does these inside the WebAssembly, in Oklab, before it picks any
 * characters — which meant that when a font without CP437's ramp sent the
 * picture down the other path instead, the levels / contrast / saturation
 * sliders stopped doing anything at all. They are not matcher settings; they
 * are about the picture. So they live here, in the same order and the same
 * space shadeans uses them (`shadeans/src/source.rs`), and both converters
 * get them.
 *
 * Not reimplemented here: `local contrast` and `smooth`, which work on
 * neighbourhoods rather than single pixels, and shadeans' own `chroma lift`.
 * Those stay shadeans-only and the panel says so.
 */
import { type Rgb, oklabToRgb, rgbToOklab } from "./color.js";

export interface SourceAdjust {
  /** stretch lightness so the picture uses the whole range */
  autoLevels?: boolean;
  /** 1 = unchanged; pivots lightness about the middle */
  contrast?: number;
  /** 1 = unchanged; 0 = greyscale */
  saturation?: number;
}

/** Whether any of these would actually change a pixel. */
export function adjustsAnything(a: SourceAdjust): boolean {
  return !!a.autoLevels || (a.contrast !== undefined && a.contrast !== 1) || (a.saturation !== undefined && a.saturation !== 1);
}

/**
 * Apply them to RGBA pixels **in place**. Alpha is untouched, so a matte
 * survives; fully transparent pixels are left out of the levels statistics,
 * where their colour is meaningless.
 */
export function adjustSource(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, a: SourceAdjust): void {
  if (!adjustsAnything(a)) return;
  const n = width * height;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [l, x, y] = rgbToOklab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]] as Rgb);
    L[i] = l; A[i] = x; B[i] = y;
  }

  if (a.autoLevels) {
    // the 0.5th and 99.5th percentiles, as shadeans takes them, over the opaque pixels
    const ls: number[] = [];
    for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] >= 128) ls.push(L[i]);
    if (ls.length > 2) {
      ls.sort((x, y) => x - y);
      const lo = ls[Math.floor(ls.length / 200)], hi = ls[ls.length - 1 - Math.floor(ls.length / 200)];
      // a picture that is already one flat tone is left alone rather than blown apart
      if (hi - lo >= 0.05) {
        const scale = 1 / (hi - lo);
        for (let i = 0; i < n; i++) L[i] = (L[i] - lo) * scale;
      }
    }
  }
  const contrast = a.contrast ?? 1, sat = a.saturation ?? 1;
  if (contrast !== 1 || sat !== 1) {
    for (let i = 0; i < n; i++) {
      L[i] = 0.5 + (L[i] - 0.5) * contrast;
      A[i] *= sat; B[i] *= sat;
    }
  }

  for (let i = 0; i < n; i++) {
    const [r, g, b] = oklabToRgb([L[i], A[i], B[i]]);
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
  }
}
