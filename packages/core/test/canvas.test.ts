import { describe, expect, it } from "vitest";
import {
  BLACK, CellGrid, type CellsLayer, type GroupLayer, RED, canvasResizeCommand, composite, createCellsLayer, createDocument,
} from "../src/index.js";

function doc() {
  const d = createDocument(4, 2);
  const bg = d.layers[0] as CellsLayer;
  bg.grid = CellGrid.filled(4, 2, 177, 1, BLACK);
  bg.grid.set(0, 0, { glyph: 65, fg: RED, bg: BLACK });
  const inner = createCellsLayer("inner", 1, 1);
  inner.x = 3; inner.y = 1;
  inner.grid.set(0, 0, { glyph: 66, fg: RED, bg: BLACK });
  const group: GroupLayer = { type: "group", id: "g", name: "g", visible: true, locked: false, children: [inner] };
  d.layers.push(group);
  return { d, bg, inner };
}

describe("canvas resize", () => {
  it("adds rows at the top and columns at the left, shifting every layer, including inside groups", () => {
    const { d, bg, inner } = doc();
    canvasResizeCommand(d, { top: 2, left: 3 }).redo();
    expect([d.width, d.height]).toEqual([7, 4]);
    expect([bg.x, bg.y, inner.x, inner.y]).toEqual([3, 2, 6, 3]);
    const out = composite(d).grid;
    expect(out.get(3, 2).glyph).toBe(65);          // the old top-left cell
    expect(out.get(6, 3).glyph).toBe(66);
    expect(out.get(0, 0)).toMatchObject({ glyph: 32, bg: BLACK });   // new area is empty
    expect(out.get(3, 1).glyph).toBe(32);
  });

  it("adds at the right and bottom without moving anything", () => {
    const { d, bg } = doc();
    canvasResizeCommand(d, { right: 2, bottom: 1 }).redo();
    expect([d.width, d.height, bg.x, bg.y]).toEqual([6, 3, 0, 0]);
    expect(composite(d).grid.get(0, 0).glyph).toBe(65);
  });

  it("crops with negative values and loses nothing: growing again brings the cells back", () => {
    const { d, bg } = doc();
    const crop = canvasResizeCommand(d, { left: -1, top: -1 });
    crop.redo();
    expect([d.width, d.height, bg.x, bg.y]).toEqual([3, 1, -1, -1]);
    expect(composite(d).grid.get(0, 0).glyph).toBe(177);
    canvasResizeCommand(d, { left: 1, top: 1 }).redo();
    expect(composite(d).grid.get(0, 0).glyph).toBe(65);
  });

  it("undo restores size and positions exactly", () => {
    const { d, bg, inner } = doc();
    const before = composite(d).grid.clone();
    const cmd = canvasResizeCommand(d, { top: 5, left: 2, right: -1, bottom: 3 });
    cmd.redo();
    cmd.undo();
    expect([d.width, d.height, bg.x, bg.y, inner.x, inner.y]).toEqual([4, 2, 0, 0, 3, 1]);
    expect(composite(d).grid.equals(before)).toBe(true);
  });

  it("refuses to shrink to nothing", () => {
    expect(() => canvasResizeCommand(doc().d, { left: -4 })).toThrow();
  });
});

describe("duplicating layers", () => {
  it("copies cells, key rules and mask independently, with a new id", async () => {
    const { cloneLayer } = await import("../src/index.js");
    const { bg } = doc();
    bg.keys = [{ match: { appearsSolid: 0 }, drop: "cell", enabled: true }];
    bg.mask = { width: 4, height: 2, data: new Uint8Array(8).fill(1), enabled: true };
    const copy = cloneLayer(bg) as CellsLayer;
    expect(copy.id).not.toBe(bg.id);
    expect(copy.name).toBe(`${bg.name} copy`);
    expect(copy.grid.equals(bg.grid)).toBe(true);
    copy.grid.set(0, 0, { glyph: 1 }); copy.keys[0].enabled = false; copy.mask!.data[0] = 0;
    expect(bg.grid.get(0, 0).glyph).toBe(65);
    expect(bg.keys[0].enabled).toBe(true);
    expect(bg.mask.data[0]).toBe(1);
  });

  it("copies a group with its children, all with new ids", async () => {
    const { cloneLayer } = await import("../src/index.js");
    const { d, inner } = doc();
    const copy = cloneLayer(d.layers[1]) as GroupLayer;
    expect(copy.children).toHaveLength(1);
    expect(copy.children[0].id).not.toBe(inner.id);
    expect(copy.children[0].name).toBe("inner");
  });
});
