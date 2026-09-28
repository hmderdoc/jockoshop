import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VGA_PALETTE, fontCandidates, isLowAscii, matchImageToFont, parseRawFont, pickFixedBg,
} from "../src/index.js";

const font = parseRawFont(new Uint8Array(readFileSync("packages/core/assets/ibmstd.f16")));

/** A picture with real structure in it, so the match has something to chew on. */
function picture(w: number, h: number, light: boolean): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // a disc, dark on light or light on dark
      const inside = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (Math.min(w, h) / 3) ** 2;
      const v = inside === light ? 20 : 235;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("restricting the match to a set of characters", () => {
  it("keeps the space, which a filter applied after the dedupe would lose", () => {
    // in IBM VGA both code 0 and code 32 are blank, and the dedupe keeps the
    // first one it sees — so filtering the finished list would drop the space
    const all = fontCandidates(font);
    expect(all.some((c) => c.code === 0)).toBe(true);
    expect(all.some((c) => c.code === 32)).toBe(false);

    const ascii = fontCandidates(font, isLowAscii);
    expect(ascii.some((c) => c.code === 32)).toBe(true);
    expect(ascii.find((c) => c.code === 32)!.ink.length).toBe(0);
  });

  it("offers nothing outside the range", () => {
    const ascii = fontCandidates(font, isLowAscii);
    expect(ascii.every((c) => c.code >= 32 && c.code <= 126)).toBe(true);
    // every printable ASCII shape is distinct in this font, so none are merged away
    expect(ascii.length).toBe(95);
  });

  it("draws only printable ASCII", () => {
    const w = 320, h = 320;
    const grid = matchImageToFont(picture(w, h, false), w, h, 40, 20, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0 });
    for (let i = 0; i < grid.glyph.length; i++) {
      expect(isLowAscii(grid.glyph[i])).toBe(true);
    }
  });

  it("without a restriction it still reaches for the blocks", () => {
    const w = 320, h = 320;
    const grid = matchImageToFont(picture(w, h, false), w, h, 40, 20, font, VGA_PALETTE, {});
    const high = [...grid.glyph].filter((g) => g > 126).length;
    expect(high).toBeGreaterThan(0);
  });
});

describe("one background for the whole picture", () => {
  /**
   * The reason ASCII mode fixes the background: a space on a coloured
   * background is a solid block, so a match free to choose backgrounds per
   * cell can draw block art out of nothing but spaces and never once use a
   * character outside the range.
   */
  it("is what stops the picture coming out as solid blocks", () => {
    // A cell whose foreground equals its background is a solid block whatever
    // character it holds, so restricting the glyphs alone buys nothing: left
    // free, this picture comes back more than half solid without once using a
    // character outside the range.
    const w = 320, h = 320, src = picture(w, h, false);
    /** The colours cells end up as a flat rectangle of, which is block art when there is more than one. */
    const flats = (g: ReturnType<typeof matchImageToFont>): Set<number> => {
      const out = new Set<number>();
      for (let i = 0; i < g.glyph.length; i++) if (g.fg[i] === g.bg[i]) out.add(g.fg[i]);
      return out;
    };

    const free = matchImageToFont(src, w, h, 40, 20, font, VGA_PALETTE, { allow: isLowAscii });
    expect(flats(free).size).toBeGreaterThan(1);
    expect(new Set([...free.bg]).size).toBeGreaterThan(1);

    // With one ground, a cell that comes out flat is the ground showing
    // through — an empty cell, which is what a dark area of an ASCII piece is.
    const fixed = matchImageToFont(src, w, h, 40, 20, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0 });
    expect(new Set([...fixed.bg])).toEqual(new Set([0]));
    expect(flats(fixed)).toEqual(new Set([0]));
  });

  /**
   * Why ASCII mode hard-codes black instead of choosing.
   *
   * `pickFixedBg` minimises squared error, and with ASCII capped at 39% ink a
   * mid-grey background is always nearer to a high-contrast picture than black
   * is — so it answers "light grey" even for a light-on-dark image, which is
   * the one case ASCII art is always in. The metric is wrong here, not the
   * code, and this pins that so nobody wires it back up.
   */
  it("is not something squared error can be trusted to choose", () => {
    const w = 320, h = 320;
    const onDark = pickFixedBg(picture(w, h, false), w, h, 40, 20, font, VGA_PALETTE, { allow: isLowAscii });
    expect(onDark).not.toBe(0);
  });
});

describe("one ink for the whole picture", () => {
  /** A left-to-right ramp from black to white. */
  function ramp(w: number, h: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.round((255 * x) / (w - 1));
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  }

  const inkOf = (code: number): number => {
    let bits = 0;
    for (let y = 0; y < font.height; y++) for (let r = font.glyphs[code * font.height + y]; r; r &= r - 1) bits++;
    return bits / (8 * font.height);
  };

  it("uses one colour everywhere, so the file carries no colour at all", () => {
    const w = 320, h = 320;
    const g = matchImageToFont(picture(w, h, false), w, h, 40, 20, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0, fixedFg: 7 });
    expect(new Set([...g.fg])).toEqual(new Set([7]));
    expect(new Set([...g.bg])).toEqual(new Set([0]));
  });

  it("makes the characters carry the tone, which is what reads as text", () => {
    // The point of forcing the ink: with colour unable to say anything, the
    // match has to say it with density instead. Across a black-to-white ramp
    // the characters must get heavier — that is a ramp converter falling out
    // of a shape match, rather than being hard-coded as one.
    const w = 640, h = 160, cols = 40, rows = 5;
    const g = matchImageToFont(ramp(w, h), w, h, cols, rows, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0, fixedFg: 15 });
    const meanInk = (x: number): number => {
      let sum = 0;
      for (let y = 0; y < rows; y++) sum += inkOf(g.glyph[y * cols + x]);
      return sum / rows;
    };
    const dark = meanInk(1), mid = meanInk(cols >> 1), light = meanInk(cols - 2);
    expect(dark).toBeLessThan(mid);
    expect(mid).toBeLessThan(light);
    expect(dark).toBeLessThan(0.05);   // near-black is a space, or near enough
  });

  it("without it, the colour moves instead and the characters need not", () => {
    const w = 640, h = 160;
    const free = matchImageToFont(ramp(w, h), w, h, 40, 5, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0 });
    expect(new Set([...free.fg]).size).toBeGreaterThan(1);
  });
});

describe("what ASCII can and cannot reach", () => {
  /**
   * The measured ceiling behind the whole feature: printable ASCII in IBM VGA
   * tops out at 39% ink, where CP437's blocks run 25 / 50 / 75 / 100. There is
   * no upper half of the tonal range, so a bright area cannot be drawn — it
   * saturates at the densest letter. This is not a tuning problem, and the
   * test is here so nobody later "fixes" the washed-out look by changing the
   * matcher.
   */
  it("has no glyph denser than 40% ink", () => {
    const ink = (code: number): number => {
      let bits = 0;
      for (let y = 0; y < font.height; y++) for (let r = font.glyphs[code * font.height + y]; r; r &= r - 1) bits++;
      return bits / (8 * font.height);
    };
    const densest = Math.max(...fontCandidates(font, isLowAscii).map((c) => ink(c.code)));
    expect(densest).toBeGreaterThan(0.3);
    expect(densest).toBeLessThan(0.4);
    expect(ink(0xdb)).toBe(1);   // █, which ASCII has no answer to
  });
});
