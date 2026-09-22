import {
  type ImageLayer, type KdDocument, SHADEANS_CELL_BYTES, addImageAsset, createImageLayer, gridFromShadeans,
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

/** Regenerate an image layer's cells from its source image and settings. */
export async function refreshImageLayer(doc: KdDocument, layer: ImageLayer): Promise<void> {
  const bytes = doc.assets.get(layer.source);
  if (!bytes) throw new Error(`image asset not in document: ${layer.source}`);
  const [x, bmp] = await Promise.all([shadeans(), bitmapOf(bytes)]);
  const crop = layer.crop ?? { x: 0, y: 0, width: bmp.width, height: bmp.height };
  const cols = Math.max(1, layer.cols);
  const rows = layer.rows > 0 ? layer.rows : Math.max(1, x.kd_rows_for_aspect(crop.width, crop.height, cols));

  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const rgba = ctx.getImageData(0, 0, crop.width, crop.height).data;

  // mean alpha under each cell, so transparent parts of the image become see-through cells
  let coverage: Uint8Array | undefined;
  let translucent = false;
  for (let i = 3; i < rgba.length; i += 4 * 97) if (rgba[i] < 255) { translucent = true; break; }
  if (translucent) {
    const small = new OffscreenCanvas(cols, rows), sctx = small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(canvas, 0, 0, cols, rows);
    const a = sctx.getImageData(0, 0, cols, rows).data;
    coverage = Uint8Array.from({ length: cols * rows }, (_, i) => a[i * 4 + 3]);
  }

  const pix = x.kd_alloc(rgba.length), opt = x.kd_alloc(13 * 4);
  let out = 0;
  try {
    new Uint8Array(x.memory.buffer, pix, rgba.length).set(rgba);
    new Float32Array(x.memory.buffer, opt, 13).set(shadeansOptionBlock(layer.options, doc.iceColors));
    out = x.kd_convert(pix, crop.width, crop.height, cols, rows, opt);
    const cells = new Uint8Array(x.memory.buffer, out, cols * rows * SHADEANS_CELL_BYTES);
    layer.cache = gridFromShadeans(cells, cols, rows, coverage);
  } finally {
    if (out) x.kd_free(out, cols * rows * SHADEANS_CELL_BYTES);
    x.kd_free(pix, rgba.length);
    x.kd_free(opt, 13 * 4);
  }
}

const jobs = new WeakMap<ImageLayer, { again: boolean }>();

/**
 * Re-convert a layer and redraw, coalescing calls: while a conversion runs,
 * further requests collapse into one more run with the latest settings, so a
 * dragged slider never queues up work.
 */
export async function scheduleImageRefresh(
  ed: { doc: KdDocument; recomposite(): void; setStatus(s: string): void }, layer: ImageLayer,
): Promise<void> {
  const job = jobs.get(layer);
  if (job) { job.again = true; return; }
  const mine = { again: true };
  jobs.set(layer, mine);
  try {
    while (mine.again) {
      mine.again = false;
      const t0 = performance.now();
      await refreshImageLayer(ed.doc, layer);
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
    await refreshImageLayer(ed.doc, layer);
    ed.addLayer(layer, "Add image layer");
  } catch (err) { ed.setStatus(`Could not add ${name}: ${(err as Error).message}`); }
}

/** The part of an image layer that a size or look change touches: one undo step covers it. */
export type ImageRecipe = Pick<ImageLayer, "cols" | "rows" | "crop" | "options">;
export function snapshotImage(layer: ImageLayer): ImageRecipe {
  return { cols: layer.cols, rows: layer.rows, crop: layer.crop && { ...layer.crop }, options: { ...layer.options } };
}
/** Record a finished change as one undo step; the layer already holds the new state. */
export function commitImage(ed: Editor, layer: ImageLayer, label: string, before: ImageRecipe, structural = false): void {
  const after = snapshotImage(layer);
  const restore = (r: ImageRecipe): void => { Object.assign(layer, { cols: r.cols, rows: r.rows, crop: r.crop && { ...r.crop }, options: { ...r.options } }); void scheduleImageRefresh(ed, layer).then(() => ed.emit("doc")); };
  ed.history.push({ label, redo: () => restore(after), undo: () => restore(before) });
  ed.emit(structural ? "doc" : "ui");
}
