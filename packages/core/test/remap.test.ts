import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, RED, YELLOW, cloneLayer, composite, createCellsLayer, createDocument,
  identityRemap, isIdentityRemap, loadProject, randomRemap, remapPresets, rgb, saveProject,
} from "../src/index.js";

function doc() {
  const d = createDocument(3, 1);
  const top = createCellsLayer("top", 3, 1);
  top.grid.set(0, 0, { glyph: 65, fg: YELLOW, bg: BLUE });
  top.grid.set(1, 0, { glyph: 66, fg: rgb(1, 2, 3), bg: RED });
  d.layers.push(top);
  return { d, top };
}

describe("palette swap", () => {
  it("recolours a layer as it is composited, leaves its cells and 24-bit colours alone", () => {
    const { d, top } = doc();
    top.remap = identityRemap();
    top.remap[YELLOW] = 10; top.remap[BLUE] = RED; top.remap[RED] = 5;
    const out = composite(d).grid;
    expect(out.get(0, 0)).toMatchObject({ glyph: 65, fg: 10, bg: RED });
    expect(out.get(1, 0)).toMatchObject({ fg: rgb(1, 2, 3), bg: 5 });
    expect(top.grid.get(0, 0)).toMatchObject({ fg: YELLOW, bg: BLUE });
    top.remap = undefined;
    expect(composite(d).grid.get(0, 0)).toMatchObject({ fg: YELLOW, bg: BLUE });
  });

  it("only affects its own layer", () => {
    const { d, top } = doc();
    (d.layers[0] as CellsLayer).grid = CellGrid.filled(3, 1, 177, YELLOW, BLACK);
    top.remap = identityRemap().map(() => RED);
    expect(composite(d).grid.get(2, 0)).toMatchObject({ glyph: 177, fg: YELLOW });
  });

  it("with iCE off a swap never turns a background into blink, and keeps blink that was there", () => {
    const { d, top } = doc();
    top.grid.set(2, 0, { glyph: 65, fg: 7, bg: 9 });        // blink on blue, drawn on purpose
    top.remap = identityRemap();
    top.remap[BLUE] = 12; top.remap[RED] = 4 + 8;             // "brighten" blue and red backgrounds
    const out = composite(d).grid;
    expect(out.get(0, 0).bg).toBe(RED);                        // 12 & 7: the dark shade, not blink
    expect(out.get(1, 0).bg).toBe(RED);
    expect(out.get(2, 0).bg).toBe(12);                         // colour swapped, blink bit kept
    d.iceColors = true;
    expect(composite(d).grid.get(0, 0).bg).toBe(12);           // with iCE on it is just a colour
  });

  it("key rules still match the stored colours", () => {
    const { d, top } = doc();
    top.remap = identityRemap();
    top.remap[BLUE] = RED;
    top.keys = [{ match: { bg: { oneOf: [BLUE] } }, drop: "cell", enabled: true }];
    expect(composite(d).grid.get(0, 0).glyph).toBe(32);   // keyed out although it would now show red
  });

  it("presets are valid maps and keep bright paired with dark", () => {
    const presets = remapPresets();
    expect(presets.length).toBeGreaterThan(15);
    for (const p of presets) {
      expect(p.remap).toHaveLength(16);
      expect(p.remap.every((v) => Number.isInteger(v) && v >= 0 && v < 16)).toBe(true);
      expect(p.name === "negative" || p.remap[0] === 0).toBe(true);   // black only moves when you ask for a negative
    }
    const rot = presets.find((p) => p.name === "rotate hues 120°")!.remap;
    expect([rot[4], rot[12], rot[0], rot[7], rot[8], rot[15]]).toEqual([2, 10, 0, 7, 8, 15]);   // red -> green; greys have no hue to rotate
    const flip = presets.find((p) => p.name === "swap bright / dark")!.remap;
    expect([flip[1], flip[9], flip[8], flip[7], flip[0], flip[15]]).toEqual([9, 1, 7, 8, 0, 15]);
  });

  it("greys and white take part by default: grey-heavy art actually changes", () => {
    const allRed = remapPresets().find((p) => p.name === "all red")!.remap;
    expect([allRed[1], allRed[9], allRed[14]]).toEqual([4, 12, 12]);
    expect([allRed[8], allRed[7], allRed[15]]).toEqual([4, 12, 12]);   // dark grey, light grey, white
    const onlyGreys = remapPresets().find((p) => p.name === "greys → cyan")!.remap;
    expect([onlyGreys[8], onlyGreys[7], onlyGreys[15], onlyGreys[4], onlyGreys[9]]).toEqual([3, 11, 11, 4, 9]);
  });

  it("the options leave greys and/or white alone", () => {
    const noGreys = remapPresets({ greys: false, white: false }).find((p) => p.name === "all red")!.remap;
    expect([noGreys[8], noGreys[7], noGreys[15], noGreys[1]]).toEqual([8, 7, 15, 4]);
    const keepWhite = remapPresets({ greys: true, white: false }).find((p) => p.name === "all red")!.remap;
    expect([keepWhite[8], keepWhite[7], keepWhite[15]]).toEqual([4, 12, 15]);
    const greysKeepWhite = remapPresets({ greys: true, white: false }).find((p) => p.name === "greys → blue")!.remap;
    expect([greysKeepWhite[7], greysKeepWhite[15]]).toEqual([9, 15]);
  });

  it("randomize shuffles whole families, always moves the greys when they are included, and is a full shuffle when wild", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 50; n++) {
      const r = randomRemap(rnd);
      expect(r[0]).toBe(0);
      expect(r[7] !== 7 && r[8] !== 8).toBe(true);                 // greys became a hue
      expect(r[15]).toBe(r[7]);                                     // white followed light grey
      for (const [dark, bright] of [[1, 9], [2, 10], [3, 11], [4, 12], [5, 13], [6, 14]]) {
        const pair = [r[dark], r[bright]];
        expect(pair[0] === 8 ? pair[1] === 7 : pair[1] === pair[0] + 8).toBe(true);   // a family lands on a family
      }
      expect(new Set([r[1], r[2], r[3], r[4], r[5], r[6], r[8]]).size).toBe(7);        // no two families collide
    }
    const plain = randomRemap(rnd, false, { greys: false, white: false });
    expect([plain[0], plain[7], plain[8], plain[15]]).toEqual([0, 7, 8, 15]);
    expect(isIdentityRemap(plain)).toBe(false);
    expect([...randomRemap(rnd, true)].sort((a, b) => a - b)).toEqual(identityRemap());
    expect(isIdentityRemap(identityRemap()) && isIdentityRemap(undefined) && !isIdentityRemap(remapPresets()[0].remap)).toBe(true);
  });

  it("is saved with the project and copied when a layer is duplicated", () => {
    const { d, top } = doc();
    top.remap = remapPresets()[0].remap;
    const back = loadProject(saveProject(d));
    expect((back.layers[1] as CellsLayer).remap).toEqual(top.remap);
    const copy = cloneLayer(top) as CellsLayer;
    copy.remap![1] = 0;
    expect(top.remap[1]).not.toBe(0);
  });
});
