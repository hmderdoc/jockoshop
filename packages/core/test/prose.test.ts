import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, RED, WHITE, composite, createCellsLayer, createDocument, createProseLayer,
  deleteText, insertText, layoutProse, loadProject, proseCaretCell, proseIndexAt, refreshProseLayer, renderProse,
  saveProject,
} from "../src/index.js";

/** the frame as lines of text, '.' for empty */
function show(layer: ReturnType<typeof createProseLayer>, blocked?: Uint8Array): string[] {
  const g = renderProse(layer, layoutProse(layer, blocked));
  const out: string[] = [];
  for (let y = 0; y < g.height; y++) {
    let line = "";
    for (let x = 0; x < g.width; x++) { const i = g.index(x, y); line += g.present[i] ? String.fromCharCode(g.glyph[i]) : blocked?.[i] ? "#" : "."; }
    out.push(line);
  }
  return out;
}
const prose = (w: number, h: number, text: string) => createProseLayer("p", w, h, text);

describe("prose layout", () => {
  it("wraps greedily at spaces, consuming the space it breaks at", () => {
    expect(show(prose(10, 3, "the quick brown fox"))).toEqual(["the.quick.", "brown.fox.", ".........."]);
  });

  it("a paragraph break starts a new row", () => {
    expect(show(prose(8, 3, "ab\ncd e"))).toEqual(["ab......", "cd.e....", "........"]);
  });

  it("breaks a word wider than the row", () => {
    expect(show(prose(5, 3, "abcdefgh ij"))).toEqual(["abcde", "fgh..", "ij..."]);   // "ij" fits whole on the next row
  });

  it("flows around obstacles: text goes into the gaps, and skips gaps narrower than minGap", () => {
    const L = prose(12, 4, "one two three four five six seven");
    const blocked = new Uint8Array(12 * 4);
    for (let y = 0; y < 4; y++) for (let x = 5; x < 8; x++) blocked[y * 12 + x] = 1;   // a 3-wide pillar down the middle
    blocked[2 * 12 + 9] = 1;                                                           // leaves a 1-wide gap on row 2 (skipped) and a 2-wide one
    L.minGap = 3;
    expect(show(L, blocked)).toEqual([
      "one..###two.",
      "three###four",
      "five.###.#..",
      "six..###....",   // "seven" would fit the 5-wide gaps, so it is not broken into this 4-wide one: it overflows
    ]);
  });

  it("skips a gap too narrow for a word instead of breaking the word, when a wider gap exists", () => {
    const L = prose(10, 3, "Prose flows");
    const blocked = new Uint8Array(30);
    for (let x = 3; x < 10; x++) blocked[x] = 1;   // row 0 has only a 3-wide gap
    expect(show(L, blocked)).toEqual(["...#######", "Prose.....", "flows....."]);
  });

  it("aligns each span line", () => {
    const c = prose(9, 2, "ab cd\nef"); c.align = "center";
    expect(show(c)).toEqual(["..ab.cd..", "...ef...."]);
    const r = prose(9, 2, "ab cd\nef"); r.align = "right";
    expect(show(r)).toEqual(["....ab.cd", ".......ef"]);
  });

  it("reports overflow instead of losing it silently", () => {
    const L = prose(4, 1, "abcd efgh");
    expect(layoutProse(L).overflow).toBe(4);
    expect(show(L)).toEqual(["abcd"]);
  });

  it("caret positions: before each character, after the last, and at the start of a wrapped line", () => {
    const L = prose(6, 3, "ab cd ef");
    const lay = layoutProse(L);
    const at = (i: number) => proseCaretCell(L, lay, i);
    expect(at(0)).toEqual({ x: 0, y: 0 });
    expect(at(2)).toEqual({ x: 2, y: 0 });        // before the space
    expect(at(3)).toEqual({ x: 3, y: 0 });        // before "cd"
    expect(at(6)).toEqual({ x: 0, y: 1 });        // "ef" wrapped: the caret before it is on the new line
    expect(at(8)).toEqual({ x: 2, y: 1 });        // after the last character
    expect(proseIndexAt(L, lay, 1, 1)).toBe(7);   // clicking on the 'f'
    expect(proseIndexAt(L, lay, 5, 0)).toBe(5);   // clicking past "cd": before the wrap space
  });
});

describe("prose editing", () => {
  it("inserting a forgotten letter reflows the paragraph", () => {
    const L = prose(10, 3, "the quck brown fox");
    expect(show(L)[0]).toBe("the.quck..");
    const next = insertText(L, 6, "i", WHITE, -1);
    expect(next).toBe(7);
    expect(show(L)).toEqual(["the.quick.", "brown.fox.", ".........."]);
    expect(L.fg.length).toBe(L.text.length);
    deleteText(L, 0, 4);
    expect(show(L)[0]).toBe("quick.....");
  });

  it("keeps each character's colours through edits", () => {
    const L = prose(10, 2, "ab");
    L.fg = [RED, BLUE];
    insertText(L, 1, "X", WHITE, BLUE);
    expect(L.text).toBe("aXb");
    expect(L.fg).toEqual([RED, WHITE, BLUE]);
    expect(L.bg).toEqual([-1, BLUE, -1]);
    const g = renderProse(L, layoutProse(L));
    expect(g.get(1, 0)).toMatchObject({ glyph: 88, fg: WHITE, bg: BLUE, present: 7 });
    expect(g.get(0, 0).present & 4).toBe(0);   // see-through background
  });
});

describe("prose in a document", () => {
  it("flows around the content of other layers, and the layer below shows through the gaps", () => {
    const doc = createDocument(12, 3);
    const bg = doc.layers[0] as CellsLayer;
    bg.grid = CellGrid.filled(12, 3, 177, BLUE, BLACK);          // a texture everywhere
    const box = createCellsLayer("box", 12, 3);
    for (let y = 0; y < 3; y++) box.grid.set(6, y, { glyph: 179, fg: WHITE, bg: BLACK });   // a vertical bar at x = 6
    doc.layers.push(box);
    const L = createProseLayer("text", 12, 3, "abc def ghi");
    L.keys = [];
    doc.layers.push(L);
    // the texture covers the whole frame, so it is a background, not an obstacle; the bar is
    refreshProseLayer(doc, L);
    const out = composite(doc).grid;
    const row = (y: number) => Array.from({ length: 12 }, (_, x) => { const c = out.get(x, y); return c.glyph === 177 ? "." : c.glyph === 179 ? "|" : String.fromCharCode(c.glyph); }).join("");
    expect(row(0)).toBe("abc...|def..");   // '.' is the texture showing through
    expect(row(1)).toBe("ghi...|.....");
  });

  it("a layer can be forced to be an obstacle or never one", () => {
    const doc = createDocument(12, 2);
    const bg = doc.layers[0] as CellsLayer;
    bg.grid = CellGrid.filled(12, 2, 177, BLUE, BLACK);
    const L = createProseLayer("text", 12, 2, "abc");
    doc.layers.push(L);
    bg.textWrap = "always";
    refreshProseLayer(doc, L);
    expect(L.cache!.present.some((p) => p !== 0)).toBe(false);   // everything is an obstacle: nothing fits
    bg.textWrap = "never";
    refreshProseLayer(doc, L);
    expect(composite(doc).grid.get(0, 0).glyph).toBe(97);
    const dot = createCellsLayer("dot", 1, 1);
    dot.grid.set(0, 0, { glyph: 219, fg: RED, bg: BLACK });
    dot.textWrap = "never";
    doc.layers.push(dot);
    refreshProseLayer(doc, L);
    expect(composite(doc).grid.get(1, 0).glyph).toBe(98);       // "never": the text goes under the dot, b at x = 1
  });

  it("with flow-around off the frame is the only container", () => {
    const doc = createDocument(12, 2);
    const L = createProseLayer("text", 6, 2, "abc def"); L.flowAround = false; L.x = 3;
    doc.layers.push(L);
    refreshProseLayer(doc, L);
    const out = composite(doc).grid;
    expect(String.fromCharCode(out.get(3, 0).glyph, out.get(5, 0).glyph, out.get(3, 1).glyph)).toBe("acd");   // "abc" then "def" on row 2
  });

  it("is saved with its text and colours, and the cache is rebuilt identically", () => {
    const doc = createDocument(10, 2);
    const L = createProseLayer("text", 10, 2, "hi there"); L.fg[0] = RED; L.align = "right";
    doc.layers.push(L);
    refreshProseLayer(doc, L);
    const back = loadProject(saveProject(doc));
    const P = back.layers[1] as typeof L;
    expect([P.type, P.text, P.fg[0], P.align, P.flowAround]).toEqual(["prose", "hi there", RED, "right", true]);
    refreshProseLayer(back, P);
    expect(composite(back).grid.equals(composite(doc).grid)).toBe(true);
  });
});
