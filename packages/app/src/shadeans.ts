import {
  type BitmapFont, type CellGrid, type GlyphInfo, type ImageLayer, type KdDocument, SHADEANS_CELL_BYTES,
  addImageAsset, adjustSource, applyMatte, borderColor, createImageLayer, gridFromShadeans, hasCp437Ramp, matchImageToFont,
  shadeansOptionBlock,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";

interface Exports {
  memory: WebAssembly.Memory;
  kd_alloc(len: number): number;
  kd_free(ptr: number, len: number): void;
  kd_rows_for_aspect(w: number, h: number, cols: number): number;
  kd_convert(rgba: number, w: number, h: number, cols: number, rows: number, options: number): number;
}

let loading: Promise<Exports> | undefined;

/** The shadeans matcher, compiled from the same Rust source as the CLI (scripts/build-shadeans.mjs). */
function shadeans(): Promise<Exports> {
  loading ??= (async () => {
    const res = await fetch("/shadeans.wasm");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("wasm")) {
      throw new Error("shadeans.wasm is not built — run: node scripts/build-shadeans.mjs");
    }
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
    return instance.exports as unknown as Exports;
  })();
  loading.catch(() => { loading = undefined; });
  return loading;
}

const decoded = new WeakMap<Uint8Array, Promise<ImageBitmap>>();

function bitmapOf(bytes: Uint8Array): Promise<ImageBitmap> {
  let p = decoded.get(bytes);
  if (!p) { p = createImageBitmap(new Blob([bytes as BlobPart])); decoded.set(bytes, p); }
  return p;
}

/** Pixel size of an embedded image. */
export async function imageSize(doc: KdDocument, source: string): Promise<{ width: number; height: number }> {
  const bmp = await bitmapOf(doc.assets.get(source)!);
  return { width: bmp.width, height: bmp.height };
}

/**
 * RGBA pixels -> cells through shadeans. `coverage` (0-255 per cell, or per
 * half-cell when it holds twice as many) leaves cells under transparent pixels
 * absent, or reduces them to a half block.
 */
export async function convertPixels(
  rgba: Uint8ClampedArray, width: number, height: number, cols: number, rows: number,
  options: ImageLayer["options"], iceColors: boolean, coverage?: Uint8Array, glyphs?: GlyphInfo,
): Promise<CellGrid> {
  const x = await shadeans();
  const pix = x.kd_alloc(rgba.length), opt = x.kd_alloc(13 * 4);
  let out = 0;
  try {
    new Uint8Array(x.memory.buffer, pix, rgba.length).set(rgba);
    new Float32Array(x.memory.buffer, opt, 13).set(shadeansOptionBlock(options, iceColors));
    out = x.kd_convert(pix, width, height, cols, rows, opt);
    const cells = new Uint8Array(x.memory.buffer, out, cols * rows * SHADEANS_CELL_BYTES);
    return gridFromShadeans(cells, cols, rows, coverage, 128, glyphs);
  } finally {
    if (out) x.kd_free(out, cols * rows * SHADEANS_CELL_BYTES);
    x.kd_free(pix, rgba.length);
    x.kd_free(opt, 13 * 4);
  }
}

/** Rows that keep an image's aspect at `cols` columns of 8x16 cells. */
export async function rowsForAspect(width: number, height: number, cols: number): Promise<number> {
  return Math.max(1, (await shadeans()).kd_rows_for_aspect(width, height, cols));
}

/** What the editor is drawing in, so a conversion can target the real font. */
export interface FontView { font?: BitmapFont; glyphs?: GlyphInfo }

/**
 * Which converter a font wants. shadeans spells cells with CP437's ░▒▓█ and
 * half blocks; every IBM codepage has those, and for them it is much the
 * better tool — it dithers and keeps neighbours coherent, which a plain
 * least-squares match does not. Where the font has no such ramp (Amiga, C64,
 * a font embedded in an XBIN) those codes are other characters entirely, so
 * the match reads the bitmaps instead.
 */
export function convertsWithFont(font: BitmapFont | undefined): font is BitmapFont {
  return !!font && !hasCp437Ramp(font);
}

/** Regenerate an image layer's cells from its source image and settings. */
export async function refreshImageLayer(doc: KdDocument, layer: ImageLayer, view?: FontView): Promise<void> {
  const glyphs = view?.glyphs;
  const font = view?.font;
  const bytes = doc.assets.get(layer.source);
  if (!bytes) throw new Error(`image asset not in document: ${layer.source}`);
  const bmp = await bitmapOf(bytes);
  const crop = layer.crop ?? { x: 0, y: 0, width: bmp.width, height: bmp.height };
  const cols = Math.max(1, layer.cols);
  // rowsForAspect lives in the wasm and assumes 16-row cells; any other font
  // needs the aspect worked out against its own height or the picture squashes
  const rows = layer.rows > 0 ? layer.rows
    : font && font.height !== 16 ? Math.max(1, Math.round((crop.height / crop.width) * cols * 8 / font.height))
    : await rowsForAspect(crop.width, crop.height, cols);

  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const image = ctx.getImageData(0, 0, crop.width, crop.height);
  const rgba = image.data;

  let translucent = false;
  if (layer.matte) {
    // cut the background out in pixels, before the matcher can blend it into a
    // cell; the bleed reaches about one cell, so nothing of it survives at the edge
    const bleed = Math.min(48, Math.ceil(1.5 * Math.max(crop.width / cols, crop.height / rows)));
    translucent = applyMatte(rgba, crop.width, crop.height, layer.matte, bleed) > 0;
    if (translucent) ctx.putImageData(image, 0, 0);
  }
  if (!translucent) for (let i = 3; i < rgba.length; i += 4 * 97) if (rgba[i] < 255) { translucent = true; break; }

  // mean alpha under each half of each cell, so transparent parts of the image
  // become see-through cells — or half blocks where the subject ends mid-cell
  let coverage: Uint8Array | undefined;
  if (translucent) {
    const small = new OffscreenCanvas(cols, rows * 2), sctx = small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(canvas, 0, 0, cols, rows * 2);
    const a = sctx.getImageData(0, 0, cols, rows * 2).data;
    coverage = Uint8Array.from({ length: cols * rows * 2 }, (_, i) => a[i * 4 + 3]);
  }
  if (convertsWithFont(font)) {
    // shadeans does these in the wasm before it matches; this path has to do
    // them itself or the sliders would silently stop working on these fonts
    adjustSource(rgba, crop.width, crop.height, {
      autoLevels: layer.options.autoLevels, contrast: layer.options.contrast, saturation: layer.options.saturation,
    });
    // half-cell coverage is a CP437 trick (it makes ▀▄); this match works whole cells
    const whole = coverage && Uint8Array.from({ length: cols * rows }, (_, i) => {
      const x = i % cols, y = (i - x) / cols;
      return Math.max(coverage[y * 2 * cols + x], coverage[(y * 2 + 1) * cols + x]);
    });
    layer.cache = matchImageToFont(rgba, crop.width, crop.height, cols, rows, font, doc.palette, {
      truecolor: layer.options.truecolor, iceColors: doc.iceColors, coverage: whole,
    });
    return;
  }
  layer.cache = await convertPixels(rgba, crop.width, crop.height, cols, rows, layer.options, doc.iceColors, coverage, glyphs);
}

const jobs = new WeakMap<ImageLayer, { again: boolean }>();

/**
 * Re-convert a layer and redraw, coalescing calls: while a conversion runs,
 * further requests collapse into one more run with the latest settings, so a
 * dragged slider never queues up work.
 */
export async function scheduleImageRefresh(
  ed: { doc: KdDocument } & FontView & { recomposite(): void; setStatus(s: string): void }, layer: ImageLayer,
): Promise<void> {
  const job = jobs.get(layer);
  if (job) { job.again = true; return; }
  const mine = { again: true };
  jobs.set(layer, mine);
  try {
    while (mine.again) {
      mine.again = false;
      const t0 = performance.now();
      await refreshImageLayer(ed.doc, layer, ed);
      ed.recomposite();
      ed.setStatus(`shadeans: ${layer.cache!.width}×${layer.cache!.height} cells in ${Math.round(performance.now() - t0)} ms`);
    }
  } catch (err) {
    ed.setStatus(`Image conversion failed: ${(err as Error).message}`);
  } finally {
    jobs.delete(layer);
  }
}

/** Add an image file as a live image layer, converted to the canvas width, placed at `at` (document cell) if given. */
export async function importImage(ed: Editor, name: string, bytes: Uint8Array, at?: { x: number; y: number }): Promise<void> {
  const layer = createImageLayer(name.replace(/\.[^.]+$/, ""), addImageAsset(ed.doc, name, bytes), ed.doc.width);
  if (at) { layer.x = at.x; layer.y = at.y; }
  try {
    await refreshImageLayer(ed.doc, layer, ed);
    ed.addLayer(layer, "Add image layer");
  } catch (err) { ed.setStatus(`Could not add ${name}: ${(err as Error).message}`); }
}

/**
 * The colour the source image's border is mostly made of — what a background
 * cut-out keys on unless another colour is chosen.
 */
export async function sampleBorderColor(doc: KdDocument, layer: ImageLayer): Promise<number> {
  const bmp = await bitmapOf(doc.assets.get(layer.source)!);
  const crop = layer.crop ?? { x: 0, y: 0, width: bmp.width, height: bmp.height };
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return borderColor(ctx.getImageData(0, 0, crop.width, crop.height).data, crop.width, crop.height);
}

/** The part of an image layer that a size or look change touches: one undo step covers it. */
export type ImageRecipe = Pick<ImageLayer, "cols" | "rows" | "crop" | "options" | "matte">;
export function snapshotImage(layer: ImageLayer): ImageRecipe {
  return { cols: layer.cols, rows: layer.rows, crop: layer.crop && { ...layer.crop }, options: { ...layer.options }, matte: layer.matte && { ...layer.matte } };
}
/** Record a finished change as one undo step; the layer already holds the new state. */
export function commitImage(ed: Editor, layer: ImageLayer, label: string, before: ImageRecipe, structural = false): void {
  const after = snapshotImage(layer);
  const restore = (r: ImageRecipe): void => { Object.assign(layer, { cols: r.cols, rows: r.rows, crop: r.crop && { ...r.crop }, options: { ...r.options }, matte: r.matte && { ...r.matte } }); void scheduleImageRefresh(ed, layer).then(() => ed.emit("doc")); };
  ed.history.push({ label, redo: () => restore(after), undo: () => restore(before) });
  ed.emit(structural ? "doc" : "ui");
}
