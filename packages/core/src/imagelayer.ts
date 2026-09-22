import { rgb } from "./color.js";
import { type ImageLayer, type KdDocument, type ShadeansOptions, newLayerId } from "./document.js";
import { CellGrid } from "./grid.js";

/** shadeans' own defaults. autoChroma / localContrast undefined = its default for the colour mode. */
export const SHADEANS_DEFAULTS: ShadeansOptions = {
  lambda: 0.10, blocks: false, coherence: 0.002, sweeps: 4, truecolor: false,
  autoLevels: true, equalize: 0, contrast: 1, saturation: 1, smooth: 0,
};

/** Bytes per cell in the shadeans-wasm result: ch, fg, bg, hasRgb, fg rgb, bg rgb. */
export const SHADEANS_CELL_BYTES = 10;

/** The f32 options block shadeans-wasm's kd_convert expects (see its lib.rs). */
export function shadeansOptionBlock(o: ShadeansOptions, iceColors: boolean): Float32Array {
  return Float32Array.from([
    o.lambda, iceColors ? 1 : 0, o.blocks ? 1 : 0, o.coherence, o.sweeps, o.truecolor ? 1 : 0,
    o.autoLevels ? 1 : 0, o.autoChroma ?? NaN, o.equalize, o.localContrast ?? NaN,
    o.contrast, o.saturation, o.smooth,
  ]);
}

/**
 * shadeans-wasm result -> cells. `coverage` (one 0-255 value per cell, the mean
 * alpha of the source under it) leaves cells under transparent parts of the
 * image absent, so lower layers show through.
 */
export function gridFromShadeans(bytes: Uint8Array, cols: number, rows: number, coverage?: Uint8Array, alphaThreshold = 128): CellGrid {
  const grid = new CellGrid(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    if (coverage && coverage[i] < alphaThreshold) continue;
    const c = i * SHADEANS_CELL_BYTES;
    if (bytes[c + 3]) {
      grid.setAt(i, { glyph: bytes[c], fg: rgb(bytes[c + 4], bytes[c + 5], bytes[c + 6]), bg: rgb(bytes[c + 7], bytes[c + 8], bytes[c + 9]) });
    } else grid.setAt(i, { glyph: bytes[c], fg: bytes[c + 1], bg: bytes[c + 2] });
  }
  return grid;
}

/** Embed an image file in the document and return its asset path. */
export function addImageAsset(doc: KdDocument, fileName: string, bytes: Uint8Array): string {
  const base = fileName.replace(/^.*[\\/]/, "");
  let path = `assets/images/${base}`;
  for (let n = 2; doc.assets.has(path) && doc.assets.get(path) !== bytes; n++) path = `assets/images/${n}-${base}`;
  doc.assets.set(path, bytes);
  return path;
}

export function createImageLayer(name: string, source: string, cols: number): ImageLayer {
  return {
    type: "image", id: newLayerId(), name, visible: true, locked: false, x: 0, y: 0, keys: [],
    source, cols, rows: 0, options: { ...SHADEANS_DEFAULTS },
  };
}
