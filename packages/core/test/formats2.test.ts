import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, RED, WHITE, YELLOW, encodeAnsi, encodeCtrlA, encodeText, encodeTundra, isCtrlA, parseAdf,
  parseAnsi, parseArt, parseAvatar, parseCtrlA, parseIdf, parseTundra, rgb,
} from "../src/index.js";

function art(): CellGrid {
  const g = CellGrid.filled(40, 4, 32, 7, BLACK);
  g.set(0, 0, { glyph: 65, fg: YELLOW, bg: BLUE });
  g.set(1, 0, { glyph: 66, fg: YELLOW, bg: BLUE });
  g.set(5, 0, { glyph: 177, fg: RED, bg: BLACK });
  g.set(39, 1, { glyph: 219, fg: WHITE, bg: RED });     // last column: a full-width row
  g.set(3, 3, { glyph: 1, fg: 15, bg: 12 });            // ☺ on a blink/bright background
  g.set(10, 3, { glyph: 32, fg: 7, bg: 2 });            // a space that is not blank: green background
  return g;
}
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array): string => String.fromCharCode(...b);

describe("Tundra", () => {
  it("round-trips 24-bit and palette colours, and trailing blanks come back black", () => {
    const g = art();
    g.set(20, 2, { glyph: 88, fg: rgb(1, 2, 3), bg: rgb(250, 240, 230) });
    const back = parseTundra(encodeTundra(g), { width: 40 });
    for (let i = 0; i < g.present.length; i++) {
      const a = g.getAt(i), b = back.grid.getAt(i);
      if (a.glyph === 32 && a.bg === BLACK) { expect(b.glyph).toBe(32); continue; }
      if (a.glyph === 1) { expect(b).toMatchObject({ glyph: 32, bg: rgb(255, 85, 85) }); continue; }   // bytes 1-6 are commands: unwritable, the background survives
      expect(b.glyph).toBe(a.glyph);
      expect(b.fg >= 0x1000000 && b.bg >= 0x1000000).toBe(true);   // every colour comes back as RGB
    }
    expect(back.grid.get(20, 2)).toMatchObject({ glyph: 88, fg: rgb(1, 2, 3), bg: rgb(250, 240, 230) });
    expect(back.grid.get(0, 0)).toMatchObject({ glyph: 65, fg: rgb(255, 255, 85), bg: rgb(0, 0, 170) });
    expect(back.iceColors).toBe(true);
  });

  it("is detected by its signature", () => {
    expect(parseArt(encodeTundra(art()), "whatever.dat").grid.width).toBe(80);   // no SAUCE: default width
    expect(str(encodeTundra(art()).subarray(0, 9))).toBe("\x18TUNDRA24");
  });
});

describe("Ctrl-A", () => {
  it("round-trips colours, bright, blink and ☺, using runs for blank stretches", () => {
    const g = art();
    const enc = encodeCtrlA(g);
    const text = str(enc);
    expect(text.startsWith("\x01N")).toBe(true);
    expect(text.endsWith("\x01Z")).toBe(true);
    expect(text).toContain("\x01H\x01" + "4" + "\x01Y" + "A");   // bright yellow on blue: H, bg 4 (=blue), Y
    expect(text).toContain("\x01A");                             // ☺ is written as \x01A, never as a raw \x01
    expect(text).toMatch(/\x01[\x80-\xff]/);                     // a blank run
    const back = parseCtrlA(enc, { width: 40 });
    expect(back.grid.equals(g)).toBe(true);
  });

  it("reads both letter cases and PabloDraw's 'W'", () => {
    const back = parseCtrlA(bytes("\x01h\x014\x01w" + "x\x01N\x01Iy\x01Z"), { width: 10 });   // h = bright, 4 = blue background, w = white
    expect(back.grid.get(0, 0)).toMatchObject({ glyph: 120, fg: 15, bg: 1 });
    expect(back.grid.get(1, 0)).toMatchObject({ glyph: 121, fg: 7, bg: 8 });   // blink on black
  });

  it("is told apart from ANSI and plain text", () => {
    expect(isCtrlA(bytes("hi \x01Rthere"))).toBe(true);
    expect(isCtrlA(bytes("\x1b[31mred"))).toBe(false);
    expect(isCtrlA(bytes("plain"))).toBe(false);
    expect(parseArt(bytes("\x01Yhello\r\n"), "post.msg").grid.get(0, 0)).toMatchObject({ glyph: 104, fg: 6 });
  });
});

describe("text", () => {
  it("writes CP437 bytes or UTF-8, trimming trailing spaces", () => {
    const g = CellGrid.filled(4, 2, 32, 7, 0);
    g.set(0, 0, { glyph: 219 }); g.set(1, 0, { glyph: 65 });
    expect(str(encodeText(g, "cp437"))).toBe("\xdbA\r\n\r\n");
    expect(Array.from(encodeText(g, "utf8"))).toEqual([0xe2, 0x96, 0x88, 65, 13, 10, 13, 10]);
  });
});

describe("legacy readers", () => {
  it("ADF: palette, font and 80-column pairs", () => {
    const head = new Uint8Array(1 + 192 + 4096);
    head[0] = 1;
    for (let i = 0; i < 64; i++) { head[1 + i * 3] = i; head[2 + i * 3] = 63 - i; head[3 + i * 3] = 32; }
    head[193 + 65 * 16 + 3] = 0x18;                         // one row of glyph 'A'
    const pairs = new Uint8Array(160 * 2);
    pairs[0] = 65; pairs[1] = 0x1e; pairs[160] = 66; pairs[161] = 0x07;
    const a = parseAdf(new Uint8Array([...head, ...pairs]));
    expect([a.grid.width, a.grid.height]).toEqual([80, 2]);
    expect(a.grid.get(0, 0)).toMatchObject({ glyph: 65, fg: 14, bg: 1 });
    expect(a.grid.get(0, 1).glyph).toBe(66);
    expect(a.palette![1]).toEqual([4, 251, 130]);           // entry 1 of the 64, 6-bit scaled the XBIN way (v<<2 | v>>4)
    expect(a.palette![8]).toEqual([227, 28, 130]);          // EGA index 56
    expect(a.fontBytes![65 * 16 + 3]).toBe(0x18);
  });

  it("IDF: bounds, RLE runs, then font and palette", () => {
    const head = [4, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 9, 0, 1, 0];   // 1.4, x 0..9 (10 wide), y 0..1
    const data = [1, 0, 3, 0, 65, 0x1e,   // run: 3 × 'A' yellow on blue
      66, 0x07,                            // 'B'
      0, 0,                                // a zero pair = space, 7 on 0
      1, 0, 15, 0, 32, 0x20];              // 15 spaces on green: fills the rest of two rows
    const font = new Uint8Array(4096), pal = new Uint8Array(48).fill(63);
    const a = parseIdf(new Uint8Array([...head, ...data, ...font, ...pal]));
    expect([a.grid.width, a.grid.height]).toEqual([10, 2]);
    expect(a.grid.get(2, 0)).toMatchObject({ glyph: 65, fg: 14, bg: 1 });
    expect(a.grid.get(3, 0).glyph).toBe(66);
    expect(a.grid.get(4, 0)).toMatchObject({ glyph: 0, fg: 7, bg: 0 });   // a zero pair: NUL on 7/0, as PabloDraw reads it
    expect(a.grid.get(9, 1)).toMatchObject({ glyph: 32, bg: 2 });
    expect(a.palette![0]).toEqual([255, 255, 255]);   // 6-bit 63 scales to 255
    expect(parseArt(new Uint8Array([...head, ...data, ...font, ...pal]), "x").grid.width).toBe(10);
  });

  it("Avatar: attributes, repeat, goto and clear-to-end", () => {
    const a = parseAvatar(bytes("\x16\x01\x1eA\x19B\x03\x16\x02c\x16\x08\x03\x02\x16\x07Z"), { width: 8 });
    expect(a.grid.get(0, 0)).toMatchObject({ glyph: 65, fg: 14, bg: 1 });
    expect([a.grid.get(1, 0).glyph, a.grid.get(2, 0).glyph, a.grid.get(3, 0).glyph]).toEqual([66, 66, 66]);
    expect(a.grid.get(4, 0)).toMatchObject({ glyph: 99, bg: 1 + 8 });        // blink set by ^V^B
    expect(a.grid.get(7, 1)).toMatchObject({ glyph: 32, bg: 9 });            // goto 3,2 then clear to end of line
    expect(a.grid.get(2, 1).glyph).toBe(90);                                 // …then Z written at the goto position
    expect(a.grid.get(3, 1)).toMatchObject({ glyph: 32, bg: 9 });
  });
});

describe("the flat exports agree on the picture", () => {
  it("ANSI, Ctrl-A and Tundra of the same grid read back to the same glyphs", () => {
    const g = art();
    g.set(3, 3, { glyph: 65, fg: 15, bg: 4 });   // avoid the unwritable-in-Tundra ☺ and blink
    const ansi = parseAnsi(encodeAnsi(g, { iceColors: true, sauce: false }), { width: 40 }).grid;
    const ctrla = parseCtrlA(encodeCtrlA(g), { width: 40 }).grid;
    const tundra = parseTundra(encodeTundra(g), { width: 40 }).grid;
    expect(Array.from(ctrla.glyph)).toEqual(Array.from(g.glyph));
    expect(Array.from(ansi.glyph)).toEqual(Array.from(g.glyph));
    expect(Array.from(tundra.glyph)).toEqual(Array.from(g.glyph));
  });
});
