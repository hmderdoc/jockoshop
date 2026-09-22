/**
 * The killerdraw project file: a ZIP with
 *   manifest.json      document settings and the layer tree (recipes, key rules)
 *   layers/<id>.bin    cell data of Cells layers
 *   layers/<id>.mask.bin    layer mask, if the layer has one
 *   layers/<id>.cache.bin   generated cells of Font/Image layers, so a file opens
 *                      without re-running the generators
 *   assets/...         embedded source images, .tdf fonts, meshes — untouched
 *   preview.ans        the flattened picture, for tools that don't know this format
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { composite } from "./composite.js";
import type { KdDocument, Layer, LayerMask } from "./document.js";
import { encodeAnsi } from "./formats/ansi.js";
import { CellGrid } from "./grid.js";

export const PROJECT_FORMAT = "killerdraw", PROJECT_VERSION = 1;

const GRID_MAGIC = "KDG1";

/** "KDG1", u32 width, u32 height, then present, glyph, fg (u32), bg (u32). Little-endian. */
export function encodeGrid(grid: CellGrid): Uint8Array {
  const n = grid.width * grid.height;
  const out = new Uint8Array(12 + n * 10);
  out.set(strToU8(GRID_MAGIC));
  const v = new DataView(out.buffer);
  v.setUint32(4, grid.width, true);
  v.setUint32(8, grid.height, true);
  out.set(grid.present, 12);
  out.set(grid.glyph, 12 + n);
  for (let i = 0; i < n; i++) {
    v.setUint32(12 + n * 2 + i * 4, grid.fg[i], true);
    v.setUint32(12 + n * 6 + i * 4, grid.bg[i], true);
  }
  return out;
}

export function decodeGrid(bytes: Uint8Array): CellGrid {
  if (strFromU8(bytes.subarray(0, 4)) !== GRID_MAGIC) throw new Error("bad layer data");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const grid = new CellGrid(v.getUint32(4, true), v.getUint32(8, true));
  const n = grid.width * grid.height;
  if (bytes.length < 12 + n * 10) throw new Error("layer data is truncated");
  grid.present.set(bytes.subarray(12, 12 + n));
  grid.glyph.set(bytes.subarray(12 + n, 12 + n * 2));
  for (let i = 0; i < n; i++) {
    grid.fg[i] = v.getUint32(12 + n * 2 + i * 4, true);
    grid.bg[i] = v.getUint32(12 + n * 6 + i * 4, true);
  }
  return grid;
}

/** "KDM1", u32 width, u32 height, then one byte per cell. */
function encodeMask(m: LayerMask): Uint8Array {
  const out = new Uint8Array(12 + m.data.length);
  out.set(strToU8("KDM1"));
  const v = new DataView(out.buffer);
  v.setUint32(4, m.width, true);
  v.setUint32(8, m.height, true);
  out.set(m.data, 12);
  return out;
}

function decodeMask(bytes: Uint8Array, enabled: boolean): LayerMask {
  if (strFromU8(bytes.subarray(0, 4)) !== "KDM1") throw new Error("bad mask data");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(4, true), height = v.getUint32(8, true);
  return { width, height, enabled, data: bytes.slice(12, 12 + width * height) };
}

type LayerJson = Record<string, unknown> & { type: string; id: string; children?: LayerJson[] };

function layerToJson(layer: Layer, files: Record<string, Uint8Array>): LayerJson {
  if (layer.type === "group") {
    return { ...layer, children: layer.children.map((c) => layerToJson(c, files)) };
  }
  // the mask's cells go in their own file; the manifest keeps only whether it is on
  const mask = layer.mask ? { mask: { enabled: layer.mask.enabled } } : {};
  if (layer.mask) files[`layers/${layer.id}.mask.bin`] = encodeMask(layer.mask);
  if (layer.type === "cells") {
    const { grid, mask: _m, ...rest } = layer;
    files[`layers/${layer.id}.bin`] = encodeGrid(grid);
    return { ...rest, ...mask };
  }
  if (layer.type === "reference") { const { mask: _m, ...rest } = layer; return { ...rest, ...mask }; }
  const { cache, mask: _m, ...rest } = layer;
  if (cache) files[`layers/${layer.id}.cache.bin`] = encodeGrid(cache);
  return { ...rest, ...mask };
}

function layerFromJson(json: LayerJson, files: Record<string, Uint8Array>): Layer {
  if (json.type === "group") {
    return { ...json, children: (json.children ?? []).map((c) => layerFromJson(c, files)) } as unknown as Layer;
  }
  const maskBytes = files[`layers/${json.id}.mask.bin`];
  const { mask: maskJson, ...plain } = json as LayerJson & { mask?: { enabled: boolean } };
  const mask = maskBytes ? { mask: decodeMask(maskBytes, maskJson?.enabled ?? true) } : {};
  if (json.type === "cells") {
    const data = files[`layers/${json.id}.bin`];
    if (!data) throw new Error(`project is missing cell data for layer ${json.id}`);
    return { ...plain, ...mask, grid: decodeGrid(data) } as unknown as Layer;
  }
  const cache = files[`layers/${json.id}.cache.bin`];
  return { ...plain, ...mask, ...(cache ? { cache: decodeGrid(cache) } : {}) } as unknown as Layer;
}

export function saveProject(doc: KdDocument): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const { layers, assets, ...settings } = doc;
  const manifest = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    document: settings,
    layers: layers.map((l) => layerToJson(l, files)),
  };
  for (const [path, bytes] of assets) {
    if (!path.startsWith("assets/")) throw new Error(`asset path must start with assets/: ${path}`);
    files[path] = bytes;
  }
  files["preview.ans"] = encodeAnsi(composite(doc).grid, {
    iceColors: doc.iceColors, palette: doc.palette, sauce: doc.sauce,
    fontName: doc.fontName, letterSpacing9px: doc.letterSpacing9px,
  });
  // manifest first, so it can be read without scanning the archive
  return zipSync({ "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), ...files }, { level: 6 });
}

export function loadProject(bytes: Uint8Array): KdDocument {
  const files = unzipSync(bytes);
  const raw = files["manifest.json"];
  if (!raw) throw new Error("not a killerdraw project: no manifest.json");
  const manifest = JSON.parse(strFromU8(raw));
  if (manifest.format !== PROJECT_FORMAT) throw new Error("not a killerdraw project");
  if (manifest.version > PROJECT_VERSION) {
    throw new Error(`project version ${manifest.version} is newer than this build understands (${PROJECT_VERSION})`);
  }
  const assets = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) if (path.startsWith("assets/")) assets.set(path, data);
  return {
    ...manifest.document,
    layers: (manifest.layers as LayerJson[]).map((l) => layerFromJson(l, files)),
    assets,
  };
}
