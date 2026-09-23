/**
 * 3dBBS text depth. A layer's `depth` is signed centi-world-units relative to
 * the screen, matching 3dBBS's scene axes (+Z toward the viewer): 0 = at the
 * screen, negative = behind it, positive = in front (pop-out).
 *
 * On the wire (protocol 0.3) `CSI = Ps ; Pd * z` carries an unsigned distance
 * BEHIND the glass, Pd 0-1800; the device clamps anything else to the glass.
 * Front depths are written as `CSI = Ps ; Pd + z` (protocol 0.4: Pd
 * centi-units in front of the glass); a 0.3 client treats it as a harmless
 * layer select and shows that layer at the glass.
 *
 * What the numbers do on the device, from its own projection (3dBBS main.c:
 * iod = slider / 3; scene3d.c: fov 40°, D = 2 + depth; 400 px top screen),
 * as the separation between the two eyes' copies at full slider:
 *   Pd 12 → 3 px, 50 → 11 px, 100 → 18 px, 190 → 27 px, 300 → 33 px, 565 → 41 px;
 *   in front: 20 → 6 px, 30 → 10 px, 50 → 18 px, 80 → 37 px, 100 → 55 px, 135 → 114 px.
 * Past ~26 px (≈5 mm, about 1° at arm's length) the eyes struggle to fuse
 * the copies and the effect collapses; pop-out runs away fast because D
 * shrinks toward the camera. `deviceShiftPx` is that formula.
 */
import type { Composite } from "./composite.js";
import { type Rgb, VGA_PALETTE, isRgb } from "./color.js";
import type { BitmapFont } from "./font.js";
import type { Raster, RenderOptions } from "./render.js";

export const MAX_DEPTH_LAYERS = 16, MAX_PD = 1800, MAX_FRONT_PD = 100;
/** what the depth slider offers: past these the device's copies drift apart faster than eyes fuse them */
export const SLIDER_IN_PD = 300, SLIDER_OUT_PD = 60;
/** camera-to-glass distance in world units: where the two eye images coincide */
const CONVERGENCE = 2.0;
/** 3DS geometry mirrored from 3dBBS: iod = slider / 3 (main.c), fov 40°, 400×240 top screen (scene3d.c) */
const DEVICE = { iod: 1 / 3, halfTan: Math.tan((40 * Math.PI) / 180 / 2), aspect: 400 / 240, halfWidth: 200 };

/**
 * Per-eye horizontal shift, in top-screen pixels, of text at signed Pd with
 * the device's depth slider at `slider` (0..1; 1 = fully up). Negative shifts
 * cross (pop-out). Twice its magnitude is how far apart the two copies land.
 */
export function deviceShiftPx(pd: number, slider = 1): number {
  const D = Math.max(0.2, CONVERGENCE + pd / 100);
  return ((0.5 * DEVICE.iod * slider * (1 / CONVERGENCE - 1 / D)) / (DEVICE.halfTan * DEVICE.aspect)) * DEVICE.halfWidth;
}

/**
 * Editor depth -> signed Pd: positive = centi-units behind the glass (the
 * protocol's number), negative = in front (the extension), each clamped to
 * what can be shown.
 */
export function depthToPd(depth: number | undefined): number {
  const pd = Math.round(-(depth ?? 0)) || 0;   // || 0: never -0
  return pd >= 0 ? Math.min(MAX_PD, pd) : Math.max(-MAX_FRONT_PD, pd);
}

export interface DepthPlan {
  /** signed Pd of each text layer the export will define; index = protocol layer number; ascending, so the nearest is first */
  levels: number[];
  /** per document cell: index into `levels` */
  cellLevel: Uint8Array;
  /** layers in front of the screen: shown at the glass by a protocol-0.3 client */
  front: string[];
  /** true when more than 16 distinct depths had to be merged */
  merged: boolean;
}

/** Assign every flattened cell to one of at most 16 protocol depth layers, by the layer that owns it. */
export function planDepth(comp: Composite): DepthPlan {
  const front = comp.layers.filter((l) => (l.depth ?? 0) > 0).map((l) => l.name);
  const ownerPd = comp.layers.map((l) => depthToPd(l.depth));
  let levels = [...new Set([0, ...ownerPd])].sort((a, b) => a - b);
  const merged = levels.length > MAX_DEPTH_LAYERS;
  const remap = new Map<number, number>(levels.map((v) => [v, v]));
  while (levels.length > MAX_DEPTH_LAYERS) {   // merge the two closest, never moving the screen plane (0)
    let at = -1;
    for (let i = 0; i < levels.length - 1; i++) {
      if (levels[i] === 0 || levels[i + 1] === 0) continue;
      if (at < 0 || levels[i + 1] - levels[i] < levels[at + 1] - levels[at]) at = i;
    }
    if (at < 0) break;
    const a = levels[at], b = levels[at + 1], mid = Math.round((a + b) / 2);
    for (const [k, v] of remap) if (v === a || v === b) remap.set(k, mid);
    levels.splice(at, 2, mid);
  }
  levels = [...new Set(levels)].sort((a, b) => a - b);
  const cellLevel = new Uint8Array(comp.owner.length), glass = levels.indexOf(0);   // the screen plane is not index 0 when a layer pops out
  for (let i = 0; i < cellLevel.length; i++) {
    const o = comp.owner[i];
    cellLevel[i] = o < 0 ? glass : levels.indexOf(remap.get(ownerPd[o])!);
  }
  return { levels, cellLevel, front, merged };
}

/**
 * Horizontal disparity of a point at signed Pd, as a fraction of the eye
 * separation — the device's `(1/focal − 1/D)` with D = 2 + depth, scaled so
 * a point at infinity is 1. Negative (in front of the glass) crosses over.
 */
export function disparity(pd: number): number {
  const D = Math.max(0.2, CONVERGENCE + pd / 100);
  return CONVERGENCE * (1 / CONVERGENCE - 1 / D);
}

/**
 * One eye's view, the way 3dBBS draws text layers: deepest first (levels are
 * ascending, so from the end), each shifted sideways by its disparity — a
 * pop-out layer shifts the other way. `eye` is the shift in pixels for disparity 1.0 —
 * negative for the left eye, positive for the right. Cells moved aside uncover
 * black, because on the wire there is only one grid.
 */
export function renderDepthView(
  comp: Composite, plan: DepthPlan, font: BitmapFont, raster: Raster, eye: number, opts: RenderOptions = {},
): void {
  const palette: readonly Rgb[] = opts.palette ?? VGA_PALETTE;
  const grid = comp.grid, cw = raster.cellWidth, ch = raster.cellHeight, data = raster.data, W = raster.width;
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 255; }
  for (let level = plan.levels.length - 1; level >= 0; level--) {
    const shift = Math.round(eye * disparity(plan.levels[level]));
    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        const i = cy * grid.width + cx;
        if (plan.cellLevel[i] !== level) continue;
        const code = grid.glyph[i], fg = grid.fg[i];
        let bg = grid.bg[i];
        if (!opts.iceColors && !isRgb(bg)) bg &= 7;
        const f = isRgb(fg) ? [(fg >> 16) & 255, (fg >> 8) & 255, fg & 255] : palette[fg & 15];
        const b = isRgb(bg) ? [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255] : palette[bg & 15];
        const extend = cw === 9 && code >= 192 && code <= 223;
        for (let y = 0; y < ch; y++) {
          const bits = font.glyphs[code * font.height + y];
          for (let x = 0; x < cw; x++) {
            const px = cx * cw + x + shift;
            if (px < 0 || px >= W) continue;
            const on = x < 8 ? (bits >> (7 - x)) & 1 : extend ? bits & 1 : 0;
            const c = on ? f : b, o = ((cy * ch + y) * W + px) * 4;
            data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
          }
        }
      }
    }
  }
}
