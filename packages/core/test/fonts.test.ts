import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_NAME, SAUCE_FLAG_9PX, SAUCE_FLAG_AR_SQUARE, SAUCE_FLAG_AR_STRETCH, SAUCE_FLAG_ICE,
  STANDARD_FONTS, aspectFromFlags, aspectStretch, aspectToFlags, createRaster, parseAnsi, encodeAnsi,
  parseRawFont, resolveFontName, standardFont, stretchRows, CellGrid,
} from "../src/index.js";

const HEIGHT_OF_EXT: Record<string, number> = { F08: 8, F14: 14, F16: 16, F19: 19 };

describe("the standard font table", () => {
  it("has the names every viewer agrees on", () => {
    for (const name of ["IBM VGA", "IBM VGA50", "IBM EGA", "IBM VGA25G", "Amiga Topaz 2+", "C64 PETSCII shifted"]) {
      expect(standardFont(name), name).toBeDefined();
    }
  });

  it("looks names up whatever the case and spacing, since files are not careful", () => {
    expect(standardFont("ibm vga")).toEqual(standardFont("IBM VGA"));
    expect(standardFont("  IBM VGA  ")).toEqual(standardFont("IBM VGA"));
  });

  it("agrees with itself about cell heights: the extension says how tall a glyph is", () => {
    for (const f of STANDARD_FONTS) {
      const ext = f.file.slice(f.file.lastIndexOf(".") + 1).toUpperCase();
      expect(HEIGHT_OF_EXT[ext], `${f.name} -> ${f.file}`).toBe(f.height);
    }
  });

  it("names no two fonts the same", () => {
    const seen = new Set(STANDARD_FONTS.map((f) => f.name.toLowerCase()));
    expect(seen.size).toBe(STANDARD_FONTS.length);
  });

  it("covers the heights real art asks for", () => {
    expect(new Set(STANDARD_FONTS.map((f) => f.height))).toEqual(new Set([8, 14, 16, 19]));
  });
});

describe("resolving the font a document asks for", () => {
  it("gives back the named font when it is one we have", () => {
    const r = resolveFontName("IBM VGA50");
    expect(r.known).toBe(true);
    expect(r.font.height).toBe(8);
  });

  it("falls back to IBM VGA for a name we do not have, and says it is a fallback", () => {
    // real files carry junk here: tools write their own name into the font field
    for (const junk of ["SAUCE-ADDER V1.3", "empathy by skaboy", "Default", "", "\u0000\u0000"]) {
      const r = resolveFontName(junk);
      expect(r.known, junk).toBe(false);
      expect(r.font.name, junk).toBe(DEFAULT_FONT_NAME);
    }
  });
});

describe("the SAUCE aspect-ratio flags", () => {
  it("reads the pair of bits the spec puts aside for it", () => {
    expect(aspectFromFlags(0)).toBe("none");
    expect(aspectFromFlags(SAUCE_FLAG_AR_STRETCH)).toBe("stretch");
    expect(aspectFromFlags(SAUCE_FLAG_AR_SQUARE)).toBe("square");
    expect(aspectFromFlags(SAUCE_FLAG_AR_STRETCH | SAUCE_FLAG_AR_SQUARE)).toBe("none");   // 11 is not valid
  });

  it("does not disturb the other flags in the byte", () => {
    const flags = SAUCE_FLAG_ICE | SAUCE_FLAG_9PX | aspectToFlags("square");
    expect(flags & SAUCE_FLAG_ICE).toBe(SAUCE_FLAG_ICE);
    expect(aspectFromFlags(flags)).toBe("square");
    expect(aspectToFlags("none")).toBe(0);
  });

  it("round-trips through a written and re-read .ans", () => {
    const grid = CellGrid.filled(4, 2, 65, 7, 0);
    // the flags live in the SAUCE record, and a bare export writes none
    const sauce = { title: "", author: "", group: "", date: "", comments: [] };
    for (const aspect of ["none", "stretch", "square"] as const) {
      const bytes = encodeAnsi(grid, { sauce, aspectRatio: aspect, letterSpacing9px: true, iceColors: true });
      const back = parseAnsi(bytes);
      expect(back.aspectRatio, aspect).toBe(aspect);
      expect(back.letterSpacing9px, aspect).toBe(true);
      expect(back.iceColors, aspect).toBe(true);
    }
  });

  it("stretches by what a 4:3 screen needs: 640x400 -> 480 tall, 720x400 -> 540", () => {
    expect(80 * 8 * (3 / 4)).toBeCloseTo(25 * 16 * aspectStretch(false));
    expect(80 * 9 * (3 / 4)).toBeCloseTo(25 * 16 * aspectStretch(true));
  });
});

describe("stretching a rendering for a 4:3 screen", () => {
  const font = parseRawFont(Uint8Array.from({ length: 256 * 16 }, (_, i) => (i % 16 < 8 ? 0xff : 0)));

  it("makes it taller without touching the width", () => {
    const r = createRaster(2, 2, font);
    const out = stretchRows(r, 1.2);
    expect(out.width).toBe(r.width);
    expect(out.height).toBe(Math.round(r.height * 1.2));
  });

  it("repeats rows instead of blending them, so no colour is invented", () => {
    const r = createRaster(1, 1, font);
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const o = (y * r.width + x) * 4;
        r.data[o] = y * 10; r.data[o + 1] = 0; r.data[o + 2] = 0; r.data[o + 3] = 255;
      }
    }
    const out = stretchRows(r, 1.5);
    const reds = new Set<number>();
    for (let y = 0; y < out.height; y++) reds.add(out.data[y * out.width * 4]);
    // every row of the result is one of the rows of the source, unchanged
    for (const v of reds) expect(v % 10).toBe(0);
    expect(reds.size).toBeLessThanOrEqual(r.height);
  });

  it("leaves a factor of 1 alone", () => {
    const r = createRaster(2, 1, font);
    r.data.fill(200);
    const out = stretchRows(r, 1);
    expect(out.height).toBe(r.height);
    expect([...out.data]).toEqual([...r.data]);
  });
});
