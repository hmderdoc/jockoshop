import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, RED, WHITE, composite, createCellsLayer, createDocument, createRaster,
  depthToPd, deviceShiftPx, disparity, encodeAnsi, parseAnsi, parseRawFont, planDepth, renderDepthView,
} from "../src/index.js";

const font = parseRawFont(new Uint8Array(readFileSync(new URL("../assets/ibmstd.f16", import.meta.url))));

/** backdrop 1.5 units behind the screen, a block at the screen in front of it */
function scene() {
  const doc = createDocument(6, 1);
  const back = doc.layers[0] as CellsLayer;
  back.grid = CellGrid.filled(6, 1, 219, BLUE, BLACK);
  back.depth = -150;
  const front = createCellsLayer("front", 6, 1);
  front.grid.set(2, 0, { glyph: 219, fg: RED, bg: BLACK });
  doc.layers.push(front);
  return { doc, back, front };
}

describe("depth convention", () => {
  it("0 is the screen, negative is behind it, and the wire carries the distance behind", () => {
    expect([depthToPd(undefined), depthToPd(0), depthToPd(-150), depthToPd(-5000)]).toEqual([0, 0, 150, 1800]);
  });

  it("in front of the screen is a negative Pd, clamped to what the device can show, and reported", () => {
    const { doc, front } = scene();
    front.depth = 80;
    const plan = planDepth(composite(doc));
    expect(depthToPd(80)).toBe(-80);
    expect(depthToPd(900)).toBe(-100);
    expect(plan.front).toEqual(["front"]);
    expect(plan.levels).toEqual([-80, 0, 150]);   // the screen plane is always defined
  });

  it("deviceShiftPx is the 3DS's own projection: iod = slider/3, fov 40°, D = 2 + depth, 400 px wide", () => {
    const px = (pd: number): number => Math.round(deviceShiftPx(pd) * 10) / 10;
    expect([px(0), px(12), px(50), px(565), px(-30), px(-135)]).toEqual([0, 1.6, 5.5, 20.3, -4.8, -57.1]);
    expect(deviceShiftPx(565, 0.5)).toBeCloseTo(deviceShiftPx(565) / 2);   // the slider scales it linearly
  });

  it("disparity follows the 3dBBS camera: none at the glass, growing towards 1 with distance, crossing in front", () => {
    expect(disparity(0)).toBe(0);
    expect(disparity(200)).toBeCloseTo(0.5);      // 2 units behind a glass 2 units away
    expect(disparity(1800)).toBeCloseTo(0.9);
    expect(disparity(-100)).toBeCloseTo(-1);      // 1 unit in front: halfway to the camera
  });

  it("front depths go out as the `+ z` extension and come back in", async () => {
    const { parseArt, documentFromArt } = await import("../src/index.js");
    const { doc, front } = scene();
    front.depth = 80;
    const comp = composite(doc), plan = planDepth(comp);
    const text = String.fromCharCode(...encodeAnsi(comp.grid, { iceColors: false, sauce: false, depth: plan }));
    expect(text).toContain("\x1b[=0;80+z");
    expect(text).toContain("\x1b[=2;150*z");
    expect(text.indexOf("\x1b[=0z")).toBeGreaterThan(text.indexOf("+z"));   // back on layer 0 before any cell, for 0.3 clients
    const art = parseArt(encodeAnsi(comp.grid, { iceColors: false, sauce: doc.sauce, depth: plan }), "x.ans");
    expect(art.depths![0]).toBe(-80);
    const back = documentFromArt(art);
    expect(back.layers.map((l) => [l.name, (l as CellsLayer).depth])).toEqual([["depth −150", -150], ["depth +80 (in front)", 80]]);
  });
});

describe("depth plan", () => {
  it("gives each cell the depth of the layer that owns it; layer 0 is the screen", () => {
    const plan = planDepth(composite(scene().doc));
    expect(plan.levels).toEqual([0, 150]);
    expect(plan.front).toEqual([]);
    expect(Array.from(plan.cellLevel)).toEqual([1, 1, 0, 1, 1, 1]);
    expect(plan.merged).toBe(false);
  });

  it("cells nobody draws stay at the screen even when a pop-out layer takes protocol layer 0", () => {
    const doc = createDocument(4, 1);
    const pop = doc.layers[0] as CellsLayer;
    pop.grid.set(0, 0, { glyph: 219, fg: RED, bg: BLACK });
    pop.depth = 60;
    const plan = planDepth(composite(doc));
    expect(plan.levels).toEqual([-60, 0]);
    expect(Array.from(plan.cellLevel)).toEqual([0, 1, 1, 1]);
  });

  it("merges the closest depths when there are more than 16, keeping the screen plane", () => {
    const doc = createDocument(20, 1);
    doc.layers = [];
    for (let n = 0; n < 20; n++) {
      const l = createCellsLayer(`L${n}`, 20, 1);
      l.grid.set(n, 0, { glyph: 219, fg: WHITE, bg: BLACK });
      l.depth = -(n * 10 + (n > 10 ? 300 : 0));
      doc.layers.push(l);
    }
    const plan = planDepth(composite(doc));
    expect(plan.merged).toBe(true);
    expect(plan.levels.length).toBeLessThanOrEqual(16);
    expect(plan.levels[0]).toBe(0);
    expect(Math.max(...plan.cellLevel)).toBeLessThan(plan.levels.length);
  });
});

describe("3dBBS export", () => {
  it("defines the layers, tags cells as the layer changes, and ends back at the screen", () => {
    const { doc } = scene();
    const comp = composite(doc), plan = planDepth(comp);
    const text = String.fromCharCode(...encodeAnsi(comp.grid, { iceColors: false, sauce: false, depth: plan }));
    expect(text).toContain("\x1b[=1;150*z");
    expect(text).not.toContain("\x1b[=0;0*z");                       // the default layer needs no definition
    expect(text.match(/\x1b\[=\dz/g)).toEqual(["\x1b[=0z", "\x1b[=1z", "\x1b[=0z", "\x1b[=1z", "\x1b[=0z"]);   // an explicit layer 0 first
  });

  it("is still the same picture to a terminal that ignores the depth sequences", () => {
    const { doc } = scene();
    const comp = composite(doc);
    const bytes = encodeAnsi(comp.grid, { iceColors: false, sauce: doc.sauce, depth: planDepth(comp) });
    expect(parseAnsi(bytes, { width: 6 }).grid.equals(comp.grid)).toBe(true);
  });
});

describe("stereo preview", () => {
  it("shifts deeper cells further, in opposite directions for the two eyes, and leaves the screen plane still", () => {
    const { doc } = scene();
    const comp = composite(doc), plan = planDepth(comp);
    const px = (eye: number, x: number) => {
      const r = createRaster(6, 1, font);
      renderDepthView(comp, plan, font, r, eye);
      return [...r.data.subarray(x * 4, x * 4 + 3)];
    };
    const red = [170, 0, 0], blue = [0, 0, 170], black = [0, 0, 0];
    expect(px(0, 16)).toEqual(red);                  // no separation: the flat picture
    expect(px(-28, 16)).toEqual(red);                // the block at the screen never moves
    expect(px(28, 16)).toEqual(red);
    // backdrop: disparity(150) = 0.4286 -> 12 px at eye = 28
    expect(px(28, 0)).toEqual(black);                // right eye: backdrop slid right, uncovering black
    expect(px(28, 12)).toEqual(blue);
    expect(px(-28, 47)).toEqual(black);              // left eye: slid left
    expect(px(-28, 0)).toEqual(blue);
  });

  it("a pop-out layer shifts the opposite way and is drawn on top", () => {
    const { doc, front } = scene();
    front.depth = 100;                               // 1 unit in front: disparity -1
    const comp = composite(doc), plan = planDepth(comp);
    const r = createRaster(6, 1, font);
    renderDepthView(comp, plan, font, r, 28);       // right eye: the red block moves LEFT by 28 px, from x 16..23 to -12..-5 (clipped) — so take a smaller eye
    renderDepthView(comp, plan, font, r, 8);        // right eye: the block slides 8 px left, backdrop slides right by ~3
    const at = (x: number) => [...r.data.subarray(x * 4, x * 4 + 3)];
    expect(at(8)).toEqual([170, 0, 0]);              // red now covers x 8..15
    expect(at(20)).not.toEqual([170, 0, 0]);
  });
});

describe("depth tags come back in", () => {
  it("a 3dBBS export opens as one layer per depth plane, deepest at the bottom, with depths set", async () => {
    const { documentFromArt, parseArt } = await import("../src/index.js");
    const { doc } = scene();
    const comp = composite(doc);
    const bytes = encodeAnsi(comp.grid, { iceColors: false, sauce: doc.sauce, depth: planDepth(comp) });
    const art = parseArt(bytes, "piece-3d.ans");
    expect(art.depths?.[1]).toBe(150);
    const back = documentFromArt(art);
    expect(back.layers.map((l) => [l.name, l.type === "cells" ? l.depth : null])).toEqual([["depth −150", -150], ["at the screen", undefined]]);
    const deep = back.layers[0] as CellsLayer, screen = back.layers[1] as CellsLayer;
    expect(deep.grid.get(0, 0)).toMatchObject({ glyph: 219, fg: BLUE });
    expect(deep.grid.get(2, 0).present).toBe(0);           // the front block's cell belongs to the screen layer
    expect(screen.grid.get(2, 0)).toMatchObject({ glyph: 219, fg: RED });
    expect(composite(back).grid.equals(comp.grid)).toBe(true);
    // and exporting again produces the same tags
    const again = parseArt(encodeAnsi(composite(back).grid, { iceColors: false, sauce: doc.sauce, depth: planDepth(composite(back)) }), "x.ans");
    expect(Array.from(again.depthLayer!)).toEqual(Array.from(art.depthLayer!));
  });

  it("a plain .ans has no depth information and opens as one layer", async () => {
    const { documentFromArt, parseArt } = await import("../src/index.js");
    const art = parseArt(encodeAnsi(CellGrid.filled(4, 1, 65, WHITE, BLACK), { iceColors: false, sauce: false }), "x.ans");
    expect(art.depthLayer).toBeUndefined();
    expect(documentFromArt(art).layers).toHaveLength(1);
  });
});
