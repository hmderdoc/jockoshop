/**
 * Free transform: handles around the active layer, shared by the Move tool
 * and the shape tools. Dragging a handle scales, dragging inside moves. A
 * shape layer re-renders from its box; prose and reference frames resize; an
 * image layer re-converts; a cells layer's content — or just the selected
 * cells — is lifted, scaled nearest-neighbour and put down again, live, as
 * one undo step.
 */
import {
  CH_BG, CH_FG, CH_GLYPH, type CellGrid, type CellsLayer, type Command, type ContentLayer, type Rect, Selection, groupCommand,
  layerGrid, propertyCommand, refreshFontLayer, refreshProseLayer, refreshShapeLayer, scaleCellsNearest,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { type ImageRecipe, scheduleImageRefresh, snapshotImage } from "./shadeans.js";
import type { Pointer } from "./tools.js";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "a" | "b" | "move";

/** how close (screen pixels) the pointer has to be to a knob to grab it */
const KNOB_REACH = 9;

/**
 * Grow a cells layer to cover the canvas (a moved or imported layer), so any
 * visible cell can be drawn. Applied at once; the command undoes it. Null if
 * it already covers the canvas.
 */
export function growToCanvas(ed: Editor, layer: CellsLayer): Command | null {
  const doc = ed.doc, g = layer.grid;
  const x0 = Math.min(0, -layer.x), y0 = Math.min(0, -layer.y);
  const x1 = Math.max(g.width, doc.width - layer.x), y1 = Math.max(g.height, doc.height - layer.y);
  if (x0 >= 0 && y0 >= 0 && x1 <= g.width && y1 <= g.height) return null;
  const old = g, grown = g.reframed({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  // a mask is in layer coordinates, so it has to move with the layer's origin
  const oldMask = layer.mask, m = oldMask;
  let grownMask = oldMask;
  if (m) {
    const data = new Uint8Array(grown.width * grown.height);
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) {
        const nx = x - x0, ny = y - y0;
        if (nx >= 0 && ny >= 0 && nx < grown.width && ny < grown.height) data[ny * grown.width + nx] = m.data[y * m.width + x];
      }
    }
    grownMask = { width: grown.width, height: grown.height, data, enabled: m.enabled };
  }
  const cmd: Command = {
    label: "Grow layer",
    redo: () => { layer.grid = grown; layer.mask = grownMask; layer.x += x0; layer.y += y0; },
    undo: () => { layer.grid = old; layer.mask = oldMask; layer.x -= x0; layer.y -= y0; },
  };
  cmd.redo();
  return cmd;
}

/** The box a layer's handles frame: its frame, or for cells the content (or the selection). */
export function transformBox(ed: Editor, l: ContentLayer): Rect | null {
  if (l.type === "shape" || l.type === "prose" || l.type === "reference") return { x: l.x, y: l.y, width: l.width, height: l.height };
  if (l.type === "cells") {
    if (ed.selection) return ed.selection.bounds();
    const b = l.grid.contentBounds();
    return b && { x: b.x + l.x, y: b.y + l.y, width: b.width, height: b.height };
  }
  const g = layerGrid(l);
  return g ? { x: l.x, y: l.y, width: g.width, height: g.height } : null;
}

/** Where a line shape's ends are: from the top-left to the bottom-right, or flipped, top-right to bottom-left. */
function lineEnds(box: Rect, flip: boolean): [[number, number], [number, number]] {
  const r = box.x + box.width - 1, b = box.y + box.height - 1;
  return flip ? [[r, box.y], [box.x, b]] : [[box.x, box.y], [r, b]];
}

/** The box with one side or corner dragged to a cell; the opposite side stays, and it never shrinks below one cell. */
function resizeBox(box: Rect, id: HandleId, x: number, y: number): Rect {
  const r = box.x + box.width - 1, b = box.y + box.height - 1;
  let nx = box.x, ny = box.y, nr = r, nb = b;
  if (id.includes("w")) nx = Math.min(x, r);
  if (id.includes("e")) nr = Math.max(x, box.x);
  if (id.includes("n")) ny = Math.min(y, b);
  if (id.includes("s")) nb = Math.max(y, box.y);
  return { x: nx, y: ny, width: nr - nx + 1, height: nb - ny + 1 };
}

interface Grab {
  layer: ContentLayer;
  id: HandleId;
  start: Pointer;
  from: Rect;
  flip: boolean;
  before: Record<string, unknown>;
  image?: ImageRecipe;
  cells?: { grow: Command | null; orig: CellGrid; base: CellGrid; src: CellGrid; sel: Selection | null };
}

export class Transformer {
  private grab: Grab | null = null;

  constructor(private ed: Editor) {}

  get active(): boolean {
    return this.grab !== null;
  }

  /** the layer the handles are for, if it can be transformed */
  private target(): ContentLayer | null {
    const l = this.ed.active;
    return !l || l.type === "group" || l.locked || !l.visible ? null : l;
  }

  /** The handles to draw: the framed box, and each knob in document pixels. */
  handles(): { box: Rect; knobs: { id: HandleId; px: number; py: number }[] } | null {
    const l = this.grab?.layer ?? this.target();
    if (!l) return null;
    const box = this.grab && l.type !== "cells" ? transformBox(this.ed, l) : this.grab?.cells ? this.liveBox : transformBox(this.ed, l);
    if (!box) return null;
    const cw = this.ed.doc.letterSpacing9px ? 9 : 8, ch = this.ed.font.height;
    if (l.type === "shape" && l.kind === "line") {
      const [a, b] = lineEnds(box, l.flip);
      return { box, knobs: [{ id: "a", px: (a[0] + 0.5) * cw, py: (a[1] + 0.5) * ch }, { id: "b", px: (b[0] + 0.5) * cw, py: (b[1] + 0.5) * ch }] };
    }
    const x0 = box.x * cw, x1 = (box.x + box.width) * cw, y0 = box.y * ch, y1 = (box.y + box.height) * ch, xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    if (l.type === "font") return { box, knobs: [{ id: "e", px: x1, py: ym }] };   // live text only wraps: one width handle
    const knobs: { id: HandleId; px: number; py: number }[] = [
      { id: "nw", px: x0, py: y0 }, { id: "ne", px: x1, py: y0 }, { id: "sw", px: x0, py: y1 }, { id: "se", px: x1, py: y1 },
      { id: "n", px: xm, py: y0 }, { id: "s", px: xm, py: y1 }, { id: "w", px: x0, py: ym }, { id: "e", px: x1, py: ym },
    ];
    return { box, knobs };
  }

  /** What a press at this position grabs: a knob, the inside of the box (move), or nothing. */
  hit(p: Pointer): HandleId | null {
    const h = this.handles();
    if (!h) return null;
    const reach = KNOB_REACH / this.ed.zoom;
    for (const k of h.knobs) if (Math.abs(p.px - k.px) <= reach && Math.abs(p.py - k.py) <= reach) return k.id;
    const b = h.box, inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    if (!inside) return null;
    // a frame's border cells resize too (its edge is the natural thing to grab); a cells layer's border is content, so only its knobs scale
    const l = this.grab?.layer ?? this.target();
    if (l && l.type !== "cells" && !(l.type === "shape" && l.kind === "line")) {
      const n = p.y === b.y, s = p.y === b.y + b.height - 1, w = p.x === b.x, e = p.x === b.x + b.width - 1;
      if (l.type === "font") return e ? "e" : "move";
      const id = `${n ? "n" : s ? "s" : ""}${w ? "w" : e ? "e" : ""}`;
      if (id) return id as HandleId;
    }
    return "move";
  }

  cursor(id: HandleId | null): string | null {
    switch (id) {
      case "nw": case "se": return "nwse-resize";
      case "ne": case "sw": return "nesw-resize";
      case "n": case "s": return "ns-resize";
      case "e": case "w": return "ew-resize";
      case "a": case "b": return "crosshair";
      case "move": return "move";
      default: return null;
    }
  }

  private liveBox: Rect | null = null;

  begin(p: Pointer, id: HandleId): void {
    const l = this.target();
    const from = l && transformBox(this.ed, l);
    if (!l || !from) return;
    const grab: Grab = { layer: l, id, start: p, from, flip: l.type === "shape" && l.flip, before: {} };
    const keys = l.type === "shape" ? ["x", "y", "width", "height", "flip"] : l.type === "prose" || l.type === "reference" ? ["x", "y", "width", "height"]
      : l.type === "font" ? ["x", "y", "wrapWidth"] : ["x", "y"];
    for (const k of keys) grab.before[k] = (l as unknown as Record<string, unknown>)[k];
    if (l.type === "image") grab.image = snapshotImage(l);
    if (l.type === "cells" && !(id === "move" && !this.ed.selection)) {
      // lift the content (or the selected cells) off the layer; it is put back scaled at every drag step
      const sel = this.ed.selection;
      const grow = growToCanvas(this.ed, l);
      const orig = l.grid.clone(), base = orig.clone();
      const src = orig.reframed({ x: from.x - l.x, y: from.y - l.y, width: from.width, height: from.height });
      for (let y = 0; y < from.height; y++) {
        for (let x = 0; x < from.width; x++) {
          const dx = from.x + x, dy = from.y + y;
          if (sel && !sel.has(dx, dy)) { src.clear(x, y); continue; }
          if (base.inBounds(dx - l.x, dy - l.y)) base.clear(dx - l.x, dy - l.y);
        }
      }
      grab.cells = { grow, orig, base, src, sel };
      this.liveBox = from;
    }
    this.grab = grab;
  }

  /** The box the pointer asks for now. */
  private boxFor(p: Pointer): { box: Rect; flip: boolean } {
    const g = this.grab!, { from, id } = g;
    if (id === "move") return { box: { ...from, x: from.x + p.x - g.start.x, y: from.y + p.y - g.start.y }, flip: g.flip };
    if (id === "a" || id === "b") {
      const [a, b] = lineEnds(from, g.flip);
      const fixed = id === "a" ? b : a, x0 = Math.min(fixed[0], p.x), x1 = Math.max(fixed[0], p.x), y0 = Math.min(fixed[1], p.y), y1 = Math.max(fixed[1], p.y);
      const moving: [number, number] = [p.x, p.y], top = fixed[1] <= moving[1] ? fixed : moving, bottom = top === fixed ? moving : fixed;
      return { box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, flip: top[0] > bottom[0] };
    }
    return { box: resizeBox(from, id, p.x, p.y), flip: g.flip };
  }

  drag(p: Pointer): void {
    const g = this.grab;
    if (!g) return;
    const ed = this.ed, l = g.layer, { box, flip } = this.boxFor(p);
    if (l.type === "shape") { l.x = box.x; l.y = box.y; l.width = box.width; l.height = box.height; l.flip = flip; refreshShapeLayer(l); ed.recomposite(); }
    else if (l.type === "prose") { l.x = box.x; l.y = box.y; l.width = box.width; l.height = box.height; refreshProseLayer(ed.doc, l, ed.glyphs); ed.recomposite(); }
    else if (l.type === "reference") { l.x = box.x; l.y = box.y; l.width = box.width; l.height = box.height; ed.recomposite(); }
    else if (l.type === "font") { l.x = box.x; l.y = box.y; if (g.id !== "move") { l.wrapWidth = box.width; refreshFontLayer(ed.doc, l); } ed.recomposite(); }
    else if (l.type === "image") {
      l.x = box.x; l.y = box.y;
      if (g.id !== "move") {
        // top and bottom edges set the rows only; anything else sets the columns and lets the rows follow the picture
        if (g.id === "n" || g.id === "s") l.rows = box.height; else { l.cols = box.width; l.rows = 0; }
        void scheduleImageRefresh(ed, l);
      } else ed.recomposite();
    } else if (g.cells) {
      const { base, src } = g.cells;
      const grid = base.clone(), scaled = box.width === src.width && box.height === src.height ? src : scaleCellsNearest(src, box.width, box.height);
      for (let y = 0; y < scaled.height; y++) {
        for (let x = 0; x < scaled.width; x++) {
          const c = scaled.get(x, y);
          if (!c.present) continue;
          const tx = box.x + x - l.x, ty = box.y + y - l.y;
          if (!grid.inBounds(tx, ty)) continue;
          grid.clear(tx, ty);
          grid.set(tx, ty, { ...(c.present & CH_GLYPH ? { glyph: c.glyph } : {}), ...(c.present & CH_FG ? { fg: c.fg } : {}), ...(c.present & CH_BG ? { bg: c.bg } : {}) });
        }
      }
      (l as CellsLayer).grid = grid;
      this.liveBox = box;
      ed.recomposite();
    } else {   // a cells layer moved whole: its origin follows the box (which framed its content), and content pushed off the canvas is kept
      l.x = (g.before.x as number) + box.x - g.from.x;
      l.y = (g.before.y as number) + box.y - g.from.y;
      ed.recomposite();
    }
    ed.emit("ui");
  }

  /** Drop: everything since begin() becomes one undo step (or nothing, if nothing moved). */
  end(p: Pointer): void {
    const g = this.grab;
    if (!g) return;
    const { box } = this.boxFor(p);
    this.grab = null;
    this.liveBox = null;
    const ed = this.ed, l = g.layer, label = g.id === "move" ? (g.cells ? "Move cells" : "Move layer") : g.cells ? "Scale cells" : l.type === "shape" ? "Reshape" : "Resize layer";
    const same = box.x === g.from.x && box.y === g.from.y && box.width === g.from.width && box.height === g.from.height;
    if (g.cells) {
      const { grow, orig, sel } = g.cells;
      if (same) { (l as CellsLayer).grid = orig; grow?.undo(); ed.recomposite(); ed.emit("ui"); return; }
      const final = (l as CellsLayer).grid, cmds: Command[] = [];
      if (grow) cmds.push(grow);
      cmds.push({ label, redo: () => { (l as CellsLayer).grid = final; }, undo: () => { (l as CellsLayer).grid = orig; } });
      if (sel) {
        const moved = Selection.rect(ed.doc.width, ed.doc.height, box);
        cmds.push({ label, redo: () => ed.setSelection(moved), undo: () => ed.setSelection(sel) });
        ed.setSelection(moved);
      }
      ed.push(groupCommand(label, cmds));
      ed.recomposite();
      ed.emit("doc");
      return;
    }
    const cmds: Command[] = [];
    const target = l as unknown as Record<string, unknown>;
    for (const [k, was] of Object.entries(g.before)) if (target[k] !== was) cmds.push(propertyCommand(label, target, k, was, target[k]));
    if (g.image) {
      const after = snapshotImage(l as never), before = g.image, layer = l as never;
      const restore = (r: ImageRecipe): void => { Object.assign(layer, { cols: r.cols, rows: r.rows, crop: r.crop && { ...r.crop }, options: { ...r.options } }); void scheduleImageRefresh(ed, layer).then(() => ed.emit("doc")); };
      if (after.cols !== before.cols || after.rows !== before.rows) cmds.push({ label, redo: () => restore(after), undo: () => restore(before) });
    }
    if (!cmds.length) { ed.emit("ui"); return; }
    const refresh = (): void => {
      if (l.type === "shape") refreshShapeLayer(l); else if (l.type === "prose") refreshProseLayer(ed.doc, l, ed.glyphs); else if (l.type === "font") refreshFontLayer(ed.doc, l);
    };
    const cmd = groupCommand(label, cmds);
    ed.push({ label, redo: () => { cmd.redo(); refresh(); }, undo: () => { cmd.undo(); refresh(); } });
    ed.recomposite();
    ed.emit("doc");
  }
}
