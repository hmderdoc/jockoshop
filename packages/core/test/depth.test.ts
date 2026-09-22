import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, RED, WHITE, composite, createCellsLayer, createDocument, createRaster,
  depthToPd, disparity, encodeAnsi, parseAnsi, parseRawFont, planDepth, renderDepthView,
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

  it("text cannot come in front of the screen in protocol 0.3: it is clamped, and reported", () => {
    const { doc, front } = scene();
    front.depth = 80;
    const plan = planDepth(composite(doc));
    expect(depthToPd(80)).toBe(0);
    expect(plan.clamped).toEqual(["front"]);
  });

  it("disparity follows the 3dBBS camera: none at the glass, growing towards 1 with distance", () => {
    expect(disparity(0)).toBe(0);
    expect(disparity(200)).toBeCloseTo(0.5);      // 2 units behind a glass 2 units away
    expect(disparity(1800)).toBeCloseTo(0.9);
  });
});

describe("depth plan", () => {
  it("gives each cell the depth of the layer that owns it; layer 0 is the screen", () => {
    const plan = planDepth(composite(scene().doc));
    expect(plan.levels).toEqual([0, 150]);
    expect(Array.from(plan.cellLevel)).toEqual([1, 1, 0, 1, 1, 1]);
    expect(plan.merged).toBe(false);
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
    expect(text.match(/\x1b\[=\dz/g)).toEqual(["\x1b[=1z", "\x1b[=0z", "\x1b[=1z", "\x1b[=0z"]);
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
});
