import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CH_ALL, CH_BG, CH_FG, CH_GLYPH, GlyphClass, RED, YELLOW,
  defaultGlyphInfo, defaultMatchContext, glyphInfoFromFont, matchesCell, parseRawFont, rgb, solidColor,
} from "../src/index.js";

const font = parseRawFont(new Uint8Array(readFileSync(new URL("../assets/ibmstd.f16", import.meta.url))));
const ctx = defaultMatchContext();
const COMMA = 44;

describe("glyph classes", () => {
  it("reads the VGA font as 8x16", () => {
    expect(font.height).toBe(16);
  });

  it("classifying the real VGA font agrees with the CP437 defaults on every glyph", () => {
    const fromFont = glyphInfoFromFont(font), byCode = defaultGlyphInfo();
    const diff: number[] = [];
    for (let c = 0; c < 256; c++) if (fromFont.classes[c] !== byCode.classes[c]) diff.push(c);
    expect(diff).toEqual([]);
  });

  it("finds the half blocks even though they don't split the cell evenly", () => {
    const info = glyphInfoFromFont(font);
    expect(info.classes[223]).toBe(GlyphClass.Upper);
    expect(info.classes[220]).toBe(GlyphClass.Lower);
    expect(info.coverage![223] + info.coverage![220]).toBeCloseTo(1);   // ▀ + ▄ tile the cell exactly
    expect(info.coverage![223]).not.toBeCloseTo(0.5);
  });

  it("orders shade coverage light to dark", () => {
    const cov = glyphInfoFromFont(font).coverage!;
    expect(cov[176]).toBeLessThan(cov[177]);
    expect(cov[177]).toBeLessThan(cov[178]);
    expect(cov[178]).toBeLessThan(cov[219]);
  });
});

describe("cell matcher", () => {
  it("matches a specific character and colours: yellow comma on blue", () => {
    const m = { glyph: { oneOf: [COMMA] }, fg: { oneOf: [YELLOW] }, bg: { oneOf: [BLUE] } };
    expect(matchesCell(m, COMMA, YELLOW, BLUE, CH_ALL, ctx)).toBe(true);
    expect(matchesCell(m, COMMA, YELLOW, RED, CH_ALL, ctx)).toBe(false);
    expect(matchesCell(m, 46, YELLOW, BLUE, CH_ALL, ctx)).toBe(false);
  });

  it("treats a left-out field as a wildcard", () => {
    const anyComma = { glyph: { oneOf: [COMMA] } };
    expect(matchesCell(anyComma, COMMA, RED, BLACK, CH_ALL, ctx)).toBe(true);
    expect(matchesCell({}, 65, RED, BLACK, CH_ALL, ctx)).toBe(true);
  });

  it("supports negation", () => {
    const notBlue = { bg: { not: [BLUE] } };
    expect(matchesCell(notBlue, 65, RED, BLACK, CH_ALL, ctx)).toBe(true);
    expect(matchesCell(notBlue, 65, RED, BLUE, CH_ALL, ctx)).toBe(false);
  });

  it("never matches an empty cell, and a constraint needs its channel present", () => {
    expect(matchesCell({}, 0, 0, 0, 0, ctx)).toBe(false);
    expect(matchesCell({ fg: { oneOf: [RED] } }, 65, RED, 0, CH_GLYPH | CH_BG, ctx)).toBe(false);
  });

  it("appearsSolid catches every spelling of an empty black cell", () => {
    const m = { appearsSolid: BLACK };
    expect(matchesCell(m, 32, 7, BLACK, CH_ALL, ctx)).toBe(true);        // space on black
    expect(matchesCell(m, 0, 7, BLACK, CH_ALL, ctx)).toBe(true);         // NUL on black
    expect(matchesCell(m, 255, 15, BLACK, CH_ALL, ctx)).toBe(true);      // 255 on black
    expect(matchesCell(m, 65, BLACK, BLACK, CH_ALL, ctx)).toBe(true);    // black-on-black 'A'
    expect(matchesCell(m, 219, BLACK, BLUE, CH_ALL, ctx)).toBe(true);    // █ in black ink
    expect(matchesCell(m, 32, 7, rgb(0, 0, 0), CH_ALL, ctx)).toBe(true); // 24-bit black
  });

  it("appearsSolid rejects cells that show anything else", () => {
    const m = { appearsSolid: BLACK };
    expect(matchesCell(m, 32, 7, BLUE, CH_ALL, ctx)).toBe(false);
    expect(matchesCell(m, 65, 7, BLACK, CH_ALL, ctx)).toBe(false);
    expect(matchesCell(m, 219, BLUE, BLACK, CH_ALL, ctx)).toBe(false);
    expect(matchesCell(m, 223, BLACK, BLUE, CH_ALL, ctx)).toBe(false);
  });

  it("can't call a cell solid when the channel that decides it is absent", () => {
    expect(solidColor(32, 7, BLACK, CH_GLYPH | CH_FG, ctx)).toBe(-1);
    expect(solidColor(219, RED, BLACK, CH_GLYPH | CH_BG, ctx)).toBe(-1);
    expect(solidColor(219, RED, BLACK, CH_GLYPH | CH_FG, ctx)).toBe(RED);
  });
});
