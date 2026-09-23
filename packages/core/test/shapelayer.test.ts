import { describe, expect, it } from "vitest";
import {
  CH_BG, CP437_UNICODE, type CellGrid, type ShapeLayer, cloneLayer, composite, createDocument, createShapeLayer, loadProject,
  planShapeCells, refreshShapeLayer, renderShapeLayer, saveProject,
} from "../src/index.js";

const text = (g: CellGrid): string[] => {
  const rows: string[] = [];
  for (let y = 0; y < g.height; y++) {
    let row = "";
    for (let x = 0; x < g.width; x++) { const c = g.get(x, y); row += c.present ? String.fromCodePoint(CP437_UNICODE[c.glyph]) : "."; }
    rows.push(row);
  }
  return rows;
};

describe("shape plans", () => {
  it("a boxed rectangle carries box glyphs; a plain one carries none", () => {
    const boxed = planShapeCells("rect", 0, 0, 3, 2, "double", "none");
    expect(boxed.outline.find(([x, y]) => x === 0 && y === 0)?.[2]).toBe(201);
    expect(boxed.fill).toEqual([]);
    const plain = planShapeCells("rect", 0, 0, 3, 2, "char", "color");
    expect(plain.outline.every(([, , g]) => g === undefined)).toBe(true);
    expect(plain.fill).toEqual([[1, 1], [2, 1]]);
  });

  it("a diagonal boxed line has no glyph of its own; an ellipse ignores box styles", () => {
    expect(planShapeCells("line", 0, 0, 3, 3, "single", "none").outline.every(([, , g]) => g === undefined)).toBe(true);
    expect(planShapeCells("line", 0, 2, 5, 2, "single", "none").outline[0][2]).toBe(196);
    expect(planShapeCells("ellipse", 0, 0, 8, 4, "double", "none").outline.every(([, , g]) => g === undefined)).toBe(true);
  });
});

describe("shape layers", () => {
  it("renders a single-line box with a colour fill inside", () => {
    const l = createShapeLayer("rect", 5, 3);
    l.fill = "color"; l.fg = 15; l.bg = 1;
    const g = renderShapeLayer(l);
    expect(text(g)).toEqual(["┌───┐", "│   │", "└───┘"]);
    expect(g.get(2, 1)).toMatchObject({ glyph: 32, fg: 15, bg: 1 });
  });

  it("half-block style paints half rows: ▀ along the top, ▄ along the bottom, █ down the sides, see-through elsewhere", () => {
    const l = createShapeLayer("rect", 4, 2);
    l.style = "half"; l.fg = 12;
    const g = renderShapeLayer(l);
    expect(text(g)).toEqual(["█▀▀█", "█▄▄█"]);
    expect(g.get(1, 0).present & CH_BG).toBe(0);   // no background: the lower half shows what is below
    expect(g.get(1, 0).fg).toBe(12);
  });

  it("a line runs corner to corner, and flips", () => {
    const l = createShapeLayer("line", 4, 4);
    l.style = "char"; l.glyph = 88;
    expect(text(renderShapeLayer(l))).toEqual(["X...", ".X..", "..X.", "...X"]);
    l.flip = true;
    expect(text(renderShapeLayer(l))).toEqual(["...X", "..X.", ".X..", "X..."]);
    l.flip = false; l.height = 1; l.style = "double";
    expect(text(renderShapeLayer(l))).toEqual(["════"]);
  });

  it("an ellipse in a box style falls back to the character, and a character fill uses it inside too", () => {
    const l = createShapeLayer("ellipse", 9, 5);
    l.style = "single"; l.fill = "char"; l.glyph = 177;
    const rows = text(renderShapeLayer(l));
    expect(rows[2][4]).toBe("▒");
    expect(rows[0][4]).toBe("▒");
    expect(rows[0][0]).toBe(".");
  });

  it("survives the project file and cloning with its recipe and cells", () => {
    const doc = createDocument(20, 6);
    const l = createShapeLayer("rect", 8, 4, "frame");
    l.x = 2; l.y = 1; l.style = "double"; l.fill = "color"; l.fg = 14; l.bg = 4;
    refreshShapeLayer(l);
    doc.layers.push(l);
    const back = loadProject(saveProject(doc));
    const got = back.layers[1] as ShapeLayer;
    expect(got).toMatchObject({ type: "shape", kind: "rect", width: 8, height: 4, style: "double", fill: "color", fg: 14, bg: 4, x: 2, y: 1 });
    expect(got.cache!.equals(l.cache!)).toBe(true);
    expect(composite(back).grid.equals(composite(doc).grid)).toBe(true);
    const copy = cloneLayer(l) as ShapeLayer;
    expect(copy.id).not.toBe(l.id);
    expect(copy.cache).not.toBe(l.cache);
    expect(copy.cache!.equals(l.cache!)).toBe(true);
  });
});
