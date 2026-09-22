import { type KdDocument, createCellsLayer, createDocument } from "./document.js";
import { type ImportedArt, parseAnsi } from "./formats/ansi.js";
import { parseBin } from "./formats/bin.js";
import { parseXbin } from "./formats/xbin.js";
import { isTundra, parseTundra } from "./formats/tundra.js";
import { isCtrlA, parseCtrlA } from "./formats/ctrla.js";
import { isIdf, parseAdf, parseAvatar, parseIdf } from "./formats/legacy.js";
import { BLACK } from "./color.js";
import type { CellsLayer, KeyRule } from "./document.js";

/** Pick a parser from the content where the format has a signature, else from the file extension. */
export function parseArt(bytes: Uint8Array, fileName = ""): ImportedArt {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 4)) === "XBIN" && bytes[4] === 0x1a) return parseXbin(bytes);
  if (isTundra(bytes)) return parseTundra(bytes);
  if (isIdf(bytes)) return parseIdf(bytes);
  if (/\.bin$/i.test(fileName)) return parseBin(bytes);
  if (/\.adf$/i.test(fileName)) return parseAdf(bytes);
  if (/\.avt$/i.test(fileName)) return parseAvatar(bytes);
  if (/\.(msg|ctrla)$/i.test(fileName) || isCtrlA(bytes)) return parseCtrlA(bytes);
  return parseAnsi(bytes);
}

/** File extensions parseArt understands. */
export const ART_EXTENSIONS = ["ans", "asc", "diz", "nfo", "txt", "bin", "xb", "xbin", "tnd", "adf", "idf", "avt", "msg", "ctrla"];

/**
 * A flat file opened as a document: one layer, or — for a 3dBBS export whose
 * cells carry depth tags — one layer per depth plane, deepest at the bottom,
 * each with its depth set, so the piece can go on being edited in 3D.
 */
export function documentFromArt(art: ImportedArt, layerName = "Background"): KdDocument {
  const doc = flatDocument(art, layerName);
  if (!art.depthLayer || !art.depths) return doc;
  const used = [...new Set(art.depthLayer)].sort((a, b) => art.depths![b] - art.depths![a]);   // deepest first
  if (used.length < 2 && (art.depths[used[0] ?? 0] ?? 0) === 0) return doc;
  const flat = doc.layers[0] as CellsLayer;
  doc.layers = used.map((n) => {
    const pd = art.depths![n];
    const layer = createCellsLayer(pd ? `depth −${pd}` : "at the screen", flat.grid.width, flat.grid.height);
    if (pd) layer.depth = -pd;
    for (let i = 0; i < flat.grid.present.length; i++) {
      if (art.depthLayer![i] !== n) continue;
      layer.grid.glyph[i] = flat.grid.glyph[i]; layer.grid.fg[i] = flat.grid.fg[i]; layer.grid.bg[i] = flat.grid.bg[i]; layer.grid.present[i] = flat.grid.present[i];
    }
    return layer;
  });
  return doc;
}

function flatDocument(art: ImportedArt, layerName: string): KdDocument {
  const doc = createDocument(art.grid.width, art.grid.height);
  doc.iceColors = art.iceColors;
  doc.letterSpacing9px = art.letterSpacing9px;
  doc.fontName = art.fontName;
  if (art.palette) doc.palette = art.palette;
  if (art.fontBytes) doc.assets.set("assets/fonts/document.fnt", art.fontBytes);
  if (art.sauce) {
    const { title, author, group, date, comments } = art.sauce;
    doc.sauce = { title, author, group, date, comments };
  }
  const layer = createCellsLayer(layerName, art.grid.width, art.grid.height);
  layer.grid = art.grid;
  doc.layers = [layer];
  return doc;
}

/** The rule suggested for art dropped in above other layers: whatever shows as flat black is see-through. */
export function emptyIsTransparentRule(): KeyRule {
  return { match: { appearsSolid: BLACK }, drop: "cell", enabled: true };
}

/** A flat file as a new layer for an existing document, keyed so its black areas don't cover what is below. */
export function layerFromArt(art: ImportedArt, name: string): CellsLayer {
  const layer = createCellsLayer(name, art.grid.width, art.grid.height);
  layer.grid = art.grid;
  layer.keys = [emptyIsTransparentRule()];
  return layer;
}
