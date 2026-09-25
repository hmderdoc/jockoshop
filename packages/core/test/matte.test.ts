import { describe, expect, it } from "vitest";
import {
  CH_BG, CH_FG, CH_GLYPH, CellGrid, GlyphClass, MATTE_DEFAULTS, applyMatte, borderColor, cellHalves, defaultGlyphInfo,
  defringe, despeckle, dominantColor, GridEdit, gridFromShadeans, matteMask,
} from "../src/index.js";

const SKY = 0x5080dc, BALL = 0xdc7828;

/** RGBA of a `w`x`h` picture, `inside` deciding where the subject is. */
function picture(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = inside(x, y) ? BALL : SKY, i = (y * w + x) * 4;
      px[i] = (c >> 16) & 0xff; px[i + 1] = (c >> 8) & 0xff; px[i + 2] = c & 0xff; px[i + 3] = 255;
    }
  }
  return px;
}
const disc = (cx: number, cy: number, r: number) => (x: number, y: number): boolean => Math.hypot(x - cx, y - cy) <= r;

describe("keying a background out of source pixels", () => {
  it("reads the key colour off the border, ignoring the subject", () => {
    expect(borderColor(picture(40, 40, disc(20, 20, 12)), 40, 40)).toBe(SKY);
  });

  it("cuts the background and keeps the subject", () => {
    const px = picture(40, 40, disc(20, 20, 12));
    const mask = matteMask(px, 40, 40, MATTE_DEFAULTS);
    expect(mask[0]).toBe(1);                       // a corner is background
    expect(mask[20 * 40 + 20]).toBe(0);            // the middle of the ball is not
    const cut = mask.reduce((n, m) => n + m, 0);
    expect(cut).toBeGreaterThan(40 * 40 - 600);    // about everything but the disc
    expect(cut).toBeLessThan(40 * 40 - 400);
  });

  it("“only from the edges” keeps the background's colour where it is walled in", () => {
    // a ball with a hole of sky in the middle of it
    const px = picture(40, 40, (x, y) => disc(20, 20, 14)(x, y) && !disc(20, 20, 4)(x, y));
    const walled = matteMask(px, 40, 40, MATTE_DEFAULTS);
    expect(walled[20 * 40 + 20]).toBe(0);          // the hole survives: it is not joined to the border
    const everywhere = matteMask(px, 40, 40, { ...MATTE_DEFAULTS, edges: false });
    expect(everywhere[20 * 40 + 20]).toBe(1);      // off, every matching pixel goes
  });

  it("tolerance decides how much of a noisy backdrop counts", () => {
    const px = picture(40, 40, disc(20, 20, 12));
    for (let i = 0; i < px.length; i += 4) px[i] += (i % 7) - 3;   // a little noise in every pixel
    const tight = matteMask(px, 40, 40, { ...MATTE_DEFAULTS, tolerance: 0 });
    const loose = matteMask(px, 40, 40, { ...MATTE_DEFAULTS, tolerance: 30 });
    expect(loose.reduce((n, m) => n + m, 0)).toBeGreaterThan(tight.reduce((n, m) => n + m, 0));
  });

  it("grow eats into the subject, shrink leaves more background", () => {
    const px = picture(40, 40, disc(20, 20, 12));
    const n = (grow: number): number => matteMask(px, 40, 40, { ...MATTE_DEFAULTS, grow }).reduce((a, m) => a + m, 0);
    expect(n(3)).toBeGreaterThan(n(0));
    expect(n(-3)).toBeLessThan(n(0));
  });

  it("bleeds subject colour outwards, so no background colour is left to blend into a cell", () => {
    const px = picture(40, 40, disc(20, 20, 12));
    const cut = applyMatte(px, 40, 40, MATTE_DEFAULTS, 16);
    expect(cut).toBeGreaterThan(0);
    const at = (x: number, y: number): number[] => [...px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
    const sky = [0x50, 0x80, 0xdc];
    expect(at(20, 20)).toEqual([0xdc, 0x78, 0x28, 255]);   // the subject is untouched
    // just outside the silhouette — the pixels a cell straddles — the sky is gone
    for (let y = 4; y < 8; y++) {
      expect(at(20, y)[3]).toBe(0);
      expect(at(20, y).slice(0, 3)).not.toEqual(sky);
    }
    // far from the subject it stays as it was: the bleed is bounded, and only
    // the pixels a cell can reach matter to the matcher
    expect(at(0, 0)).toEqual([...sky, 0]);
  });

  it("leaves the picture alone when nothing matches", () => {
    const px = picture(20, 20, () => true);   // all subject, no border background
    const before = px.slice();
    applyMatte(px, 20, 20, { ...MATTE_DEFAULTS, color: 0x00ff00, tolerance: 1 });
    expect([...px]).toEqual([...before]);
  });
});

describe("half-covered cells become half blocks", () => {
  const glyphs = defaultGlyphInfo();
  /** shadeans' output for one cell: a full block, palette colours */
  const shadeansCell = (glyph: number, fg: number, bg: number): Uint8Array =>
    Uint8Array.from([glyph, fg, bg, 0, 0, 0, 0, 0, 0, 0]);

  it("a cell covered on one side only keeps that side", () => {
    const bytes = shadeansCell(219, 12, 0);       // █ in bright red
    const coverage = Uint8Array.from([255, 0]);   // top covered, bottom not
    const g = gridFromShadeans(bytes, 1, 1, coverage, 128, glyphs);
    expect(g.glyph[0]).toBe(223);                 // ▀
    expect(g.fg[0]).toBe(12);
    expect(g.present[0]).toBe(CH_GLYPH | CH_FG);  // no background: the layer below shows below
  });

  it("the other way round gives the lower half block", () => {
    const g = gridFromShadeans(shadeansCell(219, 9, 0), 1, 1, Uint8Array.from([0, 255]), 128, glyphs);
    expect(g.glyph[0]).toBe(220);                 // ▄
    expect(g.fg[0]).toBe(9);
  });

  it("covered on both sides is the cell shadeans made; covered on neither is nothing", () => {
    const both = gridFromShadeans(shadeansCell(177, 7, 1), 1, 1, Uint8Array.from([255, 255]), 128, glyphs);
    expect([both.glyph[0], both.fg[0], both.bg[0]]).toEqual([177, 7, 1]);
    const none = gridFromShadeans(shadeansCell(177, 7, 1), 1, 1, Uint8Array.from([0, 0]), 128, glyphs);
    expect(none.present[0]).toBe(0);
  });

  it("a half block keeps the colour of the half that survives, not its foreground", () => {
    // ▀ = red on top, blue below; only the bottom is covered -> ▄ in blue
    const g = gridFromShadeans(shadeansCell(223, 4, 1), 1, 1, Uint8Array.from([0, 255]), 128, glyphs);
    expect(g.glyph[0]).toBe(220);
    expect(g.fg[0]).toBe(1);
  });

  it("one value per cell still works, so nothing that passed whole-cell coverage changed", () => {
    const g = gridFromShadeans(shadeansCell(219, 12, 0), 1, 1, Uint8Array.from([200]), 128, glyphs);
    expect([g.glyph[0], g.present[0]]).toEqual([219, CH_GLYPH | CH_FG | CH_BG]);
  });
});

describe("what a cell shows above and below", () => {
  const glyphs = defaultGlyphInfo();
  const all = CH_GLYPH | CH_FG | CH_BG;
  it("splits the half blocks and flattens the rest", () => {
    expect(cellHalves(223, 4, 1, all, glyphs)).toEqual([4, 1]);   // ▀ red over blue
    expect(cellHalves(220, 4, 1, all, glyphs)).toEqual([1, 4]);   // ▄ blue over red
    expect(cellHalves(219, 4, 1, all, glyphs)).toEqual([4, 4]);   // █
    expect(cellHalves(32, 4, 1, all, glyphs)).toEqual([1, 1]);    // space
    expect(glyphs.classes[177]).toBe(GlyphClass.Other);
    expect(cellHalves(177, 4, 1, all, glyphs)).toEqual([4, 4]);   // a shade reads as its ink
  });
  it("reports -1 for a half whose colour is not there", () => {
    expect(cellHalves(223, 4, 1, CH_GLYPH | CH_FG, glyphs)).toEqual([4, -1]);
  });
});

describe("cleaning a silhouette in cells", () => {
  const ctx = { palette: undefined as never, glyphs: defaultGlyphInfo() };
  const context = { palette: [[0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170], [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170], [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255], [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]] as const, glyphs: ctx.glyphs };
  const SKYC = 11;   // the colour being cut away

  it("a half block holding the key colour keeps its other half", () => {
    const g = new CellGrid(1, 1);
    g.set(0, 0, { glyph: 223, fg: SKYC, bg: 4 });   // ▀ sky over red
    const edit = new GridEdit(g);
    expect(defringe(edit, SKYC, context)).toBe(1);
    expect(g.glyph[0]).toBe(220);                   // ▄ carrying the red
    expect(g.fg[0]).toBe(4);
    expect(g.present[0]).toBe(CH_GLYPH | CH_FG);
  });

  it("a shade drawn in the key colour loses its ink and keeps what was behind", () => {
    const g = new CellGrid(1, 1);
    g.set(0, 0, { glyph: 177, fg: SKYC, bg: 4 });   // ▒ sky stippled over red
    expect(defringe(new GridEdit(g), SKYC, context)).toBe(1);
    expect(g.glyph[0]).toBe(32);
    expect(g.bg[0]).toBe(4);
    expect(g.present[0] & CH_FG).toBe(0);
  });

  it("the key colour behind a character lets the layer below through instead", () => {
    const g = new CellGrid(1, 1);
    g.set(0, 0, { glyph: 65, fg: 15, bg: SKYC });   // a white A on sky
    expect(defringe(new GridEdit(g), SKYC, context)).toBe(1);
    expect(g.glyph[0]).toBe(65);
    expect(g.present[0]).toBe(CH_GLYPH | CH_FG);
  });

  it("a cell that is nothing but the key colour goes entirely", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 219, fg: SKYC, bg: 0 });   // a solid block of it
    g.set(1, 0, { glyph: 32, fg: 7, bg: SKYC });    // and an empty cell on it
    expect(defringe(new GridEdit(g), SKYC, context)).toBe(2);
    expect(g.present[0]).toBe(0);
    expect(g.present[1]).toBe(0);
  });

  it("leaves cells the key colour is not in", () => {
    const g = new CellGrid(1, 1);
    g.set(0, 0, { glyph: 219, fg: 4, bg: 0 });
    expect(defringe(new GridEdit(g), SKYC, context)).toBe(0);
    expect(g.present[0]).toBe(CH_GLYPH | CH_FG | CH_BG);
  });

  it("only touches cells `within` allows, so a delete cleans its own edge and nothing else", () => {
    const g = new CellGrid(3, 1);
    for (let x = 0; x < 3; x++) g.set(x, 0, { glyph: 223, fg: SKYC, bg: 4 });
    expect(defringe(new GridEdit(g), SKYC, context, (x) => x === 1)).toBe(1);
    expect(g.glyph[0]).toBe(223);
    expect(g.glyph[1]).toBe(220);
  });

  it("is one undo step: the edit restores every cell it touched", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: 223, fg: SKYC, bg: 4 });
    g.set(1, 0, { glyph: 219, fg: SKYC, bg: 0 });
    const before = g.clone();
    const edit = new GridEdit(g);
    defringe(edit, SKYC, context);
    const patch = edit.commit()!;
    expect(patch.indices.length).toBe(2);
    for (let k = 0; k < patch.indices.length; k++) {
      const i = patch.indices[k];
      g.glyph[i] = patch.before.glyph[k]; g.fg[i] = patch.before.fg[k];
      g.bg[i] = patch.before.bg[k]; g.present[i] = patch.before.present[k];
    }
    expect(g.equals(before)).toBe(true);
  });
});

describe("stray cells", () => {
  it("drops the ones with nothing beside them and keeps a run", () => {
    const g = new CellGrid(5, 1);
    g.set(0, 0, { glyph: 219, fg: 7, bg: 0 });   // on its own
    g.set(2, 0, { glyph: 219, fg: 7, bg: 0 });   // a pair
    g.set(3, 0, { glyph: 219, fg: 7, bg: 0 });
    expect(despeckle(new GridEdit(g))).toBe(1);
    expect(g.present[0]).toBe(0);
    expect(g.present[2]).not.toBe(0);
    expect(g.present[3]).not.toBe(0);
  });

  it("decides against the grid as it was, so a pair does not eat itself", () => {
    const g = new CellGrid(3, 1);
    g.set(0, 0, { glyph: 219, fg: 7, bg: 0 });
    g.set(1, 0, { glyph: 219, fg: 7, bg: 0 });
    expect(despeckle(new GridEdit(g))).toBe(0);
  });
});

describe("the colour a selection is made of", () => {
  it("is the one covering most of it, weighted by how much of each cell it fills", () => {
    const g = new CellGrid(4, 1);
    g.set(0, 0, { glyph: 219, fg: 11, bg: 0 });   // solid sky
    g.set(1, 0, { glyph: 219, fg: 11, bg: 0 });
    g.set(2, 0, { glyph: 223, fg: 11, bg: 4 });   // half sky, half red
    g.set(3, 0, { glyph: 219, fg: 4, bg: 0 });    // solid red
    expect(dominantColor(g, { palette: undefined as never, glyphs: defaultGlyphInfo() }, () => true)).toBe(11);
  });

  it("is -1 when there is nothing to go on", () => {
    const g = new CellGrid(2, 1);
    expect(dominantColor(g, { palette: undefined as never, glyphs: defaultGlyphInfo() }, () => true)).toBe(-1);
  });
});
