import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, BROWN, CellGrid, GREEN, type GroupLayer, LIGHT_GRAY, RED, WHITE, YELLOW,
  composite, createCellsLayer, createDocument,
} from "../src/index.js";

const COMMA = 44, A = 65, FULL = 219, LOWER = 220, UPPER = 223, LEFT = 221, SHADE = 176;

/** 4x2 document: a blue bottom layer full of 'x', plus an empty top layer. */
function twoLayers() {
  const doc = createDocument(4, 2);
  const bottom = doc.layers[0] as ReturnType<typeof createCellsLayer>;
  bottom.grid = CellGrid.filled(4, 2, 120, WHITE, BLUE);
  const top = createCellsLayer("top", 4, 2);
  doc.layers.push(top);
  return { doc, bottom, top };
}

describe("compositor", () => {
  it("fills with the base cell where no layer has anything", () => {
    const doc = createDocument(2, 1);
    const out = composite(doc);
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 32, fg: LIGHT_GRAY, bg: BLACK });
    expect(out.owner[0]).toBe(-1);
  });

  it("lets lower layers show where the upper layer was never painted", () => {
    const { doc, top } = twoLayers();
    top.grid.set(1, 0, { glyph: A, fg: RED, bg: BLACK });
    const out = composite(doc);
    expect(out.grid.get(1, 0)).toMatchObject({ glyph: A, fg: RED, bg: BLACK });
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 120, fg: WHITE, bg: BLUE });
    expect([out.owner[1], out.owner[0]]).toEqual([1, 0]);
  });

  it("key rule: black-on-black empties in an opaque upper layer become see-through", () => {
    const { doc, top } = twoLayers();
    top.grid = CellGrid.filled(4, 2, 32, LIGHT_GRAY, BLACK);   // an imported .ans: solid black everywhere
    top.grid.set(2, 1, { glyph: A, fg: RED, bg: BLACK });
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: 32, bg: BLACK });   // covers everything

    top.keys = [{ match: { appearsSolid: BLACK }, drop: "cell", enabled: true }];
    const out = composite(doc);
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 120, fg: WHITE, bg: BLUE });
    expect(out.grid.get(2, 1)).toMatchObject({ glyph: A, fg: RED, bg: BLACK });
  });

  it("key rule: a specific character + colours (yellow comma on blue) is filtered, others are not", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid = CellGrid.filled(4, 2, 120, WHITE, GREEN);
    top.grid.set(0, 0, { glyph: COMMA, fg: YELLOW, bg: BLUE });
    top.grid.set(1, 0, { glyph: COMMA, fg: YELLOW, bg: RED });
    top.keys = [{
      match: { glyph: { oneOf: [COMMA] }, fg: { oneOf: [YELLOW] }, bg: { oneOf: [BLUE] } },
      drop: "cell", enabled: true,
    }];
    const out = composite(doc);
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 120, bg: GREEN });
    expect(out.grid.get(1, 0)).toMatchObject({ glyph: COMMA, fg: YELLOW, bg: RED });
  });

  it("key rules are non-destructive: disabling one brings the cells back", () => {
    const { doc, top } = twoLayers();
    top.grid = CellGrid.filled(4, 2, 32, LIGHT_GRAY, BLACK);
    const before = top.grid.clone();
    top.keys = [{ match: { appearsSolid: BLACK }, drop: "cell", enabled: true }];
    composite(doc);
    expect(top.grid.equals(before)).toBe(true);
    top.keys[0].enabled = false;
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: 32, bg: BLACK });
  });

  it("key rule dropping only the background keeps the glyph and takes the colour below", () => {
    const { doc, top } = twoLayers();
    top.grid.set(0, 0, { glyph: A, fg: YELLOW, bg: BLACK });
    top.keys = [{ match: { bg: { oneOf: [BLACK] } }, drop: "bg", enabled: true }];
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: A, fg: YELLOW, bg: BLUE });
  });

  it("a glyph without a background sits on what the stack below appears to be", () => {
    const { doc, bottom, top } = twoLayers();
    doc.iceColors = true;
    bottom.grid.set(0, 0, { glyph: FULL, fg: RED, bg: BLACK });    // looks red, though its bg is black
    top.grid.set(0, 0, { glyph: A, fg: WHITE });
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: A, fg: WHITE, bg: RED });
  });

  it("a space without a background is nothing at all", () => {
    const { doc, top } = twoLayers();
    top.grid.set(0, 0, { glyph: 32, fg: RED });
    const out = composite(doc);
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 120, fg: WHITE, bg: BLUE });
    expect(out.owner[0]).toBe(0);
  });

  it("a colour-only cell recolours what is below", () => {
    const { doc, top } = twoLayers();
    top.grid.set(0, 0, { fg: YELLOW });
    const out = composite(doc);
    expect(out.grid.get(0, 0)).toMatchObject({ glyph: 120, fg: YELLOW, bg: BLUE });
    expect(out.owner[0]).toBe(0);
  });

  it("merges half blocks: ▀ over ▄ keeps both colours in one cell", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: LOWER, fg: BLUE, bg: BLACK });   // black over blue
    top.grid.set(0, 0, { glyph: UPPER, fg: RED });                  // red over see-through
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: UPPER, fg: RED, bg: BLUE });
  });

  it("merges to a solid cell when both halves end up the same colour", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: LOWER, fg: RED, bg: BLACK });
    top.grid.set(0, 0, { glyph: UPPER, fg: RED });
    const c = composite(doc).grid.get(0, 0);
    expect(c).toMatchObject({ glyph: 32, bg: RED });
  });

  it("a see-through foreground half works the same as a see-through background half", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: 32, fg: WHITE, bg: GREEN });
    top.grid.set(0, 0, { glyph: LOWER, bg: RED });                   // red on top, bottom half open
    const c = composite(doc).grid.get(0, 0);
    expect(c).toMatchObject({ glyph: LOWER, fg: GREEN, bg: RED });
  });

  it("flips a merged half block rather than put a bright colour in a blinking background", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: 32, fg: WHITE, bg: BLUE });
    top.grid.set(0, 0, { glyph: LOWER, fg: YELLOW });                // yellow bottom half over blue
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: LOWER, fg: YELLOW, bg: BLUE });
    top.grid.set(0, 0, { glyph: UPPER, fg: YELLOW });
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: UPPER, fg: YELLOW, bg: BLUE });
    top.grid.clear(0, 0);
    top.grid.set(0, 0, { glyph: UPPER, bg: YELLOW });                // as drawn this would need a yellow bg
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: LOWER, fg: YELLOW, bg: BLUE });
  });

  it("merges left/right half blocks on their own axis, and not across axes", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: 32, fg: WHITE, bg: GREEN });
    top.grid.set(0, 0, { glyph: LEFT, fg: RED });
    expect(composite(doc).grid.get(0, 0)).toMatchObject({ glyph: LEFT, fg: RED, bg: GREEN });

    bottom.grid.set(1, 0, { glyph: UPPER, fg: BLUE, bg: GREEN });    // splits vertically only
    top.grid.set(1, 0, { glyph: LEFT, fg: RED });
    expect(composite(doc).grid.get(1, 0)).toMatchObject({ glyph: LEFT, fg: RED, bg: GREEN });   // general rule
  });

  it("with iCE off, a derived background is dimmed instead of blinking", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: FULL, fg: YELLOW, bg: BLACK });
    top.grid.set(0, 0, { glyph: A, fg: WHITE });
    expect(composite(doc).grid.get(0, 0).bg).toBe(BROWN);
    doc.iceColors = true;
    expect(composite(doc).grid.get(0, 0).bg).toBe(YELLOW);
  });

  it("inheritBg 'dominant' needs coverage and picks the colour covering more of the cell", () => {
    const { doc, bottom, top } = twoLayers();
    bottom.grid.set(0, 0, { glyph: SHADE, fg: RED, bg: GREEN });
    top.grid.set(0, 0, { glyph: A, fg: WHITE });
    const classes = new Uint8Array(256), coverage = new Float32Array(256);
    coverage[SHADE] = 0.75;
    expect(composite(doc).grid.get(0, 0).bg).toBe(GREEN);
    expect(composite(doc, { inheritBg: "dominant", glyphs: { classes, coverage } }).grid.get(0, 0).bg).toBe(RED);
  });

  it("honours layer offsets, including negative ones and content hanging off the canvas", () => {
    const { doc, top } = twoLayers();
    top.grid.set(0, 0, { glyph: A, fg: RED, bg: BLACK });
    top.grid.set(3, 1, { glyph: 66, fg: RED, bg: BLACK });
    top.x = 2; top.y = 1;
    let out = composite(doc);
    expect(out.grid.get(2, 1).glyph).toBe(A);
    expect(out.grid.get(0, 0).glyph).toBe(120);
    top.x = -3; top.y = -1;
    out = composite(doc);
    expect(out.grid.get(0, 0).glyph).toBe(66);
  });

  it("skips hidden layers and everything inside a hidden group", () => {
    const { doc, top } = twoLayers();
    top.grid.set(0, 0, { glyph: A, fg: RED, bg: BLACK });
    const group: GroupLayer = { type: "group", id: "g", name: "g", visible: true, locked: false, children: [top] };
    doc.layers[1] = group;
    expect(composite(doc).grid.get(0, 0).glyph).toBe(A);
    group.visible = false;
    expect(composite(doc).grid.get(0, 0).glyph).toBe(120);
  });

  it("a dirty-rect update gives the same result as a full recomposite", () => {
    const { doc, top } = twoLayers();
    const live = composite(doc);
    top.grid.set(1, 1, { glyph: UPPER, fg: RED });
    top.grid.set(3, 0, { glyph: A, fg: YELLOW, bg: BLACK });
    composite(doc, {}, { x: 1, y: 1, width: 1, height: 1 }, live);
    expect(live.grid.get(3, 0).glyph).toBe(120);              // outside the rect: untouched
    composite(doc, {}, { x: 3, y: 0, width: 1, height: 1 }, live);
    const fresh = composite(doc);
    expect(live.grid.equals(fresh.grid)).toBe(true);
    expect(Array.from(live.owner)).toEqual(Array.from(fresh.owner));
  });
});
