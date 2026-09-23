import { type ShapeLayer, newLayerId } from "./document.js";
import { CellGrid } from "./grid.js";
import { planShapeCells } from "./shapes.js";

export function createShapeLayer(kind: ShapeLayer["kind"], width: number, height: number, name?: string): ShapeLayer {
  return {
    type: "shape", id: newLayerId(), name: name ?? { line: "Line", rect: "Rectangle", ellipse: "Ellipse" }[kind],
    visible: true, locked: false, x: 0, y: 0, keys: [],
    kind, width: Math.max(1, width), height: Math.max(1, height), flip: false,
    style: "single", fill: "none", glyph: 219, fg: 7, bg: null,
  };
}

/**
 * The cells of a shape layer, from its parameters: the same plan the shape
 * tools paint, laid out in the layer's own box. In half-block style the box
 * is two half rows per cell, and each cell becomes ▀, ▄ or █ in the foreground
 * colour over the layer's background (see-through where the background is null).
 */
export function renderShapeLayer(l: ShapeLayer): CellGrid {
  const w = Math.max(1, l.width), h = Math.max(1, l.height);
  const grid = new CellGrid(w, h);
  const half = l.style === "half";
  const H = half ? h * 2 : h;
  const x0 = l.flip ? w - 1 : 0, x1 = l.flip ? 0 : w - 1;
  const plan = planShapeCells(l.kind, x0, 0, x1, H - 1, l.style, l.fill);
  const bg = l.bg === null ? {} : { bg: l.bg };
  if (half) {
    const upper = new Uint8Array(w * h), lower = new Uint8Array(w * h);
    for (const [x, hy] of [...plan.fill, ...plan.outline]) {
      if (x < 0 || x >= w || hy < 0 || hy >= H) continue;
      (hy & 1 ? lower : upper)[(hy >> 1) * w + x] = 1;
    }
    for (let i = 0; i < w * h; i++) {
      if (upper[i] && lower[i]) grid.setAt(i, { glyph: 219, fg: l.fg, ...bg });
      else if (upper[i]) grid.setAt(i, { glyph: 223, fg: l.fg, ...bg });
      else if (lower[i]) grid.setAt(i, { glyph: 220, fg: l.fg, ...bg });
    }
    return grid;
  }
  const inside = l.fill === "color" ? { glyph: 32, fg: l.fg, ...bg } : { glyph: l.glyph, fg: l.fg, ...bg };
  for (const [x, y] of plan.fill) grid.set(x, y, inside);
  for (const [x, y, g] of plan.outline) grid.set(x, y, { glyph: g ?? l.glyph, fg: l.fg, ...bg });
  return grid;
}

/** Regenerate a shape layer's cells. Call after any change to its parameters. */
export function refreshShapeLayer(layer: ShapeLayer): void {
  layer.cache = renderShapeLayer(layer);
}
