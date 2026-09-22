import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  BLACK, BLUE, CellGrid, type CellsLayer, type FontLayer, type GroupLayer, RED, WHITE, YELLOW,
  composite, createCellsLayer, createDocument, decodeGrid, documentFromArt, encodeAnsi, encodeGrid,
  layerFromArt, loadProject, parseAnsi, rgb, saveProject,
} from "../src/index.js";

function sampleDoc() {
  const doc = createDocument(20, 5);
  doc.iceColors = true;
  doc.sauce = { title: "Layered", author: "me", group: "", date: "20260921", comments: ["hi"] };
  const bg = doc.layers[0] as CellsLayer;
  bg.grid = CellGrid.filled(20, 5, 177, BLUE, BLACK);

  const art = createCellsLayer("art", 8, 3);
  art.x = 3; art.y = 1; art.depth = -150;
  art.grid.set(0, 0, { glyph: 65, fg: rgb(1, 2, 3), bg: RED });
  art.grid.set(1, 0, { glyph: 223, fg: YELLOW });
  art.keys = [{ match: { glyph: { oneOf: [44] }, fg: { oneOf: [YELLOW] }, bg: { oneOf: [BLUE] } }, drop: "cell", enabled: true }];

  const text: FontLayer = {
    type: "font", id: "font1", name: "title", visible: true, locked: false, x: 0, y: 0, keys: [],
    runs: [{ font: "assets/fonts/TEST.TDF", fontIndex: 0, text: "hi" }], spacing: 1, lineGap: 1, spaceWidth: 3, fg: 7, bg: null,
    cache: CellGrid.filled(2, 1, 219, WHITE, BLACK),
  };
  const group: GroupLayer = { type: "group", id: "grp1", name: "group", visible: true, locked: false, children: [art, text] };
  doc.layers.push(group);
  doc.assets.set("assets/fonts/TEST.TDF", Uint8Array.from([1, 2, 3, 4]));
  return doc;
}

describe("project file", () => {
  it("round-trips grid data including absent channels and 24-bit colour", () => {
    const g = new CellGrid(3, 2);
    g.set(0, 0, { glyph: 65, fg: rgb(255, 254, 253) });
    g.set(2, 1, { bg: 15 });
    expect(decodeGrid(encodeGrid(g)).equals(g)).toBe(true);
  });

  it("round-trips a layered document: settings, tree, offsets, depth, key rules, recipes, caches, assets", () => {
    const doc = sampleDoc();
    const back = loadProject(saveProject(doc));
    expect(back.width).toBe(20);
    expect(back.iceColors).toBe(true);
    expect(back.sauce).toEqual(doc.sauce);
    expect(back.palette).toEqual(doc.palette);

    const group = back.layers[1] as GroupLayer;
    const art = group.children[0] as CellsLayer, text = group.children[1] as FontLayer;
    const srcArt = (doc.layers[1] as GroupLayer).children[0] as CellsLayer;
    expect(art).toMatchObject({ name: "art", x: 3, y: 1, depth: -150, keys: srcArt.keys });
    expect(art.grid.equals(srcArt.grid)).toBe(true);
    expect(text.runs).toEqual([{ font: "assets/fonts/TEST.TDF", fontIndex: 0, text: "hi" }]);
    expect(text.cache!.get(1, 0).glyph).toBe(219);
    expect(back.assets.get("assets/fonts/TEST.TDF")).toEqual(Uint8Array.from([1, 2, 3, 4]));

    expect(composite(back).grid.equals(composite(doc).grid)).toBe(true);
  });

  it("embeds a flattened preview.ans that matches the composite", () => {
    const doc = sampleDoc();
    const files = unzipSync(saveProject(doc));
    expect(Object.keys(files)[0]).toBe("manifest.json");
    const preview = parseAnsi(files["preview.ans"]);
    expect(preview.grid.equals(composite(doc).grid)).toBe(true);
    expect(preview.sauce!.title).toBe("Layered");
  });

  it("refuses files that aren't projects, or come from a newer version", () => {
    expect(() => loadProject(Uint8Array.from([1, 2, 3]))).toThrow();
    const files = unzipSync(saveProject(sampleDoc()));
    expect(JSON.parse(new TextDecoder().decode(files["manifest.json"])).version).toBe(1);
  });
});

describe("importing flat art", () => {
  it("opens an .ans as a one-layer document", () => {
    const g = CellGrid.filled(80, 4, 176, RED, BLUE);
    const bytes = encodeAnsi(g, { iceColors: true, sauce: { title: "t", author: "a", group: "g", date: "20260101", comments: [] } });
    const doc = documentFromArt(parseAnsi(bytes));
    expect(doc).toMatchObject({ width: 80, height: 4, iceColors: true, sauce: { title: "t", author: "a" } });
    expect(composite(doc).grid.equals(g)).toBe(true);
  });

  it("adds an .ans as an upper layer whose black areas don't cover the layer below", () => {
    const doc = createDocument(10, 2);
    (doc.layers[0] as CellsLayer).grid = CellGrid.filled(10, 2, 177, BLUE, BLACK);
    const flat = CellGrid.filled(10, 2, 32, 7, BLACK);
    flat.set(4, 1, { glyph: 65, fg: YELLOW, bg: BLACK });
    doc.layers.push(layerFromArt(parseAnsi(encodeAnsi(flat, { iceColors: false, sauce: false }), { width: 10 }), "logo"));
    const out = composite(doc).grid;
    expect(out.get(0, 0)).toMatchObject({ glyph: 177, fg: BLUE });
    expect(out.get(4, 1)).toMatchObject({ glyph: 65, fg: YELLOW });
  });
});

describe("project format name", () => {
  it("writes the jockoshop format name", () => {
    const files = unzipSync(saveProject(sampleDoc()));
    expect(JSON.parse(strFromU8(files["manifest.json"]!)).format).toBe("jockoshop");
  });

  it("still opens a project saved under the old killerdraw name", () => {
    const files = unzipSync(saveProject(sampleDoc()));
    const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
    manifest.format = "killerdraw";
    files["manifest.json"] = strToU8(JSON.stringify(manifest));
    const doc = loadProject(zipSync(files));
    expect(doc.width).toBe(20);
    expect(doc.layers.length).toBe(2);
  });

  it("rejects a ZIP that is some other format", () => {
    const files = unzipSync(saveProject(sampleDoc()));
    files["manifest.json"] = strToU8(JSON.stringify({ format: "other", version: 1 }));
    expect(() => loadProject(zipSync(files))).toThrow(/not a jockoshop project/);
  });
});
