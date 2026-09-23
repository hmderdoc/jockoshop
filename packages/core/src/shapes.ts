/** Cell shapes for the drawing tools, and the glyph swaps mirror mode needs. */

/** Cells on a line between two points (Bresenham), both ends included. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

/** Cells of the rectangle with corners (x0,y0) and (x1,y1), in any order: the outline, or all of it. */
export function rectCells(x0: number, y0: number, x1: number, y1: number, filled: boolean): [number, number][] {
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const out: [number, number][] = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) if (filled || x === left || x === right || y === top || y === bottom) out.push([x, y]);
  }
  return out;
}

/** Cells strictly inside the rectangle (what a box's fill covers). */
export function rectInterior(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const out: [number, number][] = [];
  for (let y = top + 1; y < bottom; y++) for (let x = left + 1; x < right; x++) out.push([x, y]);
  return out;
}

export type BoxStyle = "single" | "double";

/** The CP437 box-drawing sets: corners, then horizontal and vertical edges. */
export const BOX_GLYPHS: Record<BoxStyle, { tl: number; tr: number; bl: number; br: number; h: number; v: number }> = {
  single: { tl: 218, tr: 191, bl: 192, br: 217, h: 196, v: 179 },   // ┌ ┐ └ ┘ ─ │
  double: { tl: 201, tr: 187, bl: 200, br: 188, h: 205, v: 186 },   // ╔ ╗ ╚ ╝ ═ ║
};

/**
 * The outline of a rectangle drawn in box-drawing characters, each cell with
 * its glyph. A one-row or one-column rectangle is a run of edges; a single
 * cell is a vertical edge.
 */
export function boxCells(x0: number, y0: number, x1: number, y1: number, style: BoxStyle): [number, number, number][] {
  const g = BOX_GLYPHS[style];
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const out: [number, number, number][] = [];
  if (top === bottom && left === right) return [[left, top, g.v]];
  if (top === bottom) { for (let x = left; x <= right; x++) out.push([x, top, g.h]); return out; }
  if (left === right) { for (let y = top; y <= bottom; y++) out.push([left, y, g.v]); return out; }
  out.push([left, top, g.tl], [right, top, g.tr], [left, bottom, g.bl], [right, bottom, g.br]);
  for (let x = left + 1; x < right; x++) out.push([x, top, g.h], [x, bottom, g.h]);
  for (let y = top + 1; y < bottom; y++) out.push([left, y, g.v], [right, y, g.v]);
  return out;
}

/** The box-drawing glyph for a straight line, or `fallback` for a diagonal (which has no such glyph). */
export function lineGlyph(x0: number, y0: number, x1: number, y1: number, style: BoxStyle, fallback: number): number {
  if (y0 === y1 && x0 !== x1) return BOX_GLYPHS[style].h;
  if (x0 === x1 && y0 !== y1) return BOX_GLYPHS[style].v;
  return fallback;
}

export type ShapeKind = "line" | "rect" | "ellipse";
/** the brush character, half-block pixels, or CP437 box drawing (ellipses have no box glyphs: they fall back to the character) */
export type ShapeStyle = "char" | "half" | "single" | "double";
/** nothing, a flat background colour, or the brush character */
export type ShapeFill = "none" | "color" | "char";

/**
 * What a shape covers between two corners. In half-block style every
 * coordinate is (x, half row) — the caller passes half rows in — otherwise
 * cells, and an outline cell may carry its own glyph (box drawing) instead of
 * the brush character. Fill comes first so the outline, drawn after, wins.
 */
export interface ShapePlan {
  half: boolean;
  fill: [number, number][];
  outline: [number, number, number | undefined][];
}

export function planShapeCells(kind: ShapeKind, x0: number, y0: number, x1: number, y1: number, style: ShapeStyle, fill: ShapeFill): ShapePlan {
  const boxed = kind !== "ellipse" && (style === "single" || style === "double");
  const half = style === "half";
  const plain = (cells: [number, number][]): [number, number, undefined][] => cells.map(([x, y]) => [x, y, undefined]);
  if (kind === "line") {
    const cells = lineCells(x0, y0, x1, y1);
    if (boxed) {
      const g = lineGlyph(x0, y0, x1, y1, style as BoxStyle, -1);
      return { half, fill: [], outline: cells.map(([x, y]) => [x, y, g < 0 ? undefined : g]) };
    }
    return { half, fill: [], outline: plain(cells) };
  }
  if (kind === "rect") {
    const outline = boxed ? boxCells(x0, y0, x1, y1, style as BoxStyle) : plain(rectCells(x0, y0, x1, y1, false));
    return { half, fill: fill === "none" ? [] : rectInterior(x0, y0, x1, y1), outline };
  }
  return { half, fill: fill === "none" ? [] : ellipseCells(x0, y0, x1, y1, true), outline: plain(ellipseCells(x0, y0, x1, y1, false)) };
}

/** Cells of an ellipse inscribed in the rect from (x0,y0) to (x1,y1) inclusive; filled or outline. */
export function ellipseCells(x0: number, y0: number, x1: number, y1: number, filled: boolean): [number, number][] {
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const w = right - left + 1, h = bottom - top + 1;
  if (w <= 2 || h <= 2) {   // too thin for a curve: a box
    const out: [number, number][] = [];
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (filled || x === left || x === right || y === top || y === bottom) out.push([x, y]);
    return out;
  }
  // per row, the extent of the ellipse through cell centres
  const cx = (left + right) / 2, cy = (top + bottom) / 2, rx = w / 2, ry = h / 2;
  const span = (y: number): [number, number] | null => {
    const dy = (y - cy) / ry;
    if (Math.abs(dy) > 1) return null;
    const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    return [Math.round(cx - half + 0.5) , Math.round(cx + half - 0.5)];
  };
  const out: [number, number][] = [];
  const seen = new Set<number>();
  const add = (x: number, y: number): void => { const k = y * 100000 + x; if (!seen.has(k)) { seen.add(k); out.push([x, y]); } };
  const rows: ([number, number] | null)[] = [];
  for (let y = top; y <= bottom; y++) rows.push(span(y));
  for (let y = top; y <= bottom; y++) {
    const s = rows[y - top];
    if (!s) continue;
    const [a, b] = [Math.max(left, s[0]), Math.min(right, s[1])];
    if (filled) { for (let x = a; x <= b; x++) add(x, y); continue; }
    // outline: the ends of this row, plus everything this row covers that the neighbours don't
    const above = rows[y - top - 1], below = rows[y - top + 1];
    for (let x = a; x <= b; x++) {
      const edge = x === a || x === b
        || !above || x < Math.max(left, above[0]) || x > Math.min(right, above[1])
        || !below || x < Math.max(left, below[0]) || x > Math.min(right, below[1]);
      if (edge) add(x, y);
    }
  }
  return out;
}

/** Glyphs that have a left/right mirror image; everything else mirrors to itself. */
const MIRROR_PAIRS: [number, number][] = [
  [40, 41], [60, 62], [91, 93], [123, 125], [47, 92],          // ( ) < > [ ] { } / \
  [221, 222],                                                  // ▌ ▐
  [16, 17], [26, 27], [174, 175],                              // ► ◄  → ←  « »
  [218, 191], [192, 217], [195, 180],                          // ┌ ┐  └ ┘  ├ ┤
  [201, 187], [200, 188], [204, 185],                          // ╔ ╗  ╚ ╝  ╠ ╣
  [213, 184], [212, 190], [198, 181],                          // ╒ ╕  ╘ ╛  ╞ ╡
  [214, 183], [211, 189], [199, 182],                          // ╓ ╖  ╙ ╜  ╟ ╢
  [169, 170],                                                  // ⌐ ¬
];
const MIRROR = new Uint8Array(256).map((_, i) => i);
for (const [a, b] of MIRROR_PAIRS) { MIRROR[a] = b; MIRROR[b] = a; }

export function mirrorGlyph(code: number): number {
  return MIRROR[code];
}
