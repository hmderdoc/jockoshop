import { describe, expect, it } from "vitest";
import {
  C64_COLOR_CODES, CellGrid, PET_CR, PET_REVERSE_OFF, PET_REVERSE_ON, PET_UPPER_GRAPHICS,
  commonestBackground, encodeSeq, screenToPetscii,
} from "../src/index.js";

describe("screen codes to PETSCII", () => {
  /**
   * Checked against the font bitmap itself: in `PETSCII unshifted.F08`,
   * index 0 draws @, index 1 draws A, 32 is blank and 65 is the spade. So
   * screen 1 must become PETSCII 65 (A) and screen 65 must become 193 (spade).
   */
  it("moves each range where PETSCII keeps it", () => {
    expect(screenToPetscii(0)).toBe(64);     // @
    expect(screenToPetscii(1)).toBe(65);     // A
    expect(screenToPetscii(26)).toBe(90);    // Z
    expect(screenToPetscii(32)).toBe(32);    // space
    expect(screenToPetscii(48)).toBe(48);    // '0'
    expect(screenToPetscii(65)).toBe(193);   // spade
    expect(screenToPetscii(96)).toBe(160);
    expect(screenToPetscii(127)).toBe(191);
  });

  it("ignores the reverse bit, which the file says with a control code", () => {
    for (let c = 0; c < 128; c++) expect(screenToPetscii(c | 0x80)).toBe(screenToPetscii(c));
  });

  it("is one-to-one, so nothing collides on the way out", () => {
    const seen = new Set<number>();
    for (let c = 0; c < 128; c++) seen.add(screenToPetscii(c));
    expect(seen.size).toBe(128);
  });
});

describe("choosing the one background a C64 screen has", () => {
  it("picks whichever the most cells already use", () => {
    const g = CellGrid.filled(4, 1, 32, 1, 6);
    g.set(0, 0, { glyph: 32, fg: 1, bg: 2 });
    expect(commonestBackground(g)).toBe(6);
  });
});

describe("writing a .seq", () => {
  const grid = (): CellGrid => CellGrid.filled(3, 2, 1, 1, 0);   // 'A' in white on black

  it("opens with the graphics charset and the screen colour", () => {
    const { bytes, background } = encodeSeq(grid());
    expect(background).toBe(0);
    expect(bytes[0]).toBe(PET_UPPER_GRAPHICS);
    expect(bytes[1]).toBe(C64_COLOR_CODES[0]);   // black screen
  });

  it("writes the characters as PETSCII and breaks rows with CR", () => {
    const { bytes } = encodeSeq(grid());
    const body = [...bytes].filter((b) => b !== PET_UPPER_GRAPHICS && !C64_COLOR_CODES.includes(b));
    expect(body).toEqual([65, 65, 65, PET_CR, 65, 65, 65]);
  });

  it("changes colour only when it has to", () => {
    const g = CellGrid.filled(4, 1, 1, 5, 0);
    g.set(2, 0, { glyph: 1, fg: 7, bg: 0 });
    const { bytes } = encodeSeq(g);
    const colourRuns = [...bytes].filter((b) => C64_COLOR_CODES.includes(b));
    // the screen colour, then green, then yellow, then green again
    expect(colourRuns.length).toBe(4);
  });

  it("turns a cell with a different background into a reversed space in that colour", () => {
    const g = CellGrid.filled(2, 1, 32, 1, 0);
    g.set(1, 0, { glyph: 32, fg: 1, bg: 2 });   // a red background cell on a black screen
    const { bytes, background, lostBackgrounds } = encodeSeq(g);
    expect(background).toBe(0);
    expect(lostBackgrounds).toBe(0);
    expect([...bytes]).toContain(PET_REVERSE_ON);
    expect([...bytes]).toContain(C64_COLOR_CODES[2]);
  });

  it("counts the backgrounds it could not keep, rather than pretending it did", () => {
    const g = CellGrid.filled(2, 1, 1, 1, 0);
    g.set(1, 0, { glyph: 1, fg: 1, bg: 2 });   // a real character on a different background
    expect(encodeSeq(g).lostBackgrounds).toBe(1);
  });

  it("never leaves reverse on at the end of a line", () => {
    const g = CellGrid.filled(2, 2, 32, 1, 0);
    g.set(1, 0, { glyph: 32, fg: 1, bg: 6 });
    const { bytes } = encodeSeq(g);
    const cr = [...bytes].indexOf(PET_CR);
    expect(bytes[cr - 1]).toBe(PET_REVERSE_OFF);
  });

  it("emits only bytes a Commodore would accept", () => {
    const g = CellGrid.filled(8, 3, 0, 1, 0);
    for (let i = 0; i < 24; i++) g.setAt(i, { glyph: i * 9, fg: i % 16, bg: 0 });
    for (const b of encodeSeq(g).bytes) expect(b).toBeGreaterThanOrEqual(0), expect(b).toBeLessThanOrEqual(255);
  });
});
