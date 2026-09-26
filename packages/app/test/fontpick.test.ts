import { describe, expect, it } from "vitest";
import { type FontEntry, type FontLibrary, randomFontOfHeight } from "../src/fonts.js";

const entry = (name: string, file: string, index: number, height: number): FontEntry =>
  ({ name, file, index, height, type: "Color" });

const lib = (entries: FontEntry[]): FontLibrary => ({ entries } as FontLibrary);

describe("rolling for another TheDraw font", () => {
  const entries = [
    entry("a", "one.tdf", 0, 8), entry("b", "one.tdf", 1, 8), entry("c", "two.tdf", 0, 8),
    entry("tall", "three.tdf", 0, 16), entry("short", "four.tdf", 0, 4),
  ];

  it("only ever returns a font of the height asked for", () => {
    for (let i = 0; i < 200; i++) expect(randomFontOfHeight(lib(entries), 8)?.height).toBe(8);
  });

  it("never hands back the font already in use, so pressing it again always moves", () => {
    for (let i = 0; i < 200; i++) {
      const got = randomFontOfHeight(lib(entries), 8, "one.tdf", 0)!;
      expect(`${got.file}#${got.index}`).not.toBe("one.tdf#0");
    }
  });

  it("tells the difference between two fonts in the same file", () => {
    const got = randomFontOfHeight(lib([entry("a", "one.tdf", 0, 8), entry("b", "one.tdf", 1, 8)]), 8, "one.tdf", 0)!;
    expect(got.index).toBe(1);
  });

  it("reaches every font of that height, given enough rolls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const got = randomFontOfHeight(lib(entries), 8)!;
      seen.add(`${got.file}#${got.index}`);
    }
    expect(seen.size).toBe(3);
  });

  it("gives back nothing rather than a wrong size when there is no other font that tall", () => {
    expect(randomFontOfHeight(lib(entries), 16, "three.tdf", 0)).toBeNull();
    expect(randomFontOfHeight(lib(entries), 99)).toBeNull();
    expect(randomFontOfHeight(lib([]), 8)).toBeNull();
  });
});
