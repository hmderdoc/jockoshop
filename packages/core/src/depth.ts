/**
 * 3dBBS text depth. In the editor a layer's `depth` is signed centi-world-units
 * relative to the screen, matching 3dBBS's scene axes (+Z toward the viewer):
 *   0 = at the screen, negative = behind it, positive = in front of it.
 * The wire protocol (0.3) only carries an unsigned distance BEHIND the glass
 * (`CSI = Ps ; Pd * z`, Pd 0-1800, 16 layers), so export writes Pd = -depth
 * and text that is set in front of the screen is clamped to the screen.
 */
import type { Composite } from "./composite.js";
import { type Rgb, VGA_PALETTE, isRgb } from "./color.js";
import type { BitmapFont } from "./font.js";
import type { Raster, RenderOptions } from "./render.js";

export const MAX_DEPTH_LAYERS = 16, MAX_PD = 1800;
/** camera-to-glass distance in world units: where the two eye images coincide */
const CONVERGENCE = 2.0;

/** Editor depth -> protocol Pd (centi-units behind the glass). */
export function depthToPd(depth: number | undefined): number {
  return Math.max(0, Math.min(MAX_PD, Math.round(-(depth ?? 0))));
}

export interface DepthPlan {
  /** Pd of each text layer the export will define; index = protocol layer number. levels[0] is the nearest. */
  levels: number[];
  /** per document cell: index into `levels` */
  cellLevel: Uint8Array;
  /** layers whose depth was in front of the screen and had to be clamped to it */
  clamped: string[];
  /** true when more than 16 distinct depths had to be merged */
  merged: boolean;
}

/** Assign every flattened cell to one of at most 16 protocol depth layers, by the layer that owns it. */
export function planDepth(comp: Composite): DepthPlan {
  const clamped = comp.layers.filter((l) => (l.depth ?? 0) > 0).map((l) => l.name);
  const ownerPd = comp.layers.map((l) => depthToPd(l.depth));
  let levels = [...new Set([0, ...ownerPd])].sort((a, b) => a - b);
  const merged = levels.length > MAX_DEPTH_LAYERS;
  const remap = new Map<number, number>(levels.map((v) => [v, v]));
  while (levels.length > MAX_DEPTH_LAYERS) {   // merge the two closest, never moving the screen plane
    let at = 1;
    for (let i = 2; i < levels.length - 1; i++) if (levels[i + 1] - levels[i] < levels[at + 1] - levels[at]) at = i;
    const a = levels[at], b = levels[at + 1], mid = Math.round((a + b) / 2);
    for (const [k, v] of remap) if (v === a || v === b) remap.set(k, mid);
    levels.splice(at, 2, mid);
  }
  levels = [...new Set(levels)].sort((a, b) => a - b);
  const cellLevel = new Uint8Array(comp.owner.length);
  for (let i = 0; i < cellLevel.length; i++) {
    const o = comp.owner[i];
    cellLevel[i] = o < 0 ? 0 : levels.indexOf(remap.get(ownerPd[o])!);
  }
  return { levels, cellLevel, clamped, merged };
}

/** Horizontal disparity of a point Pd behind the glass, as a fraction of the eye separation. */
export function disparity(pd: number): number {
  const d = pd / 100;
  return d / (CONVERGENCE + d);
}

/**
 * One eye's view, the way 3dBBS draws text layers: deepest first, each shifted
 * sideways by its disparity. `eye` is the shift in pixels for disparity 1.0 —
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
