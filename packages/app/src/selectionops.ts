import {
  CH_ALL, CH_BG, CH_FG, CH_GLYPH, CellGrid, type ContentLayer, type MatchContext, Selection, createCellsLayer,
  defringe, despeckle, dominantColor, maskFromSelection, layerGrid, selectionFromMask,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { Stroke, layerInDocSpace } from "./tools.js";

/** The channels the Char / FG / BG switches currently cover (all three off means all three). */
function activeChannels(ed: Editor): number {
  const c = (ed.drawGlyph ? CH_GLYPH : 0) | (ed.drawFg ? CH_FG : 0) | (ed.drawBg ? CH_BG : 0);
  return c || CH_ALL;
}

const matchContext = (ed: Editor): MatchContext => ({ palette: ed.doc.palette, glyphs: ed.glyphs });

function eachSelected(sel: Selection, fn: (x: number, y: number) => void): void {
  for (let i = 0; i < sel.mask.length; i++) if (sel.mask[i]) fn(i % sel.width, Math.floor(i / sel.width));
}

function needSelection(ed: Editor): Selection | null {
  if (!ed.selection) ed.setStatus("Select something first (Marquee, Lasso or Magic wand).");
  return ed.selection;
}

export function selectAll(ed: Editor): void { ed.setSelection(Selection.all(ed.doc.width, ed.doc.height)); }
export function selectNone(ed: Editor): void { ed.setSelection(null); }
export function selectInverse(ed: Editor): void {
  const s = ed.selection ? ed.selection.inverted() : Selection.all(ed.doc.width, ed.doc.height);
  ed.setSelection(s.count() ? s : null);
}

/** Every cell the active layer has anything in (ignores key rules and mask: it is about the layer's content). */
export function selectLayerContent(ed: Editor): void {
  const layer = ed.active;
  if (!layer || layer.type === "group") { ed.setStatus("Select a layer first."); return; }
  const g = layerInDocSpace(ed, layer);
  if (!g) return;
  const s = new Selection(ed.doc.width, ed.doc.height);
  for (let i = 0; i < s.mask.length; i++) s.mask[i] = g.present[i] ? 1 : 0;
  ed.setSelection(s.count() ? s : null);
}

/** Fill the selection with the brush, through the Char / FG / BG switches. */
export function fillSelection(ed: Editor): void {
  const sel = needSelection(ed);
  if (!sel) return;
  const s = Stroke.begin(ed);
  if (!s) return;
  const brush = {
    ...(ed.drawGlyph ? { glyph: ed.glyph } : {}), ...(ed.drawFg ? { fg: ed.fg } : {}), ...(ed.drawBg ? { bg: ed.bg } : {}),
  };
  eachSelected(sel, (x, y) => s.at(x, y, (lx, ly) => s.edit.set(lx, ly, brush)));
  s.end("Fill selection");
  ed.setStatus(`Filled ${sel.count()} cells.`);
}

/**
 * Remove the selected cells from the active layer so what is below shows. With
 * some of Char / FG / BG switched off, only the others are removed — e.g. BG
 * alone strips backgrounds and leaves the characters.
 *
 * On a live layer there are no cells to erase, so the selection becomes a hole
 * in the layer's mask instead: the image or the text is untouched and the hole
 * can be taken back from the Mask panel. That is what makes wand-then-Delete
 * work on an image without rasterizing it first.
 */
export function deleteSelection(ed: Editor): void {
  const sel = needSelection(ed);
  if (!sel) return;
  const layer = ed.active;
  if (layer && layer.type !== "group" && layer.type !== "cells") { hideSelection(ed, layer, sel); return; }
  const s = Stroke.begin(ed);
  if (!s) return;
  const channels = activeChannels(ed);
  const whole = channels === CH_ALL;
  // the colour to clean away is whatever the selection was made of — read it
  // before the delete takes it away
  const key = ed.cleanEdges && whole
    ? dominantColor(s.edit.grid, matchContext(ed), (lx, ly) => sel.has(lx + s.layer.x, ly + s.layer.y))
    : -1;
  eachSelected(sel, (x, y) => s.at(x, y, (lx, ly) => s.edit.clear(lx, ly, channels)));
  const tidied = key >= 0 ? cleanAround(ed, s, sel, key) : 0;
  s.end("Delete selection");
  ed.setStatus(!whole ? "Removed the switched-on channels from the selection."
    : tidied ? `Removed ${sel.count()} cells and cleaned ${tidied} more along the edge.`
    : `Removed ${sel.count()} cells.`);
}

/** Cut the selection out of a live layer's mask, keeping any hole already there. */
function hideSelection(ed: Editor, layer: ContentLayer, sel: Selection): void {
  const g = layerGrid(layer);
  const next = maskFromSelection(layer, g?.width ?? 0, g?.height ?? 0, sel, true);
  const old = layer.mask;
  if (old?.enabled) {   // a mask already hides part of it: keep both holes
    for (let y = 0; y < next.height; y++) {
      for (let x = 0; x < next.width; x++) {
        if (x < old.width && y < old.height && !old.data[y * old.width + x]) next.data[y * next.width + x] = 0;
      }
    }
  }
  ed.setProps("Hide selection", layer, { mask: next });
  ed.setStatus(`Hid ${sel.count()} cells behind a mask — “${layer.name}” is untouched. The Mask panel on the right takes it back.`);
}

/**
 * Take the deleted colour out of the cells just outside the selection. Those
 * are the ones that straddled the silhouette, so they still hold some of the
 * background — the halo left behind by a plain delete.
 */
function cleanAround(ed: Editor, s: Stroke, sel: Selection, key: number): number {
  const { x: ox, y: oy } = s.layer;
  const ring = (lx: number, ly: number): boolean => {
    const x = lx + ox, y = ly + oy;
    if (sel.has(x, y)) return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (sel.has(x + dx, y + dy)) return true;
    return false;
  };
  const touched: [number, number][] = [];
  const n = defringe(s.edit, key, matchContext(ed), (lx, ly) => {
    if (!ring(lx, ly)) return false;
    touched.push([lx + ox, ly + oy]);
    return true;
  });
  for (const [x, y] of touched) s.touch(x, y);
  return n;
}

/**
 * Drop cells left stranded on their own — the specks a matte or a delete
 * scatters around a subject. Confined to the selection when there is one.
 */
export function despeckleLayer(ed: Editor): void {
  const s = Stroke.begin(ed);
  if (!s) return;
  const sel = ed.selection;
  const inside = sel ? (lx: number, ly: number): boolean => sel.has(lx + s.layer.x, ly + s.layer.y) : undefined;
  const n = despeckle(s.edit, 1, inside);
  for (let y = 0; y < s.layer.grid.height; y++) for (let x = 0; x < s.layer.grid.width; x++) s.touch(x + s.layer.x, y + s.layer.y);
  s.end("Despeckle");
  ed.setStatus(n ? `Dropped ${n} stray cells.` : "No stray cells to drop.");
}

/** Copy the selection from the active layer (any kind), or from the flattened picture with `merged`. */
export function copySelection(ed: Editor, merged = false): boolean {
  const sel = needSelection(ed);
  if (!sel) return false;
  const layer = ed.active;
  let src: CellGrid | null;
  if (merged) src = ed.comp.grid;
  else if (!layer || layer.type === "group") { ed.setStatus("Select a layer to copy from."); return false; }
  else src = layerInDocSpace(ed, layer);
  const b = sel.bounds();
  if (!src || !b) return false;
  const grid = new CellGrid(b.width, b.height);
  let n = 0;
  eachSelected(sel, (x, y) => {
    const i = src!.index(x, y), p = src!.present[i];
    if (!p) return;
    const o = grid.index(x - b.x, y - b.y);
    grid.glyph[o] = src!.glyph[i]; grid.fg[o] = src!.fg[i]; grid.bg[o] = src!.bg[i]; grid.present[o] = p;
    n++;
  });
  if (!n) { ed.setStatus("Nothing to copy: the selection is empty on this layer."); return false; }
  ed.clipboard = { grid, x: b.x, y: b.y };
  ed.setStatus(`Copied ${n} cells${merged ? " (merged)" : ""}. Paste makes a new layer.`);
  return true;
}

export function cutSelection(ed: Editor): void {
  const keep = { g: ed.drawGlyph, f: ed.drawFg, b: ed.drawBg };
  if (!ed.drawable() || !copySelection(ed)) return;
  ed.drawGlyph = ed.drawFg = ed.drawBg = true;   // cut always takes the whole cell
  deleteSelection(ed);
  ed.drawGlyph = keep.g; ed.drawFg = keep.f; ed.drawBg = keep.b;
  ed.setStatus("Cut. Paste makes a new layer.");
}

/** Paste as a new layer, in place. Move it with the Move tool. */
export function paste(ed: Editor): void {
  const c = ed.clipboard;
  if (!c) { ed.setStatus("Nothing to paste."); return; }
  const layer = createCellsLayer("Pasted", c.grid.width, c.grid.height);
  layer.grid = c.grid.clone();
  layer.x = c.x; layer.y = c.y;
  ed.addLayer(layer, "Paste");
  ed.setSelection(null);
  ed.chooseTool("move");
  ed.setStatus("Pasted as a new layer — drag to place it.");
}

/** Non-destructive: hide the active layer outside the selection (or inside it, with `hide`). */
export function maskLayerFromSelection(ed: Editor, hide: boolean): void {
  const sel = needSelection(ed);
  const layer = ed.active;
  if (!sel) return;
  if (!layer || layer.type === "group") { ed.setStatus("Select a layer to mask."); return; }
  const g = layerGrid(layer);
  ed.setProps(hide ? "Mask: hide selection" : "Mask: show only selection", layer as ContentLayer,
    { mask: maskFromSelection(layer, g?.width ?? 0, g?.height ?? 0, sel, hide) });
}

export function selectFromMask(ed: Editor): void {
  const layer = ed.active;
  if (!layer || layer.type === "group" || !layer.mask) return;
  const s = selectionFromMask(layer, layer.mask, ed.doc.width, ed.doc.height);
  ed.setSelection(s.count() ? s : null);
}
