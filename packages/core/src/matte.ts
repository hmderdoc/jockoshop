/**
 * Cutting a background out of a source image, in pixels, before it ever
 * reaches shadeans.
 *
 * Doing it afterwards cannot work: shadeans picks one character and two
 * colours per cell, so a cell straddling the silhouette comes back as a shade
 * that blends subject and background together (▒ with the sky in `fg`). No
 * selection can then remove "the sky half" of that cell, which is why deleting
 * a wand selection leaves a ragged halo. Keyed pixels are made transparent and
 * their colour is replaced by the nearest kept colour ("bleed"), so the
 * matcher only ever sees subject colours and the alpha decides where the
 * subject ends.
 */
import { type Rgb, rgbToOklab } from "./color.js";

export interface ImageMatte {
  /** 0xRRGGBB to cut away; undefined = whatever the source's border is made of */
  color?: number;
  /** 0-100: how far from the key colour still counts as background */
  tolerance: number;
  /** only the background joined to the border, so a colour inside the subject survives */
  edges: boolean;
  /** grow (+) or shrink (-) the cut, in source pixels */
  grow: number;
}

export const MATTE_DEFAULTS: ImageMatte = { tolerance: 12, edges: true, grow: 0 };

/** Tolerance 0-100 as a squared Oklab distance. 100 takes in most of the space. */
function threshold(tolerance: number): number {
  const d = (Math.max(0, Math.min(100, tolerance)) / 100) * 0.45;
  return d * d;
}

const packRgb = (c: Rgb): number => (c[0] << 16) | (c[1] << 8) | c[2];
const unpackRgb = (n: number): Rgb => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/**
 * The colour the source's border is mostly made of — the key colour when none
 * was chosen. Counted in 5-bit-per-channel buckets so JPEG noise in a flat
 * background still lands together, then averaged over the winning bucket.
 */
export function borderColor(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): number {
  const tally = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    if (rgba[i + 3] < 128) return;   // already transparent: not part of the border's colour
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    const e = tally.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += rgba[i]; e.g += rgba[i + 1]; e.b += rgba[i + 2];
    tally.set(key, e);
  };
  for (let x = 0; x < width; x++) { add(x, 0); add(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { add(0, y); add(width - 1, y); }
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const e of tally.values()) if (e.n > best.n) best = e;
  if (!best.n) return 0;
  return packRgb([Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]);
}

/** Grow (n > 0) or shrink (n < 0) the marked region by n steps, 4-connected. */
function growMask(mask: Uint8Array, width: number, height: number, n: number): void {
  const want = n > 0 ? 1 : 0, steps = Math.min(64, Math.abs(n));
  for (let s = 0; s < steps; s++) {
    const edge: number[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (mask[i] === want) continue;
        if ((x > 0 && mask[i - 1] === want) || (x < width - 1 && mask[i + 1] === want)
          || (y > 0 && mask[i - width] === want) || (y < height - 1 && mask[i + width] === want)) edge.push(i);
      }
    }
    for (const i of edge) mask[i] = want;
  }
}

/**
 * Mark every pixel the matte cuts away. Returns one byte per pixel: 1 = keyed.
 * Exported for tests and so a caller can reuse the mask without the bleed.
 */
export function matteMask(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, matte: ImageMatte,
): Uint8Array {
  const n = width * height;
  const mask = new Uint8Array(n);
  const key = rgbToOklab(unpackRgb(matte.color ?? borderColor(rgba, width, height)));
  const max = threshold(matte.tolerance);
  const like = (i: number): boolean => {
    if (rgba[i * 4 + 3] < 128) return true;   // already transparent counts as background
    const c = rgbToOklab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
    return (c[0] - key[0]) ** 2 + (c[1] - key[1]) ** 2 + (c[2] - key[2]) ** 2 <= max;
  };

  if (!matte.edges) {
    for (let i = 0; i < n; i++) if (like(i)) mask[i] = 1;
  } else {
    // flood inwards from every border pixel: colour inside the subject is kept
    const stack: number[] = [];
    const push = (i: number): void => { if (!mask[i]) { mask[i] = 1; stack.push(i); } };
    for (let x = 0; x < width; x++) { if (like(x)) push(x); if (like((height - 1) * width + x)) push((height - 1) * width + x); }
    for (let y = 0; y < height; y++) { if (like(y * width)) push(y * width); if (like(y * width + width - 1)) push(y * width + width - 1); }
    while (stack.length) {
      const i = stack.pop()!, x = i % width, y = (i - x) / width;
      if (x > 0 && like(i - 1)) push(i - 1);
      if (x < width - 1 && like(i + 1)) push(i + 1);
      if (y > 0 && like(i - width)) push(i - width);
      if (y < height - 1 && like(i + width)) push(i + width);
    }
  }
  if (matte.grow) growMask(mask, width, height, matte.grow);
  return mask;
}

/**
 * Apply a matte to RGBA pixels **in place**: keyed pixels lose their alpha and
 * take the colour of the nearest kept pixel, so the matcher sees the subject
 * continuing outwards instead of the background it is about to cut. Returns
 * how many pixels were cut.
 *
 * `bleed` is how far that colour travels; one cell is 8x16, so the default
 * covers a cell in every direction.
 */
export function applyMatte(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, matte: ImageMatte, bleed = 16,
): number {
  const n = width * height;
  const mask = matteMask(rgba, width, height, matte);
  let cut = 0;
  for (let i = 0; i < n; i++) if (mask[i]) { rgba[i * 4 + 3] = 0; cut++; }
  if (!cut || cut === n) return cut;

  // multi-source BFS out of the kept pixels, so every cut pixel takes the
  // colour of the nearest one rather than a smeared average
  let front: number[] = [];
  for (let i = 0; i < n; i++) if (!mask[i]) front.push(i);
  const done = Uint8Array.from(mask, (m) => (m ? 0 : 1));
  for (let step = 0; step < bleed && front.length; step++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % width, y = (i - x) / width;
      const spread = (j: number): void => {
        if (done[j]) return;
        done[j] = 1;
        rgba[j * 4] = rgba[i * 4]; rgba[j * 4 + 1] = rgba[i * 4 + 1]; rgba[j * 4 + 2] = rgba[i * 4 + 2];
        next.push(j);
      };
      if (x > 0) spread(i - 1);
      if (x < width - 1) spread(i + 1);
      if (y > 0) spread(i - width);
      if (y < height - 1) spread(i + width);
    }
    front = next;
  }
  return cut;
}
