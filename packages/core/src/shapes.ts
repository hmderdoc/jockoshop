/** Cell shapes for the drawing tools, and the glyph swaps mirror mode needs. */

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
