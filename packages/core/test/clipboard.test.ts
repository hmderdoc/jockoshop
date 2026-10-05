import Module, { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CH_ALL, CH_BG, CH_FG, CH_GLYPH, CellGrid, KD_CLIP_TYPE, PABLO_CLIP_TYPE, clipText, decodeClip,
  decodeClipText, decodeKdClip, decodeMoebiusHtml, decodePabloClip, encodeClip, encodeKdClip, encodeMoebiusHtml,
  encodePabloClip, rgb,
} from "../src/index.js";

// The Moebius oracle is its real clipboard.js. It requires electron, ../doc and
// ../palette, which only make sense inside the app, so those three are stood in
// for: a clipboard that keeps what it is given, and a palette at its defaults.
const MOEBIUS_CLIP = "/Volumes/Crucial2TB/Projects/vsCode_moebius/vendor/moebius/app/document/tools/clipboard.js";
interface MoebiusBlocks { columns: number; rows: number; data: { code: number; fg: number; bg: number }[] }
interface MoebiusClipboard { copy(blocks: MoebiusBlocks): void; paste_blocks(): MoebiusBlocks | undefined }
const board = { text: "", html: "" };
let moebius: MoebiusClipboard | undefined;
if (existsSync(MOEBIUS_CLIP)) {
  const stubs: Record<string, unknown> = {
    electron: { clipboard: {
      // the prefix is what Electron (Chromium's ClipboardMac::WriteHTML) adds on a Mac
      write: (o: { text: string; html: string }) => { board.text = o.text; board.html = `<meta charset='utf-8'>${o.html}`; },
      readHTML: () => board.html,
      readText: () => board.text,
    } },
    "../doc": {},
    "../palette": { fg: 7, bg: 0 },
  };
  const M = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
  const load = M._load;
  M._load = (request, parent, isMain) => (request in stubs ? stubs[request] : load(request, parent, isMain));
  try { moebius = createRequire(import.meta.url)(MOEBIUS_CLIP) as MoebiusClipboard; } finally { M._load = load; }
} else console.log(`skipping Moebius clipboard oracle: ${MOEBIUS_CLIP} not found`);
const oracle = it.skipIf(!moebius);

/** A 3x2 block exercising palette colours, a 24-bit colour, a high glyph and an absent cell. */
function sample(): CellGrid {
  const g = new CellGrid(3, 2);
  g.set(0, 0, { glyph: 0xdb, fg: 14, bg: 1 });
  g.set(1, 0, { glyph: 65, fg: rgb(255, 128, 0), bg: 0 });
  g.set(2, 0, { glyph: 0xb0, fg: 7, bg: 4 });
  g.set(0, 1, { glyph: 32, fg: 7, bg: 2 });
  // (1,1) stays absent
  g.set(2, 1, { glyph: 0xc9, fg: 15, bg: 0 });
  return g;
}

describe("our clipboard format", () => {
  it("round-trips every channel, absent ones included, and the origin", () => {
    const g = sample();
    g.clear(0, 0, CH_BG);
    const back = decodeKdClip(encodeKdClip({ grid: g, x: -3, y: 12 }))!;
    expect(back.x).toBe(-3);
    expect(back.y).toBe(12);
    expect(back.grid.width).toBe(3);
    expect([...back.grid.glyph]).toEqual([...g.glyph]);
    expect([...back.grid.fg]).toEqual([...g.fg]);
    expect([...back.grid.bg]).toEqual([...g.bg]);
    expect([...back.grid.present]).toEqual([...g.present]);
  });

  it("refuses bytes that are not it", () => {
    expect(decodeKdClip(new Uint8Array([1, 2, 3]))).toBeNull();
    const bytes = encodeKdClip({ grid: sample() });
    expect(decodeKdClip(bytes.subarray(0, bytes.length - 1))).toBeNull();
  });
});

describe("Moebius clipboard", () => {
  oracle("Moebius's own paste reads what we copy", () => {
    const g = sample();
    board.html = encodeMoebiusHtml(g);
    board.text = clipText(g);
    const blocks = moebius!.paste_blocks()!;
    expect(blocks.columns).toBe(3);
    expect(blocks.rows).toBe(2);
    expect(blocks.data.map((b) => [b.code, b.fg, b.bg])).toEqual([
      [0xdb, 14, 1], [65, 12, 0], [0xb0, 7, 4],
      [32, 7, 2], [32, 7, 0], [0xc9, 15, 0],   // absent → black space; orange → nearest is light red
    ]);
  });

  oracle("we read what Moebius's own copy writes", () => {
    const data = [{ code: 0xdc, fg: 9, bg: 6 }, { code: 66, fg: 0, bg: 15 }, { code: 0xfe, fg: 13, bg: 8 }, { code: 32, fg: 7, bg: 0 }];
    moebius!.copy({ columns: 2, rows: 2, data });
    const g = decodeMoebiusHtml(board.html)!;
    expect(g.width).toBe(2);
    expect([...g.glyph]).toEqual([0xdc, 66, 0xfe, 32]);
    expect([...g.fg]).toEqual([9, 0, 13, 7]);
    expect([...g.bg]).toEqual([6, 15, 8, 0]);
    expect([...g.present]).toEqual([CH_ALL, CH_ALL, CH_ALL, CH_ALL]);
    // and its text is what our text writer makes of the same cells
    expect(clipText(g)).toBe(board.text);
  });

  it("keeps a 24-bit colour exact between our own windows", () => {
    const g = decodeMoebiusHtml(encodeMoebiusHtml(sample()))!;
    expect(g.fg[1]).toBe(rgb(255, 128, 0));
  });

  it("is not fooled by other HTML", () => {
    expect(decodeMoebiusHtml("<b>hello</b>")).toBeNull();
    expect(decodeMoebiusHtml(`<p>{"a": 1}</p>`)).toBeNull();
    expect(decodeMoebiusHtml(`{"columns":2,"rows":2,"data":[]}`)).toBeNull();
  });
});

describe("PabloDraw clipboard", () => {
  it("is width and height, little-endian, then a TundraDraw body", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 65, fg: 14, bg: 1 });
    g.set(1, 0, { glyph: 66, fg: 14, bg: 1 });
    // hand-assembled from PabloDraw's writer (Tundra.Save): position 0,0; both colours with the first
    // character, as 0,r,g,b; the second character in the same colours is just itself
    expect([...encodePabloClip(g)]).toEqual([
      2, 0, 0, 0, 1, 0, 0, 0,
      1, 0, 0, 0, 0, 0, 0, 0, 0,
      6, 65, 0, 255, 255, 85, 0, 0, 0, 170,
      66,
    ]);
  });

  it("round-trips, with palette colours back as palette entries", () => {
    const g = sample();
    const back = decodePabloClip(encodePabloClip(g))!;
    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect([...back.glyph]).toEqual([0xdb, 65, 0xb0, 32, 32, 0xc9]);
    expect([...back.fg]).toEqual([14, rgb(255, 128, 0), 7, 7, 7, 15]);
    expect([...back.bg]).toEqual([1, 0, 4, 2, 0, 0]);
  });

  it("fills the rows PabloDraw leaves out (all black) with black spaces", () => {
    const g = CellGrid.filled(4, 3, 32, 7, 0);
    g.set(1, 0, { glyph: 0xdb, fg: 2, bg: 0 });
    const back = decodePabloClip(encodePabloClip(g))!;
    expect(back.height).toBe(3);
    expect(back.glyph[1]).toBe(0xdb);
    expect([...back.glyph.subarray(4)]).toEqual(new Array(8).fill(32));
  });
});

describe("text", () => {
  it("writes Unicode lines with CRLF between them", () => {
    expect(clipText(sample())).toBe("█A░\r\n  ╔");
  });

  it("reads glyphs in the colour given, spaces and background left absent", () => {
    const g = decodeClipText("█ x\r\n╔══\r\n", 11)!;
    expect(g.width).toBe(3);
    expect(g.height).toBe(2);
    expect([...g.glyph]).toEqual([0xdb, 0, 120, 0xc9, 0xcd, 0xcd]);
    expect([...g.present]).toEqual([CH_GLYPH | CH_FG, 0, CH_GLYPH | CH_FG, CH_GLYPH | CH_FG, CH_GLYPH | CH_FG, CH_GLYPH | CH_FG]);
    expect(g.fg[0]).toBe(11);
  });
});

describe("choosing what to paste", () => {
  it("prefers ours, then PabloDraw's, then Moebius's, then text", () => {
    const all = encodeClip({ grid: sample(), x: 5, y: 6 });
    expect(decodeClip(all)!.x).toBe(5);
    const noOurs = { ...all, custom: { [PABLO_CLIP_TYPE]: all.custom![PABLO_CLIP_TYPE] } };
    expect(decodeClip(noOurs)!.x).toBeUndefined();
    expect(decodeClip(noOurs)!.grid.bg[3]).toBe(2);
    expect(decodeClip({ html: all.html, text: "zz" })!.grid.width).toBe(3);
    expect(decodeClip({ html: "<b>no</b>", text: "zz" })!.grid.width).toBe(2);
    expect(decodeClip({})).toBeNull();
    expect(Object.keys(all.custom!)).toEqual([KD_CLIP_TYPE, PABLO_CLIP_TYPE]);
  });
});
