import { describe, expect, it } from "vitest";
import { CellGrid, ellipseCells, flipCells, mirrorGlyph, scaleCellsNearest } from "../src/index.js";

const draw = (w: number, h: number, cells: [number, number][]): string[] => {
  const rows = Array.from({ length: h }, () => Array.from({ length: w }, () => "."));
  for (const [x, y] of cells) rows[y][x] = "#";
  return rows.map((r) => r.join(""));
};

describe("ellipse", () => {
  it("draws a closed outline that touches all four sides", () => {
    const o = draw(11, 7, ellipseCells(0, 0, 10, 6, false));
    expect(o[0]).toMatch(/^\.+#+\.+$/);
    expect(o[6]).toMatch(/^\.+#+\.+$/);
    expect(o[3][0] + o[3][10]).toBe("##");
    expect(o[3].slice(1, 10)).toBe(".........");   // hollow in the middle
    expect(o).toEqual(o.map((r) => r));           // (shape printed for the record)
  });

  it("filled covers the outline and everything inside", () => {
    const outline = ellipseCells(0, 0, 10, 6, false), filled = ellipseCells(0, 0, 10, 6, true);
    const key = (c: [number, number]) => `${c[0]},${c[1]}`;
    const f = new Set(filled.map(key));
    expect(outline.every((c) => f.has(key(c)))).toBe(true);
    expect(filled.length).toBeGreaterThan(outline.length);
    expect(f.has("5,3")).toBe(true);
  });

  it("degenerates to a box when too thin to curve, and takes corners in any order", () => {
    expect(ellipseCells(5, 5, 0, 1, false).length).toBe(ellipseCells(0, 1, 5, 5, false).length);
    expect(draw(4, 2, ellipseCells(0, 0, 3, 1, false))).toEqual(["####", "####"]);
  });
});

describe("mirror and scale", () => {
  it("mirrors paired glyphs and leaves the rest", () => {
    expect(mirrorGlyph(221)).toBe(222);
    expect(mirrorGlyph(40)).toBe(41);
    expect(mirrorGlyph(218)).toBe(191);
    expect(mirrorGlyph(65)).toBe(65);
    expect(mirrorGlyph(mirrorGlyph(201))).toBe(201);
  });

  it("flips a grid with glyph swaps", () => {
    const g = new CellGrid(3, 2);
    g.set(0, 0, { glyph: 218, fg: 1, bg: 0 }); g.set(0, 1, { glyph: 223, fg: 2, bg: 0 });
    const fx = flipCells(g, "x");
    expect(fx.get(2, 0)).toMatchObject({ glyph: 191, fg: 1 });
    expect(fx.get(0, 0).present).toBe(0);
    const fy = flipCells(g, "y");
    expect(fy.get(0, 0)).toMatchObject({ glyph: 220, fg: 2 });
  });

  it("nearest scaling is exact at whole multiples and keeps absence", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 65, fg: 1, bg: 0 });
    const big = scaleCellsNearest(g, 4, 2);
    expect([big.get(0, 0).glyph, big.get(1, 1).glyph, big.get(2, 0).present]).toEqual([65, 65, 0]);
    const small = scaleCellsNearest(big, 2, 1);
    expect(small.equals(g)).toBe(true);
  });
});
