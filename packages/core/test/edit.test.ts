import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CH_ALL, CH_BG, CellGrid, GREEN, GridEdit, History, RED, WHITE, YELLOW,
  cellPatchCommand, defaultMatchContext, findCells, groupCommand, propertyCommand, replaceCells,
} from "../src/index.js";

const ctx = defaultMatchContext();
const COMMA = 44, DOT = 46;

function sample(): CellGrid {
  const g = CellGrid.filled(4, 2, 32, WHITE, BLACK);
  g.set(0, 0, { glyph: COMMA, fg: YELLOW, bg: BLUE });
  g.set(2, 0, { glyph: COMMA, fg: YELLOW, bg: RED });
  g.set(3, 1, { glyph: COMMA, fg: YELLOW, bg: BLUE });
  return g;
}

describe("find & replace", () => {
  const yellowCommaOnBlue = { glyph: { oneOf: [COMMA] }, fg: { oneOf: [YELLOW] }, bg: { oneOf: [BLUE] } };

  it("finds by character + colours, in reading order", () => {
    expect(findCells(sample(), yellowCommaOnBlue, ctx)).toEqual([0, 7]);
  });

  it("limits the search to a rect", () => {
    expect(findCells(sample(), yellowCommaOnBlue, ctx, { x: 0, y: 0, width: 4, height: 1 })).toEqual([0]);
  });

  it("replaces only the channels given and keeps the rest", () => {
    const g = sample();
    replaceCells(g, yellowCommaOnBlue, { glyph: DOT, bg: GREEN }, ctx);
    expect(g.get(0, 0)).toEqual({ glyph: DOT, fg: YELLOW, bg: GREEN, present: CH_ALL });
    expect(g.get(3, 1)).toEqual({ glyph: DOT, fg: YELLOW, bg: GREEN, present: CH_ALL });
    expect(g.get(2, 0)).toMatchObject({ glyph: COMMA, bg: RED });   // comma on red was not a match
  });

  it("returns null when nothing matched, or when the replacement changes nothing", () => {
    expect(replaceCells(sample(), { glyph: { oneOf: [1] } }, { glyph: 2 }, ctx)).toBeNull();
    expect(replaceCells(sample(), yellowCommaOnBlue, { glyph: COMMA }, ctx)).toBeNull();
  });

  it("undoes and redoes a replace as one step", () => {
    const g = sample(), original = g.clone(), history = new History();
    const patch = replaceCells(g, yellowCommaOnBlue, { glyph: DOT }, ctx)!;
    history.push(cellPatchCommand("Replace", g, patch));
    const replaced = g.clone();
    history.undo();
    expect(g.equals(original)).toBe(true);
    history.redo();
    expect(g.equals(replaced)).toBe(true);
  });
});

describe("GridEdit", () => {
  it("records one patch per stroke, remembers the first state of a cell, ignores out-of-bounds", () => {
    const g = sample(), original = g.clone();
    const edit = new GridEdit(g);
    edit.set(1, 1, { glyph: 65 });
    edit.set(1, 1, { glyph: 66, fg: RED });
    edit.set(99, 99, { glyph: 1 });
    const patch = edit.commit()!;
    expect(Array.from(patch.indices)).toEqual([5]);
    expect(patch.before.glyph[0]).toBe(32);
    expect(patch.after.glyph[0]).toBe(66);
    const h = new History();
    h.push(cellPatchCommand("Draw", g, patch));
    h.undo();
    expect(g.equals(original)).toBe(true);
  });

  it("can erase channels, and undo restores their presence", () => {
    const g = sample(), original = g.clone();
    const edit = new GridEdit(g);
    edit.clear(0, 0, CH_BG);
    edit.clear(2, 0);
    const patch = edit.commit()!;
    expect(g.get(0, 0).present).toBe(CH_ALL & ~CH_BG);
    expect(g.get(2, 0).present).toBe(0);
    cellPatchCommand("Erase", g, patch).undo();
    expect(g.equals(original)).toBe(true);
  });
});

describe("History", () => {
  it("undoes property changes and groups, and drops redo after a new action", () => {
    const layer = { x: 0, y: 0, visible: true };
    const h = new History();
    h.run(groupCommand("Move", [
      propertyCommand("x", layer, "x", 0, 5),
      propertyCommand("y", layer, "y", 0, 3),
    ]));
    expect(layer).toMatchObject({ x: 5, y: 3 });
    h.undo();
    expect(layer).toMatchObject({ x: 0, y: 0 });
    expect(h.canRedo).toBe(true);
    h.run(propertyCommand("Hide", layer, "visible", true, false));
    expect(h.canRedo).toBe(false);
    h.undo();
    expect(layer.visible).toBe(true);
    expect(h.canUndo).toBe(false);
  });
});

describe("History position", () => {
  it("returns to the saved position on redo, but not through a new edit after an undo", () => {
    const layer = { x: 0 };
    const h = new History();
    h.run(propertyCommand("a", layer, "x", 0, 1));
    const saved = h.position;
    h.undo();
    expect(h.position).not.toBe(saved);
    h.redo();
    expect(h.position).toBe(saved);
    h.undo();
    h.run(propertyCommand("b", layer, "x", 0, 2));   // same counts as the saved state, different content
    expect(h.position).not.toBe(saved);
  });
});
