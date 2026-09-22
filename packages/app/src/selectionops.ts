import {
  CH_BG, CH_FG, CH_GLYPH, CellGrid, type ContentLayer, Selection, createCellsLayer, maskFromSelection,
  layerGrid, selectionFromMask,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { Stroke, layerInDocSpace } from "./tools.js";

/** The channels the Char / FG / BG switches currently cover (all three off means all three). */
function activeChannels(ed: Editor): number {
  const c = (ed.drawGlyph ? CH_GLYPH : 0) | (ed.drawFg ? CH_FG : 0) | (ed.drawBg ? CH_BG : 0);
  return c || CH_GLYPH | CH_FG | CH_BG;
}

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
 */
export function deleteSelection(ed: Editor): void {
  const sel = needSelection(ed);
  if (!sel) return;
  const s = Stroke.begin(ed);
  if (!s) return;
  const channels = activeChannels(ed);
  eachSelected(sel, (x, y) => s.at(x, y, (lx, ly) => s.edit.clear(lx, ly, channels)));
  s.end("Delete selection");
  ed.setStatus(channels === 7 ? `Removed ${sel.count()} cells.` : "Removed the switched-on channels from the selection.");
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
