/**
 * Palette swap: a layer's `remap` sends each of the 16 palette colours to
 * another one as the layer is composited. The layer's cells are not changed,
 * so it works on live text and image layers and can be edited or removed later.
 * 24-bit colours pass through untouched.
 */

/** The six hue families in colour-wheel order, as [dark, bright] palette indices. */
export const HUES: readonly (readonly [number, number])[] = [[4, 12], [6, 14], [2, 10], [3, 11], [1, 9], [5, 13]];
export const HUE_NAMES = ["red", "yellow", "green", "cyan", "blue", "magenta"];

export function identityRemap(): number[] {
  return Array.from({ length: 16 }, (_, i) => i);
}

export function isIdentityRemap(remap: readonly number[] | undefined): boolean {
  return !remap || remap.every((v, i) => v === i);
}

export interface RemapOptions {
  /**
   * Treat the greys as a colour family too (dark grey 8 = its dark shade, light
   * grey 7 = its bright one), so "all red" tints them and randomize can turn
   * greys into a hue and a hue into greys. Grey-heavy art — most TheDraw fonts —
   * barely changes without this.
   */
  greys: boolean;
  /** White follows the greys: it becomes the bright shade of whatever light grey became. */
  white: boolean;
}

export const REMAP_DEFAULTS: RemapOptions = { greys: true, white: true };

/** [dark, bright] of every family a swap moves: the six hues, then (optionally) the greys. */
function families(opts: RemapOptions): (readonly [number, number])[] {
  return opts.greys ? [...HUES, [8, 7]] : [...HUES];
}

/** Send family f to family to(f), dark to dark and bright to bright. Black never moves. */
function familyMap(opts: RemapOptions, to: (family: number, count: number) => number): number[] {
  const m = identityRemap(), fam = families(opts);
  fam.forEach(([dark, bright], f) => { const [d, b] = fam[to(f, fam.length)]; m[dark] = d; m[bright] = b; });
  if (opts.greys && opts.white && m[7] !== 7) m[15] = m[7];
  return m;
}

export interface RemapPreset {
  name: string;
  remap: number[];
}

export function remapPresets(opts: RemapOptions = REMAP_DEFAULTS): RemapPreset[] {
  const out: RemapPreset[] = [];
  // a rotation only means something for hues: greys have no place on the wheel
  for (let k = 1; k < 6; k++) out.push({ name: `rotate hues ${k * 60}°`, remap: familyMap({ greys: false, white: false }, (f) => (f + k) % 6) });
  HUE_NAMES.forEach((n, t) => out.push({ name: `all ${n}`, remap: familyMap(opts, () => t) }));
  // only the greys (and white, if ticked) take a hue; the colours stay as they are
  HUE_NAMES.forEach((n, t) => out.push({ name: `greys → ${n}`, remap: familyMap({ greys: true, white: opts.white }, (f) => (f === 6 ? t : f)) }));
  const grey = identityRemap();
  HUES.forEach(([dark, bright]) => { grey[dark] = 8; grey[bright] = 7; });
  out.push({ name: "greyscale", remap: grey });
  // within each family; black and white stay, or every black background would turn grey
  const flip = identityRemap();
  [...HUES, [8, 7] as const].forEach(([dark, bright]) => { flip[dark] = bright; flip[bright] = dark; });
  out.push({ name: "swap bright / dark", remap: flip });
  out.push({ name: "negative", remap: identityRemap().map((i) => 15 - i) });
  return out;
}

/**
 * A random swap. Families are shuffled whole (dark stays paired with bright),
 * so shading ramps still read as ramps; `wild` shuffles all 16 colours.
 */
export function randomRemap(random: () => number = Math.random, wild = false, opts: RemapOptions = REMAP_DEFAULTS): number[] {
  const shuffle = <T>(a: T[]): T[] => {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  if (wild) return shuffle(identityRemap());
  const n = families(opts).length;
  let order = shuffle(Array.from({ length: n }, (_, i) => i));
  // with greys in play, make sure they actually move: that is what ticking the box asks for
  if (opts.greys && order[6] === 6) { const j = Math.floor(random() * 6); [order[6], order[j]] = [order[j], order[6]]; }
  if (order.every((v, i) => v === i)) order = order.map((_, i) => (i + 1) % n);
  return familyMap(opts, (f) => order[f]);
}
