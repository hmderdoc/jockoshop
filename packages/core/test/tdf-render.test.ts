import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BLUE, CH_ALL, CH_FG, CH_GLYPH, CellGrid, SHADEANS_DEFAULTS, TDF_BLOCK, TDF_COLOR, WHITE, addFontAsset, composite,
  createDocument, createFontLayer, createRaster, encodePng, gridFromShadeans, hasBlink, layoutTdf, parseRawFont, parseTdf,
  refreshFontLayer, renderGrid, renderTdf, rgb, shadeansOptionBlock, type CellsLayer,
} from "../src/index.js";

/** Build a .tdf in memory: each font is { name, type, spacing, glyphs: { "A": ["rows"...] } }; colour rows are [char, attr] pairs. */
function makeTdf(fonts: { name: string; type: number; spacing: number; glyphs: Record<string, (string | [number, number][])[]> }[]): Uint8Array {
  const out: number[] = [...Buffer.from("\x13TheDraw FONTS file\x1a", "latin1")];
  for (const f of fonts) {
    const offsets = new Array(94).fill(0xffff), data: number[] = [];
    for (const [ch, rows] of Object.entries(f.glyphs)) {
      offsets[ch.charCodeAt(0) - 33] = data.length;
      const width = Math.max(...rows.map((r) => r.length));
      data.push(width, rows.length);
      rows.forEach((row, i) => {
        if (typeof row === "string") for (const c of row) data.push(c.charCodeAt(0));
        else for (const [c, a] of row) data.push(c, a);
        if (i < rows.length - 1) data.push(0x0d);
      });
      data.push(0);
    }
    const name = [...Buffer.from(f.name.padEnd(12, "\0"), "latin1")].slice(0, 12);
    out.push(0x55, 0xaa, 0x00, 0xff, f.name.length, ...name, 0, 0, 0, 0, f.type, f.spacing, data.length & 255, data.length >> 8);
    for (const o of offsets) out.push(o & 255, o >> 8);
    out.push(...data);
  }
  return Uint8Array.from(out);
}

const block = { name: "BLOCKY", type: TDF_BLOCK, spacing: 1, glyphs: { A: ["\xdb\xdb", "\xdb "], B: ["\xdb", "\xdb"], I: ["\xdb"] } };
const color = { name: "COLORY", type: TDF_COLOR, spacing: 0, glyphs: { A: [[[219, 0x0c], [32, 0x00]] as [number, number][], [[223, 0x1e], [32, 0x40]] as [number, number][], [[220, 0x09], [220, 0x09]] as [number, number][]] } };
const m = { lineGap: 1, extraSpacing: 0, spaceWidth: 3 };

describe("TheDraw fonts", () => {
  it("reads every font in a multi-font file", () => {
    const fonts = parseTdf(makeTdf([block, color]));
    expect(fonts.map((f) => [f.name, f.type, f.spacing, f.height])).toEqual([["BLOCKY", TDF_BLOCK, 1, 2], ["COLORY", TDF_COLOR, 0, 3]]);
    expect(fonts[0].glyphs.filter(Boolean).length).toBe(3);
  });

  it("rejects files that aren't TheDraw fonts", () => {
    expect(() => parseTdf(Uint8Array.from([1, 2, 3]))).toThrow();
  });

  it("lays out with the font's spacing, falls back on case, and gives spaces their width", () => {
    const [f] = parseTdf(makeTdf([block]));
    const text = [..."ab i"].map((ch) => ({ ch, font: f }));
    const layout = layoutTdf(text, Infinity, m, f);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0].xs).toEqual([0, 3, 5, 9]);   // A(2)+1, B(1)+1, space(3)+1, I
    expect(layout.width).toBe(10);
  });

  it("wraps on spaces and honours hard line breaks", () => {
    const [f] = parseTdf(makeTdf([block]));
    const styled = (s: string) => [...s].map((ch) => ({ ch, font: f }));
    // "AB" is 4 cells, "AB AB" is 4 + 1 + 3 + 1 + 4 = 13
    expect(layoutTdf(styled("AB AB AB"), 13, m, f).lines.map((l) => [l.start, l.end])).toEqual([[0, 5], [6, 8]]);
    expect(layoutTdf(styled("AB AB AB"), 12, m, f).lines.map((l) => [l.start, l.end])).toEqual([[0, 2], [3, 5], [6, 8]]);
    const hard = layoutTdf(styled("A\nB"), Infinity, m, f);
    expect(hard.lines.map((l) => l.y)).toEqual([0, 3]);   // 2 rows + 1 gap
    expect(hard.height).toBe(5);
  });

  it("mixes fonts in one line on a shared baseline", () => {
    const [b, c] = parseTdf(makeTdf([block, color]));
    const text = [{ ch: "A", font: b }, { ch: "A", font: c }];
    const layout = layoutTdf(text, Infinity, m, b);
    expect(layout.lines[0].height).toBe(3);
    const grid = renderTdf(text, layout, { fg: WHITE, bg: null });
    expect(grid.get(0, 0).present).toBe(0);              // the 2-row font sits on the bottom rows
    expect(grid.get(0, 1)).toMatchObject({ glyph: 219, fg: WHITE });
  });

  it("leaves unwritten cells and see-through backgrounds absent, keeps a colour font's own colours", () => {
    const [b, c] = parseTdf(makeTdf([block, color]));
    const one = (font: typeof b, bg: number | null) => { const t = [{ ch: "A", font }]; return renderTdf(t, layoutTdf(t, Infinity, m, font), { fg: BLUE, bg }); };
    const blockGrid = one(b, null);
    expect(blockGrid.get(0, 0)).toMatchObject({ glyph: 219, fg: BLUE, present: CH_GLYPH | CH_FG });
    expect(blockGrid.get(1, 1).present).toBe(0);         // a space in a block font is nothing
    expect(one(b, 4).get(1, 1)).toMatchObject({ glyph: 32, bg: 4, present: CH_ALL });

    const colorGrid = one(c, null);
    expect(colorGrid.get(0, 0)).toMatchObject({ glyph: 219, fg: 12, present: CH_GLYPH | CH_FG });   // black bg dropped
    expect(colorGrid.get(0, 1)).toMatchObject({ glyph: 223, fg: 14, bg: 1, present: CH_ALL });      // blue bg kept
    expect(colorGrid.get(1, 0).present).toBe(0);         // space over black: nothing
    expect(colorGrid.get(1, 1)).toMatchObject({ glyph: 32, bg: 4, present: CH_ALL });               // space over red: kept
  });

  it("a font layer is regenerated from its recipe and composites over what is below", () => {
    const doc = createDocument(12, 4);
    (doc.layers[0] as CellsLayer).grid = CellGrid.filled(12, 4, 177, 1, 0);
    const layer = createFontLayer("t", addFontAsset(doc, "x/BLOCKY.TDF", makeTdf([block])), "AB");
    layer.x = 1; layer.fg = 15;
    doc.layers.push(layer);
    refreshFontLayer(doc, layer);
    expect([layer.cache!.width, layer.cache!.height]).toEqual([4, 2]);
    const out = composite(doc).grid;
    expect(out.get(1, 0)).toMatchObject({ glyph: 219, fg: 15 });
    expect(out.get(2, 1)).toMatchObject({ glyph: 177, fg: 1 });   // the gap in the A shows the layer below
    layer.runs[0].text = "I";
    refreshFontLayer(doc, layer);
    expect(layer.cache!.width).toBe(1);
  });
});

describe("pixel renderer and PNG", () => {
  const font = parseRawFont(new Uint8Array(readFileSync(new URL("../assets/ibmstd.f16", import.meta.url))));

  it("draws foreground and background pixels, in palette and 24-bit colour", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 223, fg: 12, bg: 1 });                     // ▀ light red over blue
    g.set(1, 0, { glyph: 219, fg: rgb(1, 2, 3), bg: 0 });
    const r = createRaster(2, 1, font);
    renderGrid(g, font, r, { iceColors: true });
    const px = (x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];
    expect([r.width, r.height]).toEqual([16, 16]);
    expect(px(0, 0)).toEqual([255, 85, 85, 255]);
    expect(px(0, 15)).toEqual([0, 0, 170, 255]);
    expect(px(8, 8)).toEqual([1, 2, 3, 255]);
  });

  it("shows a blink-range background as its base colour when iCE is off", () => {
    const g = CellGrid.filled(1, 1, 32, 7, 9);
    const r = createRaster(1, 1, font);
    renderGrid(g, font, r, { iceColors: false });
    expect([...r.data.subarray(0, 3)]).toEqual([0, 0, 170]);
    renderGrid(g, font, r, { iceColors: true });
    expect([...r.data.subarray(0, 3)]).toEqual([85, 85, 255]);
  });

  it("with iCE off a bright background blinks: the off phase hides the foreground", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 219, fg: 15, bg: 12 });   // █ white on light red = blinking, on red
    g.set(1, 0, { glyph: 219, fg: 15, bg: 4 });    // same on plain red: never blinks
    expect(hasBlink(g, false)).toBe(true);
    expect(hasBlink(g, true)).toBe(false);
    const r = createRaster(2, 1, font);
    renderGrid(g, font, r, { iceColors: false });
    expect([...r.data.subarray(0, 3)]).toEqual([255, 255, 255]);
    renderGrid(g, font, r, { iceColors: false, blinkOff: true });
    expect([...r.data.subarray(0, 3)]).toEqual([170, 0, 0]);          // hidden: shows the dark red background
    expect([...r.data.subarray(8 * 4, 8 * 4 + 3)]).toEqual([255, 255, 255]);   // the non-blinking cell is untouched
  });

  it("9-pixel cells repeat the last column for box-drawing glyphs only", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 196, fg: 15, bg: 0 });                     // ─
    g.set(1, 0, { glyph: 65, fg: 15, bg: 0 });
    const r = createRaster(2, 1, font, true);
    renderGrid(g, font, r, { letterSpacing9px: true });
    const lit = (x: number) => Array.from({ length: 16 }, (_, y) => r.data[(y * r.width + x) * 4]).some((v) => v > 0);
    expect(r.width).toBe(18);
    expect(lit(8)).toBe(true);
    expect(lit(17)).toBe(false);
  });

  it("only redraws the requested rect", () => {
    const g = CellGrid.filled(2, 1, 219, 15, 0), r = createRaster(2, 1, font);
    renderGrid(g, font, r, {}, { x: 1, y: 0, width: 1, height: 1 });
    expect(r.data[0]).toBe(0);
    expect(r.data[8 * 4]).toBe(255);
  });

  it("writes a valid PNG whose pixels decode back", () => {
    const g = CellGrid.filled(1, 1, 219, rgb(10, 20, 30), 0), r = createRaster(1, 1, font);
    renderGrid(g, font, r);
    const png = encodePng(r);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([8, 16]);
    const idatLen = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([raw[0], raw[1], raw[2], raw[3]]).toEqual([0, 10, 20, 30]);
  });
});

describe("shadeans bridge", () => {
  it("decodes palette and 24-bit cells, and leaves cells under transparent image areas absent", () => {
    const bytes = Uint8Array.from([
      177, 12, 4, 0, 0, 0, 0, 0, 0, 0,
      223, 8, 0, 1, 10, 20, 30, 40, 50, 60,
      219, 15, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const g = gridFromShadeans(bytes, 3, 1, Uint8Array.from([255, 200, 10]));
    expect(g.get(0, 0)).toMatchObject({ glyph: 177, fg: 12, bg: 4, present: CH_ALL });
    expect(g.get(1, 0)).toMatchObject({ glyph: 223, fg: rgb(10, 20, 30), bg: rgb(40, 50, 60) });
    expect(g.get(2, 0).present).toBe(0);
  });

  it("builds the option block in the order the wasm module reads it", () => {
    const o = shadeansOptionBlock({ ...SHADEANS_DEFAULTS, truecolor: true, localContrast: 0.25 }, true);
    expect(o).toHaveLength(13);
    expect([o[0], o[1], o[5], o[6]]).toEqual([Math.fround(0.1), 1, 1, 1]);
    expect(Number.isNaN(o[7])).toBe(true);   // autoChroma left to shadeans' default
    expect(o[9]).toBe(0.25);
  });
});
