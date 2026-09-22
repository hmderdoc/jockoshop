/**
 * Layer opacity by re-matching. A text cell cannot be half-transparent, so for
 * each translucent layer: composite the stack up to it with it opaque, and
 * without it; render both to pixels; blend the cells it owns; have shadeans
 * choose characters for the blended picture; and put those cells into the
 * composite where the layer still shows (layers above it win as usual).
 * The layer's own cells are untouched — only the flattened picture changes.
 */
import {
  type ContentLayer, type KdDocument, SHADEANS_DEFAULTS, composite, createRaster, isRgb, renderGrid, visibleLayers,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { convertPixels } from "./shadeans.js";

export function translucentLayers(doc: KdDocument): ContentLayer[] {
  return visibleLayers(doc.layers).filter((l) => l.opacity !== undefined && l.opacity < 1);
}

/** Hide everything except `keep`, run `fn`, restore. */
function withOnly(doc: KdDocument, keep: Set<ContentLayer>, fn: () => void): void {
  const all = visibleLayers(doc.layers), was = all.map((l) => l.visible);
  for (const l of all) l.visible = keep.has(l);
  try { fn(); } finally { all.forEach((l, i) => { l.visible = was[i]; }); }
}

/** Re-match the translucent layers into ed.comp.grid. Returns false when there was nothing to do. */
export async function applyOpacity(ed: Editor): Promise<boolean> {
  const doc = ed.doc, order = visibleLayers(doc.layers), targets = translucentLayers(doc);
  if (!targets.length) return false;
  const font = ed.font, W = doc.width, H = doc.height, opts = { glyphs: ed.glyphs };
  const renderOpts = { palette: doc.palette, iceColors: true };
  const full = ed.comp;
  for (const L of targets) {
    const below = new Set(order.slice(0, order.indexOf(L)));
    let under!: ReturnType<typeof composite>, over!: ReturnType<typeof composite>;
    withOnly(doc, below, () => { under = composite(doc, opts); });
    withOnly(doc, new Set([...below, L]), () => { over = composite(doc, opts); });
    const rU = createRaster(W, H, font), rO = createRaster(W, H, font);
    renderGrid(under.grid, font, rU, renderOpts);
    renderGrid(over.grid, font, rO, renderOpts);
    const a = L.opacity!, cw = rU.cellWidth, ch = rU.cellHeight;
    const mask = new Uint8Array(W * H);
    let any = false, truecolor = false;
    for (let i = 0; i < W * H; i++) {
      if (over.owner[i] !== order.indexOf(L) && !(over.layers[over.owner[i]] === L)) continue;
      mask[i] = 255; any = true;
      if (isRgb(over.grid.fg[i]) || isRgb(over.grid.bg[i]) || isRgb(under.grid.fg[i]) || isRgb(under.grid.bg[i])) truecolor = true;
    }
    if (!any) continue;
    // blend the owned cells' pixels in place, into rO
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      if (!mask[cy * W + cx]) continue;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const o = ((cy * ch + y) * rO.width + cx * cw + x) * 4;
        for (let k = 0; k < 3; k++) rO.data[o + k] = Math.round(rU.data[o + k] * (1 - a) + rO.data[o + k] * a);
      }
    }
    const matched = await convertPixels(rO.data, rO.width, rO.height, W, H, { ...SHADEANS_DEFAULTS, truecolor }, doc.iceColors);
    // into the live composite, where this layer is still what shows
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || full.layers[full.owner[i]] !== L) continue;
      full.grid.glyph[i] = matched.glyph[i]; full.grid.fg[i] = matched.fg[i]; full.grid.bg[i] = matched.bg[i];
    }
  }
  return true;
}
