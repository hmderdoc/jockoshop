import { describe, expect, it } from "vitest";
import {
  C64_COLOR_CODES, C64_PALETTE, VGA_PALETTE, encodeXbin, isVgaPalette, parseXbin, CellGrid,
} from "../src/index.js";

describe("knowing when a palette has to travel with the file", () => {
  it("recognises the plain VGA one, which nothing needs to carry", () => {
    expect(isVgaPalette(VGA_PALETTE)).toBe(true);
    expect(isVgaPalette([...VGA_PALETTE])).toBe(true);
  });
  it("and any other, including one that differs by a single value", () => {
    const off = VGA_PALETTE.map((c, i) => (i === 9 ? [c[0], c[1], c[2] - 1] : c) as readonly [number, number, number]);
    expect(isVgaPalette(off)).toBe(false);
    expect(isVgaPalette(C64_PALETTE)).toBe(false);
    expect(isVgaPalette(VGA_PALETTE.slice(0, 8))).toBe(false);
  });
});

describe("the C64's colours", () => {
  it("has sixteen, and they are not VGA's", () => {
    expect(C64_PALETTE.length).toBe(16);
    expect(C64_COLOR_CODES.length).toBe(16);
    expect(C64_PALETTE[0]).toEqual([0, 0, 0]);
    expect(C64_PALETTE[1]).toEqual([255, 255, 255]);
  });
  it("numbers black 0 and white 1, which is where it differs from every DOS palette", () => {
    // VGA puts white at 15; a picture converted with the wrong one is not merely off, it is inverted
    expect(VGA_PALETTE[1]).not.toEqual(C64_PALETTE[1]);
  });
  it("gives every colour a distinct PETSCII code", () => {
    expect(new Set(C64_COLOR_CODES).size).toBe(16);
    // the ones Synchronet's petdefs.h names explicitly
    expect(C64_COLOR_CODES[0]).toBe(144);   // black
    expect(C64_COLOR_CODES[1]).toBe(5);     // white
    expect(C64_COLOR_CODES[2]).toBe(28);    // red
    expect(C64_COLOR_CODES[5]).toBe(30);    // green
    expect(C64_COLOR_CODES[6]).toBe(31);    // blue
  });
});

describe("XBIN carrying a palette", () => {
  const grid = CellGrid.filled(4, 2, 65, 7, 1);

  it("writes it and reads the same values back", () => {
    const bytes = encodeXbin(grid, { palette: C64_PALETTE, sauce: false, iceColors: false });
    const back = parseXbin(bytes);
    expect(back.palette).toBeDefined();
    // XBIN stores six bits per channel, so values come back quantised, not identical
    for (let i = 0; i < 16; i++) {
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(back.palette![i][k] - C64_PALETTE[i][k])).toBeLessThanOrEqual(4);
      }
    }
  });

  it("leaves the flag clear when no palette is given, so a plain file stays plain", () => {
    const bytes = encodeXbin(grid, { sauce: false, iceColors: false });
    expect(parseXbin(bytes).palette).toBeUndefined();
    expect(bytes.length).toBeLessThan(encodeXbin(grid, { palette: C64_PALETTE, sauce: false, iceColors: false }).length);
  });
});
