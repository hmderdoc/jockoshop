import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, RED, Selection, WAND_DEFAULTS, WHITE, YELLOW, composite,
  createCellsLayer, createDocument, loadProject, maskFromSelection, saveProject, selectWand, selectionFromMask,
} from "../src/index.js";

const cells = (s: Selection): string[] => { const out: string[] = []; s.mask.forEach((v, i) => { if (v) out.push(`${i % s.width},${Math.floor(i / s.width)}`); }); return out; };

describe("Selection", () => {
  it("rect clips to the document", () => {
    const s = Selection.rect(4, 3, { x: 2, y: 1, width: 10, height: 10 });
    expect(cells(s)).toEqual(["2,1", "3,1", "2,2", "3,2"]);
    expect(s.bounds()).toEqual({ x: 2, y: 1, width: 2, height: 2 });
    expect(Selection.rect(4, 3, { x: 9, y: 9, width: 2, height: 2 }).bounds()).toBeNull();
  });

  it("combines like Shift / Alt dragging", () => {
    const a = Selection.rect(4, 1, { x: 0, y: 0, width: 3, height: 1 }), b = Selection.rect(4, 1, { x: 2, y: 0, width: 2, height: 1 });
    expect(cells(Selection.combine(a, b, "replace")!)).toEqual(["2,0", "3,0"]);
    expect(cells(Selection.combine(a, b, "add")!)).toEqual(["0,0", "1,0", "2,0", "3,0"]);
    expect(cells(Selection.combine(a, b, "subtract")!)).toEqual(["0,0", "1,0"]);
    expect(cells(Selection.combine(a, b, "intersect")!)).toEqual(["2,0"]);
    expect(Selection.combine(a, a, "subtract")).toBeNull();
    expect(Selection.combine(null, b, "subtract")).toBeNull();
    expect(cells(Selection.combine(null, b, "add")!)).toEqual(["2,0", "3,0"]);
  });

  it("inverts", () => {
    expect(cells(Selection.rect(3, 1, { x: 0, y: 0, width: 1, height: 1 }).inverted())).toEqual(["1,0", "2,0"]);
  });

  it("lasso: selects the cells a closed path encloses, and the path itself", () => {
    const s = Selection.polygon(7, 7, [[1, 1], [5, 1], [5, 5], [1, 5]]);
    expect(s.count()).toBe(25);
    expect(s.has(3, 3) && s.has(1, 1) && s.has(5, 5)).toBe(true);
    expect(s.has(0, 0) || s.has(6, 3)).toBe(false);
    const tri = Selection.polygon(9, 9, [[4, 0], [8, 8], [0, 8]]);
    expect(tri.has(4, 5)).toBe(true);
    expect(tri.has(0, 0) || tri.has(8, 0)).toBe(false);
  });
});

describe("magic wand", () => {
  // .  .  A  A
  // .  #  #  A     '.' = empty (absent), '#' = red █, 'A' = yellow A on blue, 'a' = white A on blue
  // a  #  .  .
  function sample(): CellGrid {
    const g = new CellGrid(4, 3);
    for (const [x, y] of [[2, 0], [3, 0], [3, 1]]) g.set(x, y, { glyph: 65, fg: YELLOW, bg: BLUE });
    for (const [x, y] of [[1, 1], [2, 1], [1, 2]]) g.set(x, y, { glyph: 219, fg: RED, bg: BLACK });
    g.set(0, 2, { glyph: 65, fg: WHITE, bg: BLUE });
    return g;
  }

  it("selects the connected region of identical cells", () => {
    expect(cells(selectWand(sample(), 1, 1, WAND_DEFAULTS))).toEqual(["1,1", "2,1", "1,2"]);
  });

  it("clicking an empty area selects the connected empty area, not all of it", () => {
    expect(cells(selectWand(sample(), 0, 0, WAND_DEFAULTS))).toEqual(["0,0", "1,0", "0,1"]);
    expect(cells(selectWand(sample(), 0, 0, { ...WAND_DEFAULTS, contiguous: false }))).toEqual(["0,0", "1,0", "0,1", "2,2", "3,2"]);
  });

  it("diagonals decide whether corner-touching cells are connected", () => {
    const g = new CellGrid(2, 2);
    g.set(0, 0, { glyph: 219, fg: RED, bg: BLACK });
    g.set(1, 1, { glyph: 219, fg: RED, bg: BLACK });
    expect(selectWand(g, 0, 0, WAND_DEFAULTS).count()).toBe(1);
    expect(selectWand(g, 0, 0, { ...WAND_DEFAULTS, diagonals: true }).count()).toBe(2);
  });

  it("the channel switches choose what 'the same' means", () => {
    const g = sample();
    const everywhere = { ...WAND_DEFAULTS, contiguous: false };
    expect(selectWand(g, 2, 0, everywhere).count()).toBe(3);                                        // yellow A on blue
    expect(selectWand(g, 2, 0, { ...everywhere, fg: false }).count()).toBe(4);                      // any A on blue
    expect(selectWand(g, 2, 0, { ...everywhere, glyph: false, fg: false }).count()).toBe(4);        // anything on blue
    expect(selectWand(g, 2, 0, { ...everywhere, glyph: false, fg: false, bg: false }).count()).toBe(3);   // none ticked = all
  });

  it("by look: every spelling of a flat colour is the same thing", () => {
    const g = new CellGrid(5, 1);
    g.set(0, 0, { glyph: 32, fg: 7, bg: BLACK });        // space on black
    g.set(1, 0, { glyph: 219, fg: BLACK, bg: BLUE });    // black █
    g.set(2, 0, { glyph: 65, fg: BLACK, bg: BLACK });    // black-on-black text
    g.set(3, 0, { glyph: 0, fg: 15, bg: BLACK });        // NUL on black
    g.set(4, 0, { glyph: 32, fg: 7, bg: BLUE });         // blue: not the same
    expect(selectWand(g, 0, 0, WAND_DEFAULTS).count()).toBe(1);
    expect(cells(selectWand(g, 0, 0, { ...WAND_DEFAULTS, byLook: true }))).toEqual(["0,0", "1,0", "2,0", "3,0"]);
  });

  it("by look still compares two-colour cells channel by channel", () => {
    const g = CellGrid.filled(3, 1, 177, RED, BLUE);
    g.set(2, 0, { glyph: 177, fg: YELLOW, bg: BLUE });
    expect(selectWand(g, 0, 0, { ...WAND_DEFAULTS, byLook: true }).count()).toBe(2);
  });
});

describe("layer masks", () => {
  function doc() {
    const d = createDocument(6, 2);
    (d.layers[0] as CellsLayer).grid = CellGrid.filled(6, 2, 177, BLUE, BLACK);
    const top = createCellsLayer("top", 6, 2);
    top.grid = CellGrid.filled(6, 2, 219, RED, BLACK);
    d.layers.push(top);
    return { d, top };
  }

  it("shows a layer only inside the selection, without touching its cells", () => {
    const { d, top } = doc();
    const before = top.grid.clone();
    top.mask = maskFromSelection(top, 6, 2, Selection.rect(6, 2, { x: 1, y: 0, width: 2, height: 1 }));
    const out = composite(d).grid;
    expect([out.get(0, 0).glyph, out.get(1, 0).glyph, out.get(2, 0).glyph, out.get(3, 0).glyph, out.get(1, 1).glyph]).toEqual([177, 219, 219, 177, 177]);
    expect(top.grid.equals(before)).toBe(true);
    top.mask.enabled = false;
    expect(composite(d).grid.get(0, 0).glyph).toBe(219);
  });

  it("can hide the selection instead, and moves with the layer", () => {
    const { d, top } = doc();
    top.mask = maskFromSelection(top, 6, 2, Selection.rect(6, 2, { x: 0, y: 0, width: 2, height: 2 }), true);
    expect([composite(d).grid.get(0, 0).glyph, composite(d).grid.get(2, 0).glyph]).toEqual([177, 219]);
    top.x = 2;
    const out = composite(d).grid;
    expect([out.get(1, 0).glyph, out.get(2, 0).glyph, out.get(4, 0).glyph]).toEqual([177, 177, 219]);   // hidden part moved too
  });

  it("is relative to a moved layer, and converts back to the same selection", () => {
    const { d, top } = doc();
    top.x = 1;
    const sel = Selection.rect(6, 2, { x: 2, y: 0, width: 3, height: 2 });
    top.mask = maskFromSelection(top, 6, 2, sel);
    expect(composite(d).grid.get(2, 0).glyph).toBe(219);
    expect(composite(d).grid.get(1, 0).glyph).toBe(177);
    expect(Array.from(selectionFromMask(top, top.mask, 6, 2).mask)).toEqual(Array.from(sel.mask));
  });

  it("is saved in the project file, including whether it is on", () => {
    const { d, top } = doc();
    top.mask = maskFromSelection(top, 6, 2, Selection.rect(6, 2, { x: 0, y: 0, width: 3, height: 1 }));
    top.mask.enabled = false;
    const back = loadProject(saveProject(d));
    const m = (back.layers[1] as CellsLayer).mask!;
    expect([m.width, m.height, m.enabled]).toEqual([6, 2, false]);
    expect(Array.from(m.data)).toEqual(Array.from(top.mask.data));
    expect(JSON.stringify(back.layers[0])).not.toContain("mask");
  });
});
