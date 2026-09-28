import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTOUR_DEFAULTS, CellGrid, VGA_PALETTE, contourAscii, isLowAscii, nonAsciiCells, parseRawFont,
} from "../src/index.js";

const font = parseRawFont(new Uint8Array(readFileSync("packages/core/assets/ibmstd.f16")));
const W = 640, H = 640, COLS = 80, ROWS = 40;

/** A ring: one closed contour with every stroke direction on it, and no tone to shade. */
function ring(light = true): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - W / 2, y - H / 2);
      const on = d > W * 0.28 && d < W * 0.36;
      const i = (y * W + x) * 4;
      const v = on === light ? 240 : 10;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/**
 * A flat field with a single hard horizontal edge across it, crossing the
 * middle of a row of cells rather than the line between two. On the boundary
 * the right answer is a top-of-cell tick — correct, but the degenerate case;
 * mid-cell is where a full-width stroke is what belongs.
 */
function horizon(): Uint8ClampedArray {
  const cut = (ROWS / 2) * font.height + font.height / 2;
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) rgba(buf, (y * W + x) * 4, y < cut * (H / (ROWS * font.height)) ? 20 : 230);
  }
  return buf;
}

const rgba = (buf: Uint8ClampedArray, i: number, v: number): void => { buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255; };

/** What share of a character's cell is ink — the band the contour alphabet is drawn from. */
function ink(code: number): number {
  let bits = 0;
  for (let y = 0; y < font.height; y++) for (let r = font.glyphs[code * font.height + y]; r; r &= r - 1) bits++;
  return bits / (8 * font.height);
}

/** Where a character's ink sits and how far it reaches, so a test can ask which way it lies. */
function inkShape(code: number): { meanX: number; meanY: number; spreadX: number; spreadY: number } {
  const xs: number[] = [], ys: number[] = [];
  for (let y = 0; y < font.height; y++) {
    const row = font.glyphs[code * font.height + y];
    for (let x = 0; x < 8; x++) if ((row >> (7 - x)) & 1) { xs.push(x); ys.push(y); }
  }
  const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = (v: number[], m: number): number => Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1));
  const mx = mean(xs), my = mean(ys);
  return { meanX: mx, meanY: my, spreadX: sd(xs, mx), spreadY: sd(ys, my) };
}
const drawn = (g: CellGrid): number => [...g.present].filter(Boolean).length;
const charAt = (g: CellGrid, x: number, y: number): string => String.fromCharCode(g.glyph[y * g.width + x]);
const row = (g: CellGrid, y: number): string =>
  Array.from({ length: g.width }, (_, x) => (g.present[y * g.width + x] ? charAt(g, x, y) : " ")).join("");

describe("contour ASCII", () => {
  it("draws only line-like ASCII, never the dense letters that shade", () => {
    const g = contourAscii(ring(), W, H, COLS, ROWS, font);
    for (let i = 0; i < g.glyph.length; i++) {
      if (!g.present[i]) continue;
      expect(isLowAscii(g.glyph[i])).toBe(true);
      // the alphabet is derived from ink coverage, so this asserts the band
      // rather than a list — `M`, `@`, `Q` and the rest of the ramp are the
      // tone matcher's business and must never turn up in a contour
      const cover = ink(g.glyph[i]);
      expect(cover).toBeGreaterThanOrEqual(0.03);
      expect(cover).toBeLessThanOrEqual(0.18);
    }
  });

  it("reaches past the six strokes an angle match could offer", () => {
    // the point of scoring shape instead of fitting an angle: a circle needs
    // shoulders and corners, not just / \ | _
    const used = new Set<string>();
    const g = contourAscii(ring(), W, H, COLS, ROWS, font);
    for (let i = 0; i < g.glyph.length; i++) if (g.present[i]) used.add(String.fromCharCode(g.glyph[i]));
    expect(used.size).toBeGreaterThan(6);
    expect([...used].some((c) => !"_-=/\\|".includes(c))).toBe(true);
  });

  it("leaves the flat parts absent, not blank", () => {
    // absent, so a contour layer sits over what is under it without
    // punching a hole in it — and sparse, which is what makes it read
    const g = contourAscii(ring(), W, H, COLS, ROWS, font);
    expect(drawn(g)).toBeGreaterThan(40);
    expect(drawn(g)).toBeLessThan(g.glyph.length * 0.35);
    // the middle of the ring is empty space, not a drawn blank
    expect(g.present[Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2)]).toBe(0);
  });

  it("traces a single edge as a single line, and nowhere else", () => {
    const g = contourAscii(horizon(), W, H, COLS, ROWS, font);
    const drawnRows = new Set<number>();
    for (let i = 0; i < g.present.length; i++) if (g.present[i]) drawnRows.add(Math.floor(i / COLS));
    expect(drawnRows.size).toBeGreaterThan(0);
    expect(drawnRows.size).toBeLessThan(3);   // the edge, not the two flat halves
    // it runs the width of the picture
    const [onlyRow] = [...drawnRows];
    let across = 0;
    for (let x = 0; x < COLS; x++) if (g.present[onlyRow * COLS + x]) across++;
    expect(across).toBeGreaterThan(COLS * 0.9);
  });

  /**
   * Not asserted here: that a horizontal edge is drawn with a wide, flat
   * character. It often is — `=` mid-cell, `_` at the foot — but the font only
   * carries full-width horizontals at two or three heights, so an edge crossing
   * at any other one is honestly best served by a small mark (`'`, `:`, `,`).
   * Which of those wins is a near-tie the scoring settles arbitrarily, and
   * pinning it would be pinning noise. What the character does track reliably
   * is the height, which the next test checks.
   */

  it("follows where in the cell the edge sits, not just which way it runs", () => {
    // What scoring the shape buys that an angle cannot: `_`, `-` and `'` all
    // run the same way, and which one is right depends on the height the edge
    // crosses the cell at. An edge low in the cell must pick low ink.
    const meanY = (offset: number): number => {
      const buf = new Uint8ClampedArray(W * H * 4);
      // the scaled grid is ROWS * 16 tall; put the edge `offset` down a cell
      const cut = Math.round(((ROWS / 2) * 16 + offset) * (H / (ROWS * 16)));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba(buf, (y * W + x) * 4, y < cut ? 20 : 235);
      const g = contourAscii(buf, W, H, COLS, ROWS, font);
      let sum = 0, n = 0;
      for (let i = 0; i < g.glyph.length; i++) if (g.present[i]) { sum += inkShape(g.glyph[i]).meanY; n++; }
      return n ? sum / n : NaN;
    };
    const high = meanY(3), low = meanY(13);
    expect(Number.isNaN(high)).toBe(false);
    expect(Number.isNaN(low)).toBe(false);
    expect(high).toBeLessThan(low);
  });

  it("traces less of the picture as `keep` falls", () => {
    // `keep` chooses how far down the picture's own edge strengths to go, so
    // it needs a continuous spread of them to work on — which is what a
    // photograph has. Concentric rings of graded contrast stand in for that.
    // (Two uniform tiers with a gap would prove nothing: there is no rank in
    // between for the threshold to land on.)
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - W / 2, y - H / 2) / (W / 2);
        const band = Math.floor(d * 12);
        const strength = band % 2 ? 0 : Math.max(0, 1 - band / 12);
        rgba(buf, (y * W + x) * 4, Math.round(16 + 230 * strength));
      }
    }
    const counts = [0.02, 0.16, 0.6].map((keep) => drawn(contourAscii(buf, W, H, COLS, ROWS, font, VGA_PALETTE, { keep })));
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[0]).toBeLessThan(counts[1]);
    expect(counts[1]).toBeLessThan(counts[2]);
  });

  it("traces nothing out of a picture with no edges left in it", () => {
    // a relative threshold always finds a strongest 16%; without a floor a
    // picture blurred flat gets traced out of the noise that remains
    const faint = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = 128 + ((x >> 2) + (y >> 2)) % 2;   // a 1/255 checker: technically structure, visually nothing
        rgba(faint, i, v);
      }
    }
    expect(drawn(contourAscii(faint, W, H, COLS, ROWS, font))).toBe(0);
  });

  it("finds fewer edges as `smooth` rises", () => {
    // texture: a fine checkerboard that only survives with little blur
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = ((x >> 2) + (y >> 2)) % 2 ? 230 : 25;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
    const sharp = drawn(contourAscii(rgba, W, H, COLS, ROWS, font, VGA_PALETTE, { smooth: 0 }));
    const soft = drawn(contourAscii(rgba, W, H, COLS, ROWS, font, VGA_PALETTE, { smooth: 5 }));
    expect(soft).toBeLessThan(sharp);
  });

  it("puts the ink on the side of the edge away from the ground", () => {
    // a light ring on black: the strokes take the ring's colour, not the void's
    const onBlack = contourAscii(ring(true), W, H, COLS, ROWS, font, VGA_PALETTE, { background: 0 });
    for (let i = 0; i < onBlack.glyph.length; i++) {
      if (!onBlack.present[i]) continue;
      expect(onBlack.bg[i]).toBe(0);
      expect(onBlack.fg[i]).not.toBe(0);
    }
    // the same picture on white must not draw white on white
    const onWhite = contourAscii(ring(true), W, H, COLS, ROWS, font, VGA_PALETTE, { background: 15 });
    for (let i = 0; i < onWhite.glyph.length; i++) {
      if (!onWhite.present[i]) continue;
      expect(onWhite.bg[i]).toBe(15);
      expect(onWhite.fg[i]).not.toBe(15);
    }
  });

  it("takes a fixed ink colour when told to", () => {
    const g = contourAscii(ring(), W, H, COLS, ROWS, font, VGA_PALETTE, { ink: 10 });
    for (let i = 0; i < g.glyph.length; i++) if (g.present[i]) expect(g.fg[i]).toBe(10);
  });

  it("leaves cells under transparent pixels absent", () => {
    const coverage = new Uint8Array(COLS * ROWS);
    coverage.fill(255, 0, COLS * Math.floor(ROWS / 2));   // only the top half is opaque
    const g = contourAscii(ring(), W, H, COLS, ROWS, font, VGA_PALETTE, { coverage });
    for (let y = Math.floor(ROWS / 2); y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) expect(g.present[y * COLS + x]).toBe(0);
    }
    expect(drawn(g)).toBeGreaterThan(0);
  });

  it("gives an empty picture nothing to trace rather than throwing", () => {
    const flat = new Uint8ClampedArray(W * H * 4).fill(255);
    expect(drawn(contourAscii(flat, W, H, COLS, ROWS, font))).toBe(0);
    expect(drawn(contourAscii(new Uint8ClampedArray(4), 1, 1, 0, 0, font))).toBe(0);
  });

  it("has defaults that trace something without tracing everything", () => {
    const g = contourAscii(ring(), W, H, COLS, ROWS, font, VGA_PALETTE, CONTOUR_DEFAULTS);
    expect(drawn(g)).toBeGreaterThan(60);
    expect(drawn(g)).toBeLessThan(g.glyph.length * 0.3);
  });
});

describe("the ASCII constraint", () => {
  it("counts what breaks it, and says where", () => {
    const g = new CellGrid(4, 2);
    g.setAt(0, { glyph: 65, fg: 7, bg: 0 });     // A
    g.setAt(1, { glyph: 0xdb, fg: 7, bg: 0 });   // full block
    g.setAt(5, { glyph: 0xb1, fg: 7, bg: 0 });   // medium shade
    const { count, at } = nonAsciiCells(g);
    expect(count).toBe(2);
    expect(at).toEqual([{ x: 1, y: 0, glyph: 0xdb }, { x: 1, y: 1, glyph: 0xb1 }]);
  });

  it("ignores cells that are not there", () => {
    // an absent cell holds no character, so it cannot break the rule
    expect(nonAsciiCells(new CellGrid(8, 8)).count).toBe(0);
  });

  it("is happy with a picture the contour converter made", () => {
    expect(nonAsciiCells(contourAscii(ring(), W, H, COLS, ROWS, font)).count).toBe(0);
  });

  it("stops listing after `limit`, but still counts them all", () => {
    const g = new CellGrid(20, 20);
    for (let i = 0; i < 400; i++) g.setAt(i, { glyph: 0xdb, fg: 7, bg: 0 });
    const { count, at } = nonAsciiCells(g, 10);
    expect(count).toBe(400);
    expect(at.length).toBe(10);
  });
});
