import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, RED, SAUCE_FLAG_ICE, WHITE, YELLOW,
  cp437Decode, cp437Encode, encodeAnsi, encodeBin, encodeSauce, encodeXbin,
  parseAnsi, parseArt, parseBin, parseSauce, parseXbin, rgb,
} from "../src/index.js";

/** Deterministic pseudo-random art with no blank cells, so trimming can't hide differences. */
function noise(width: number, height: number, opts: { bgMax: number; truecolor?: boolean }): CellGrid {
  const g = new CellGrid(width, height);
  let s = 12345;
  const rnd = (n: number): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const glyphs = [65, 66, 97, 176, 177, 178, 219, 220, 221, 222, 223, 1, 2, 254, 196, 179];
  for (let i = 0; i < width * height; i++) {
    const run = rnd(4) === 0;   // runs of repeated cells exercise colour diffing and XBIN RLE
    if (run && i > 0) { g.setAt(i, g.getAt(i - 1)); continue; }
    g.setAt(i, opts.truecolor && rnd(2)
      ? { glyph: glyphs[rnd(glyphs.length)], fg: rgb(rnd(256), rnd(256), rnd(256)), bg: rgb(rnd(256), rnd(256), rnd(256)) }
      : { glyph: glyphs[rnd(glyphs.length)], fg: rnd(16), bg: rnd(opts.bgMax) });
  }
  return g;
}

const sauce = { title: "Test piece", author: "someone", group: "grp", date: "20260921", comments: ["line one", "line two"] };

describe("CP437", () => {
  it("round-trips all 256 codes except the two that alias space", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const back = cp437Encode(cp437Decode(all));
    const lost = [...all].filter((c) => back[c] !== c);
    expect(lost).toEqual([0]);   // NUL displays as a space
  });
});

describe("SAUCE", () => {
  it("round-trips fields and comments, and reports where the data ends", () => {
    const data = cp437Encode("hello");
    const tail = encodeSauce({
      ...sauce, fileSize: data.length, dataType: 1, fileType: 1,
      tinfo1: 80, tinfo2: 25, tinfo3: 0, tinfo4: 0, flags: SAUCE_FLAG_ICE, fontName: "IBM VGA",
    });
    const file = new Uint8Array([...data, ...tail]);
    const { sauce: s, dataLength } = parseSauce(file)!;
    expect(dataLength).toBe(5);
    expect(s).toMatchObject({ ...sauce, tinfo1: 80, tinfo2: 25, flags: SAUCE_FLAG_ICE, fontName: "IBM VGA" });
    expect(tail.length).toBe(1 + 5 + 2 * 64 + 128);
  });

  it("returns null when there is no record", () => {
    expect(parseSauce(new Uint8Array(200))).toBeNull();
    expect(parseSauce(new Uint8Array(10))).toBeNull();
  });
});

describe("ANSI", () => {
  it("round-trips 16-colour art with blink-range backgrounds", () => {
    const g = noise(80, 30, { bgMax: 16 });
    const art = parseAnsi(encodeAnsi(g, { iceColors: true, sauce }));
    expect(art.grid.equals(g)).toBe(true);
    expect(art.iceColors).toBe(true);
    expect(art.sauce).toMatchObject({ title: "Test piece", tinfo1: 80, tinfo2: 30 });
  });

  it("round-trips at widths other than 80, using the SAUCE width", () => {
    const g = noise(132, 9, { bgMax: 8 });
    expect(parseAnsi(encodeAnsi(g, { iceColors: false, sauce })).grid.equals(g)).toBe(true);
  });

  it("round-trips 24-bit colour mixed with palette colour", () => {
    const g = noise(40, 12, { bgMax: 8, truecolor: true });
    expect(parseAnsi(encodeAnsi(g, { iceColors: false, sauce })).grid.equals(g)).toBe(true);
  });

  it("writes 24-bit colour as a 16-colour code plus the ESC[..t form, not 38;2", () => {
    const g = CellGrid.filled(1, 1, 65, rgb(10, 20, 30), BLACK);
    const text = String.fromCharCode(...encodeAnsi(g, { iceColors: false, sauce: false }));
    expect(text).toContain("\x1b[1;10;20;30t");
    expect(text).not.toContain("38;2");
  });

  it("trims rows that end in black and keeps the row structure", () => {
    const g = CellGrid.filled(80, 3, 32, 7, BLACK);
    g.set(0, 0, { glyph: 65, fg: YELLOW, bg: BLUE });
    g.set(5, 2, { glyph: 66, fg: RED, bg: BLACK });
    const bytes = encodeAnsi(g, { iceColors: false, sauce: false });
    expect(bytes.length).toBeLessThan(60);
    const back = parseAnsi(bytes).grid;
    expect(back.get(0, 0)).toMatchObject({ glyph: 65, fg: YELLOW, bg: BLUE });
    expect(back.get(1, 0)).toMatchObject({ glyph: 32, bg: BLACK });   // the blue did not leak along the row
    expect(back.get(5, 2)).toMatchObject({ glyph: 66, fg: RED });
    expect(back.height).toBe(3);
  });

  it("keeps blank rows at the bottom via the SAUCE height", () => {
    const g = CellGrid.filled(80, 10, 32, 7, BLACK);
    g.set(0, 0, { glyph: 65, fg: WHITE, bg: BLACK });
    expect(parseAnsi(encodeAnsi(g, { iceColors: false, sauce })).grid.height).toBe(10);
  });

  it("parses cursor movement, bold/blink, inverse, save/restore and xterm colours", () => {
    const src = "\x1b[2J\x1b[1;31mA\x1b[2;3H\x1b[0;5;44mB\x1b[s\x1b[1;1H\x1b[u\x1b[7mC\x1b[0m\x1b[2C\x1b[38;2;1;2;3mD\x1b[38;5;12mE";
    const g = parseAnsi(Uint8Array.from(src, (c) => c.charCodeAt(0))).grid;
    expect(g.get(0, 0)).toMatchObject({ glyph: 65, fg: 12, bg: 0 });           // bold red
    expect(g.get(2, 1)).toMatchObject({ glyph: 66, fg: 7, bg: 1 + 8 });        // blink on blue
    expect(g.get(3, 1)).toMatchObject({ glyph: 67, fg: 1 + 8, bg: 7 });        // inverse: the bright bit moves with the blue
    expect(g.get(6, 1)).toMatchObject({ glyph: 68, fg: rgb(1, 2, 3) });
    expect(g.get(7, 1)).toMatchObject({ glyph: 69, fg: 9 });                   // xterm 12 = bright blue
  });

  it("wraps the moment the last column is written", () => {
    const g = parseAnsi(Uint8Array.from("ABCD", (c) => c.charCodeAt(0)), { width: 2 }).grid;
    expect([g.get(0, 0).glyph, g.get(1, 0).glyph, g.get(0, 1).glyph, g.get(1, 1).glyph]).toEqual([65, 66, 67, 68]);
  });
});

describe("BIN and XBIN", () => {
  it("round-trips BIN, taking the width from SAUCE", () => {
    const g = noise(160, 5, { bgMax: 16 });
    const art = parseBin(encodeBin(g, { iceColors: true, sauce }));
    expect(art.grid.equals(g)).toBe(true);
    expect(art.iceColors).toBe(true);
  });

  it("rejects an odd BIN width", () => {
    expect(() => encodeBin(new CellGrid(81, 1), { iceColors: false })).toThrow();
  });

  it("round-trips XBIN compressed and uncompressed, with palette and font", () => {
    const g = noise(90, 7, { bgMax: 16 });
    const fontBytes = new Uint8Array(readFileSync(new URL("../assets/ibmstd.f16", import.meta.url)));
    const palette = Array.from({ length: 16 }, (_, i) => [i * 16, 252 - i * 16, (i * 68) & 252] as const);
    const packed = encodeXbin(g, { iceColors: true, palette, fontBytes, compress: true });
    const raw = encodeXbin(g, { iceColors: true, palette, fontBytes, compress: false });
    expect(packed.length).toBeLessThan(raw.length);
    for (const bytes of [packed, raw]) {
      const art = parseXbin(bytes);
      expect(art.grid.equals(g)).toBe(true);
      expect(art.iceColors).toBe(true);
      expect(art.fontBytes).toEqual(fontBytes);
      expect(art.palette!.map((c) => c.map((v) => v >> 2))).toEqual(palette.map((c) => c.map((v) => v >> 2)));
    }
  });

  it("parseArt detects XBIN by content and BIN by extension", () => {
    const g = noise(80, 2, { bgMax: 8 });
    expect(parseArt(encodeXbin(g, { iceColors: false }), "x.dat").grid.equals(g)).toBe(true);
    expect(parseArt(encodeBin(g, { iceColors: false }), "PIC.BIN").grid.equals(g)).toBe(true);
    expect(parseArt(encodeAnsi(g, { iceColors: false, sauce }), "pic.ans").grid.equals(g)).toBe(true);
  });
});
