import { describe, expect, it } from "vitest";
import { CellGrid, cellError, fontCandidates, hasCp437Ramp, matchImageToFont, parseRawFont } from "../src/index.js";

/** a font with only: blank, solid, upper half, lower half — at CP437's positions */
function blocksFont(height = 8): ReturnType<typeof parseRawFont> {
  const g = new Uint8Array(256 * height);
  const put = (code: number, rows: (y: number) => number): void => {
    for (let y = 0; y < height; y++) g[code * height + y] = rows(y);
  };
  put(0xdb, () => 0xff);
  put(0xdf, (y) => (y < height / 2 ? 0xff : 0));
  put(0xdc, (y) => (y < height / 2 ? 0 : 0xff));
  put(0xb0, (y) => (y % 2 ? 0x00 : 0x88));   // light
  put(0xb1, (y) => (y % 2 ? 0x22 : 0x88));   // medium
  put(0xb2, (y) => (y % 2 ? 0xdd : 0x77));   // dark
  return parseRawFont(g);
}
/** solid RGBA of one colour, or split top/bottom */
function image(w: number, h: number, top: [number, number, number], bottom = top): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y < h / 2 ? top : bottom, i = (y * w + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  return px;
}

describe("telling which converter a font wants", () => {
  it("sees CP437's ramp where it is", () => {
    expect(hasCp437Ramp(blocksFont())).toBe(true);
  });
  it("and says no when those codes are something else", () => {
    const g = new Uint8Array(256 * 8);
    for (let i = 0; i < g.length; i++) g[i] = i % 3 ? 0x18 : 0x3c;   // letter-ish everywhere
    expect(hasCp437Ramp(parseRawFont(g))).toBe(false);
  });
});

describe("the shapes worth trying", () => {
  it("keeps one of each distinct bitmap, since fonts repeat themselves", () => {
    const c = fontCandidates(blocksFont());
    // blank (every unused code) plus the six drawn ones
    expect(c.length).toBe(7);
    expect(c.some((x) => x.ink.length === 0)).toBe(true);
    expect(c.some((x) => x.ink.length === 8 * 8)).toBe(true);
  });
});

describe("matching an image to a font's own characters", () => {
  const font = blocksFont();

  it("a flat colour comes back as one flat cell", () => {
    const g = matchImageToFont(image(8, 8, [255, 0, 0]), 8, 8, 1, 1, font, undefined, { iceColors: true });
    // either a solid block of red, or a blank on a red background — both are flat red
    const solid = g.glyph[0] === 0xdb ? g.fg[0] : g.bg[0];
    expect([4, 12], `glyph ${g.glyph[0]} fg ${g.fg[0]} bg ${g.bg[0]}`).toContain(solid);
    // and flat: whichever colour is not carrying the cell is not visible in it
    if (g.glyph[0] === 0xdb || g.glyph[0] === 32) expect(true).toBe(true);
    else expect(g.fg[0]).toBe(g.bg[0]);
  });

  it("a cell that is one colour on top and another below finds the half block", () => {
    const g = matchImageToFont(image(8, 8, [255, 255, 255], [0, 0, 0]), 8, 8, 1, 1, font, undefined, { iceColors: true });
    expect([0xdf, 0xdc]).toContain(g.glyph[0]);
    const [top, bottom] = g.glyph[0] === 0xdf ? [g.fg[0], g.bg[0]] : [g.bg[0], g.fg[0]];
    expect(top).toBe(15);
    expect(bottom).toBe(0);
  });

  it("uses no character the font does not have", () => {
    const drawn = new Set(fontCandidates(font).map((c) => c.code));
    const g = matchImageToFont(image(64, 64, [200, 30, 30], [20, 20, 200]), 64, 64, 8, 8, font, undefined, { iceColors: true });
    for (let i = 0; i < g.glyph.length; i++) expect(drawn.has(g.glyph[i])).toBe(true);
  });

  it("leaves cells the coverage says are transparent absent", () => {
    const coverage = Uint8Array.from([255, 0, 0, 255]);
    const g = matchImageToFont(image(16, 16, [90, 200, 90]), 16, 16, 2, 2, font, undefined, { iceColors: true, coverage });
    expect([...g.present].map((p) => (p ? 1 : 0))).toEqual([1, 0, 0, 1]);
  });

  it("keeps backgrounds out of the blinking half when iCE is off", () => {
    const g = matchImageToFont(image(64, 64, [255, 255, 85], [85, 255, 255]), 64, 64, 8, 8, font, undefined, { iceColors: false });
    for (let i = 0; i < g.bg.length; i++) if (g.present[i]) expect(g.bg[i]).toBeLessThan(8);
  });

  it("fits a picture better than filling it with any single cell", () => {
    const px = image(64, 64, [240, 240, 240], [10, 10, 10]);
    const matched = matchImageToFont(px, 64, 64, 8, 8, font, undefined, { iceColors: true });
    const flat = CellGrid.filled(8, 8, 0xdb, 7, 0);
    expect(cellError(matched, px, 64, 64, 8, 8, font)).toBeLessThan(cellError(flat, px, 64, 64, 8, 8, font));
  });

  it("one fixed background is a constraint, not an improvement — it can only cost error", () => {
    const px = image(64, 64, [200, 40, 40], [40, 40, 200]);
    const free = matchImageToFont(px, 64, 64, 8, 8, font, undefined, { iceColors: true });
    const oneBg = matchImageToFont(px, 64, 64, 8, 8, font, undefined, { iceColors: true, fixedBg: 1 });
    expect(cellError(oneBg, px, 64, 64, 8, 8, font)).toBeGreaterThanOrEqual(cellError(free, px, 64, 64, 8, 8, font) - 1e-6);
    for (let i = 0; i < oneBg.bg.length; i++) if (oneBg.present[i]) expect(oneBg.bg[i]).toBe(1);
  });
});
