import {
  CH_BG, CH_FG, CH_GLYPH, type CellGrid, type CellsLayer, type Color, type Command, type ContentLayer, GlyphClass,
  GridEdit, type Rect, type SelectMode, Selection, cellPatchCommand,
  type ShapeKind, type ShapeLayer, type ShapePlan, colorsEqual, cp437Encode, createProseLayer, createShapeLayer,
  groupCommand, isHigh, layerGrid, lineCells, mirrorGlyph, planShapeCells, refreshShapeLayer, selectWand,
} from "@killerdraw/core";
import type { BrushMode, Editor, ShapeFill, ToolId } from "./editor.js";
import { Transformer, growToCanvas } from "./transform.js";

export interface Pointer {
  /** document cell */
  x: number;
  y: number;
  /** document row in half-cell units (2 per cell) */
  hy: number;
  /** document pixels (unzoomed), for hitting handles */
  px: number;
  py: number;
  button: number;
  shift: boolean;
  alt: boolean;
}

export interface Tool {
  id: ToolId;
  label: string;
  key: string;
  hint: string;
  down(p: Pointer): void;
  move(p: Pointer): void;
  up(p: Pointer): void;
  /** document cells to outline while the tool is mid-gesture */
  preview?(): [number, number][];
  /** the same, in half-row units (x, hy) — a shape being drawn in half blocks */
  previewHalf?(): [number, number][];
  /** the cells (or half cells) the tool would touch at this position, when that is more than the one under the pointer */
  footprint?(p: Pointer): { cells: [number, number][]; half: boolean } | null;
  /** free-transform handles to draw: the framed box and its knobs (document pixels) */
  handles?(): { box: Rect; knobs: { px: number; py: number }[] } | null;
  keydown?(e: KeyboardEvent): boolean;
  /** document cell of a text caret, if the tool has one */
  caret?(): [number, number] | null;
  /** a selection tool: Alt means "subtract", not "pick up a cell" */
  selects?: boolean;
  dblclick?(p: Pointer): void;
  /** CSS cursor for this position, if not the default */
  cursor?(p: Pointer): string | null;
  /** an F-key glyph while typing: true if the tool put it somewhere (else it becomes the brush) */
  typeGlyph?(code: number): boolean;
}

/** Put the caret in the text layer's text field (left sidebar), at the end of the text. */
export function focusTextField(): void {
  setTimeout(() => {
    const field = document.querySelector<HTMLTextAreaElement>(".toolbox .run textarea");
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });
}

/**
 * One undoable gesture on a cells layer. Grows the layer to cover the canvas
 * first if it doesn't (a moved or imported layer), so any visible cell can be drawn.
 */
export class Stroke {
  readonly edit: GridEdit;
  private grow: Command | null = null;
  private dirty: Rect | null = null;

  private constructor(private ed: Editor, readonly layer: CellsLayer) {
    this.grow = growToCanvas(ed, layer);
    this.edit = new GridEdit(layer.grid);
  }

  static begin(ed: Editor): Stroke | null {
    const layer = ed.drawable();
    return layer ? new Stroke(ed, layer) : null;
  }

  /**
   * Visit a document cell; `fn` gets layer-local coordinates. Cells off the
   * canvas are skipped. In mirror mode the stroke is repeated across the
   * canvas centre, with glyphs that have a mirror image swapped (▌↔▐, ┌↔┐ …).
   */
  at(x: number, y: number, fn: (lx: number, ly: number) => void): void {
    this.one(x, y, fn);
    const ed = this.ed, W = ed.doc.width, H = ed.doc.height;
    if (ed.mirrorX) this.one(W - 1 - x, y, fn, "x");
    if (ed.mirrorY) this.one(x, H - 1 - y, fn, "y");
    if (ed.mirrorX && ed.mirrorY) this.one(W - 1 - x, H - 1 - y, fn, "xy");
  }

  private one(x: number, y: number, fn: (lx: number, ly: number) => void, mirrored?: "x" | "y" | "xy"): void {
    if (x < 0 || y < 0 || x >= this.ed.doc.width || y >= this.ed.doc.height) return;
    if (this.ed.selection && !this.ed.selection.has(x, y)) return;   // a selection confines every edit
    const lx = x - this.layer.x, ly = y - this.layer.y;
    fn(lx, ly);
    if (mirrored && this.layer.grid.inBounds(lx, ly)) {
      const i = this.layer.grid.index(lx, ly);
      if (this.layer.grid.present[i] & CH_GLYPH) {
        let g = this.layer.grid.glyph[i];
        if (mirrored !== "y") g = mirrorGlyph(g);
        if (mirrored !== "x") g = g === 223 ? 220 : g === 220 ? 223 : g;
        this.edit.set(lx, ly, { glyph: g });
      }
    }
    const d = this.dirty;
    if (!d) this.dirty = { x, y, width: 1, height: 1 };
    else {
      const x1 = Math.max(d.x + d.width, x + 1), y1 = Math.max(d.y + d.height, y + 1);
      d.x = Math.min(d.x, x); d.y = Math.min(d.y, y); d.width = x1 - d.x; d.height = y1 - d.y;
    }
  }

  /** Show what has been drawn since the last flush. */
  flush(): void {
    if (this.dirty) this.ed.recomposite(this.dirty);
    this.dirty = null;
  }

  end(label: string): void {
    this.flush();
    const patch = this.edit.commit();
    const commands: Command[] = [];
    if (this.grow) commands.push(this.grow);
    if (patch) commands.push(cellPatchCommand(label, this.layer.grid, patch));
    if (patch) this.ed.push(groupCommand(label, commands));
    else if (this.grow) { this.grow.undo(); this.ed.recomposite(); }
  }
}

/** The brush as the draw-channel switches leave it. */
function brushCell(ed: Editor): { glyph?: number; fg?: Color; bg?: Color } {
  return {
    ...(ed.drawGlyph ? { glyph: ed.glyph } : {}),
    ...(ed.drawFg ? { fg: ed.fg } : {}),
    ...(ed.drawBg ? { bg: ed.bg } : {}),
  };
}

/** Paint one half of a cell, keeping whatever the other half shows (or leaving it see-through). */
function paintHalf(ed: Editor, s: Stroke, lx: number, ly: number, lower: boolean, color: Color): void {
  const g = s.layer.grid;
  if (!g.inBounds(lx, ly)) return;
  const c = g.get(lx, ly);
  let up: Color = -1, lo: Color = -1;
  if (c.present & CH_GLYPH) {
    const f = c.present & CH_FG ? c.fg : -1, b = c.present & CH_BG ? c.bg : -1;
    const cls = ed.glyphs.classes[c.glyph];
    if (cls === GlyphClass.Full) up = lo = f;
    else if (cls === GlyphClass.Upper) { up = f; lo = b; }
    else if (cls === GlyphClass.Lower) { up = b; lo = f; }
    else up = lo = b;   // any other glyph: paint over its background, as Moebius does
  }
  if (lower) lo = color; else up = color;
  s.edit.clear(lx, ly);
  if (up >= 0 && lo >= 0) {
    if (colorsEqual(up, lo, ed.doc.palette)) s.edit.set(lx, ly, { glyph: 219, fg: up, bg: 0 });
    else if (!ed.doc.iceColors && isHigh(lo) && !isHigh(up)) s.edit.set(lx, ly, { glyph: 220, fg: lo, bg: up });
    else s.edit.set(lx, ly, { glyph: 223, fg: up, bg: lo });
  } else if (up >= 0) s.edit.set(lx, ly, { glyph: 223, fg: up });
  else s.edit.set(lx, ly, { glyph: 220, fg: lo });
}

const BRUSH_HINTS: Record<BrushMode, string> = {
  half: "Half-block pixels: left button paints the foreground colour, right the background. Alt-click picks up a cell.",
  char: "The brush character in the brush colours (see the char / fg / bg switches). Right button erases. Alt-click picks up a cell.",
  shade: "Shading: each stroke steps a cell up the ░ ▒ ▓ █ ramp in the brush colours; right button steps it back down.",
  colorize: "Colours only: the characters stay, the foreground and/or background (see the switches) take the brush colours.",
};
const BRUSH_LABELS: Record<BrushMode, string> = { half: "Half block", char: "Brush", shade: "Shade", colorize: "Colorize" };

/** Moebius's shade ramp: a stroke steps a cell up it (or down, with `reduce`); a full block of another colour restarts at ░. */
const SHADES = [32, 176, 177, 178, 219];
function shadeCell(ed: Editor, s: Stroke, lx: number, ly: number, reduce: boolean): void {
  const g = s.layer.grid;
  if (!g.inBounds(lx, ly)) return;
  const c = g.get(lx, ly), glyph = c.present & CH_GLYPH ? c.glyph : 32;
  const sameFg = !!(c.present & CH_FG) && c.fg === ed.fg;
  let i = SHADES.indexOf(glyph);
  if (reduce) {
    if (i <= 0 || (glyph === 219 && !sameFg)) return;
    i--;
  } else {
    if (glyph === 219) { if (sameFg) return; i = 1; }
    else i = i < 0 ? 1 : Math.min(SHADES.length - 1, i + 1);
  }
  s.edit.set(lx, ly, { glyph: SHADES[i], fg: ed.fg, bg: ed.bg });
}

/** One dab of the brush at a cell (or, in half-block mode, a half row) in the current mode. */
function paintBrush(ed: Editor, s: Stroke, x: number, y: number, p: Pointer): void {
  const mode = ed.brushMode;
  if (mode === "half") { s.at(x, y >> 1, (lx, ly) => paintHalf(ed, s, lx, ly, (y & 1) === 1, p.button === 2 ? ed.bg : ed.fg)); return; }
  s.at(x, y, (lx, ly) => {
    if (mode === "char") { if (p.button === 2) s.edit.clear(lx, ly); else s.edit.set(lx, ly, brushCell(ed)); }
    else if (mode === "shade") shadeCell(ed, s, lx, ly, p.button === 2);
    else s.edit.set(lx, ly, { ...(ed.drawFg ? { fg: ed.fg } : {}), ...(ed.drawBg ? { bg: ed.bg } : {}) });
  });
}

/** The offsets a brush of the current size covers, centred on the pointer (a size-2 brush hangs down and right, as in Moebius). */
function brushOffsets(ed: Editor): number[] {
  const n = Math.max(1, ed.brushSize), o = -Math.floor(n / 2);
  return Array.from({ length: n }, (_, i) => o + i);
}

/** The fill a shape gesture asks for: the panel's choice, or Shift for a character fill in a hollow shape. */
function shapeFillFor(ed: Editor, kind: ShapeKind, p: Pointer): ShapeFill {
  return kind === "line" ? "none" : p.shift && ed.shapeFill === "none" ? "char" : ed.shapeFill;
}

/**
 * The shape tools paint cells on a cells layer; anywhere else (a shape layer,
 * live text, an image, or after "Add layer → Shape") the drag places a live shape layer.
 */
function shapeIsVector(ed: Editor): boolean {
  return ed.pendingShape || ed.active?.type !== "cells";
}

/**
 * What a shape tool would draw between two pointer positions (see
 * planShapeCells). Painted cells in half-block style follow the pointer's
 * half rows; a shape layer's box is whole cells, so then the half rows are
 * the cells' own — the same thing the layer will render.
 */
function planShape(ed: Editor, kind: ShapeKind, a: Pointer, b: Pointer): ShapePlan {
  const half = ed.shapeStyle === "half";
  let y0 = half ? a.hy : a.y, y1 = half ? b.hy : b.y;
  if (half && shapeIsVector(ed)) { y0 = a.y * 2 + (a.y <= b.y ? 0 : 1); y1 = b.y * 2 + (b.y >= a.y ? 1 : 0); }
  return planShapeCells(kind, a.x, y0, b.x, y1, ed.shapeStyle, shapeFillFor(ed, kind, b));
}

/** A live layer for the shape dragged from `a` to `b`, styled and coloured like the brush. */
function shapeLayerFor(ed: Editor, kind: ShapeKind, a: Pointer, b: Pointer): ShapeLayer {
  const layer = createShapeLayer(kind, Math.abs(b.x - a.x) + 1, Math.abs(b.y - a.y) + 1);
  layer.x = Math.min(a.x, b.x); layer.y = Math.min(a.y, b.y);
  layer.flip = kind === "line" && (b.x - a.x) * (b.y - a.y) < 0;
  layer.style = ed.shapeStyle; layer.fill = shapeFillFor(ed, kind, b);
  layer.glyph = ed.glyph; layer.fg = ed.fg; layer.bg = ed.drawBg ? ed.bg : null;
  refreshShapeLayer(layer);
  return layer;
}

export function createTools(ed: Editor): Tool[] {
  let stroke: Stroke | null = null;
  let last: Pointer | null = null;
  let anchor: Pointer | null = null;
  let plan: ShapePlan | null = null;

  const freehand = (id: ToolId, label: string, key: string, hint: string, useHalf: boolean,
    paint: (s: Stroke, x: number, y: number, p: Pointer) => void): Tool => ({
    id, label, key, hint,
    down(p) { stroke = Stroke.begin(ed); last = p; this.move(p); },
    move(p) {
      if (!stroke || !last) return;
      const pts = useHalf ? lineCells(last.x, last.hy, p.x, p.hy) : lineCells(last.x, last.y, p.x, p.y);
      const off = brushOffsets(ed);
      for (const [x, y] of pts) for (const dy of off) for (const dx of off) paint(stroke, x + dx, y + dy, p);
      stroke.flush();
      last = p;
    },
    up() { stroke?.end(label); stroke = null; last = null; },
    footprint(p) {
      const off = brushOffsets(ed), y = useHalf ? p.hy : p.y;
      return { cells: off.flatMap((dy) => off.map((dx): [number, number] => [p.x + dx, y + dy])), half: useHalf };
    },
  });

  const xf = new Transformer(ed);
  const onShape = (): boolean => ed.active?.type === "shape";

  const shape = (id: ToolId, kind: ShapeKind, label: string, key: string, hint: string): Tool => ({
    id, label, key, hint,
    down(p) {
      // on a shape layer the handles reshape it and its inside moves it; outside it, a new shape
      const hit = onShape() ? xf.hit(p) : null;
      if (hit) { xf.begin(p, hit); return; }
      if (shapeIsVector(ed) || ed.drawable()) { anchor = p; plan = planShape(ed, kind, p, p); }
    },
    move(p) {
      if (xf.active) { xf.drag(p); return; }
      if (anchor) { plan = planShape(ed, kind, anchor, p); ed.emit("ui"); }
    },
    up(p) {
      if (xf.active) { xf.end(p); return; }
      if (!anchor) return;
      if (shapeIsVector(ed)) {
        const layer = shapeLayerFor(ed, kind, anchor, p);
        anchor = plan = null;
        ed.pendingShape = false;
        ed.addLayer(layer, `Add ${layer.name.toLowerCase()} layer`);
        ed.setStatus(`“${layer.name}” is a live shape: drag its handles to reshape it, inside to move it; the panels on the left restyle it. Rasterize it (right) for cells.`);
        return;
      }
      const s = Stroke.begin(ed), sh = planShape(ed, kind, anchor, p);
      if (s) {
        if (sh.half) {
          // half-block style: left button paints the foreground colour, right the background, as the half-block brush does
          const color = p.button === 2 ? ed.bg : ed.fg;
          for (const [x, hy] of [...sh.fill, ...sh.outline]) s.at(x, hy >> 1, (lx, ly) => paintHalf(ed, s, lx, ly, (hy & 1) === 1, color));
        } else {
          const brush = brushCell(ed);
          // a "colour" fill is a flat background: a space in the brush colours (with the character channel off, it only recolours)
          const inside = shapeFillFor(ed, kind, p) === "color" ? { ...brush, ...(ed.drawGlyph ? { glyph: 32 } : {}) } : brush;
          for (const [x, y] of sh.fill) s.at(x, y, (lx, ly) => s.edit.set(lx, ly, inside));
          for (const [x, y, g] of sh.outline) {
            const cell = g !== undefined && ed.drawGlyph ? { ...brush, glyph: g } : brush;
            s.at(x, y, (lx, ly) => s.edit.set(lx, ly, cell));
          }
        }
        s.end(label);
      }
      anchor = plan = null;
      ed.emit("ui");
    },
    preview: () => (plan && !plan.half ? [...plan.fill, ...plan.outline.map(([x, y]): [number, number] => [x, y])] : []),
    previewHalf: () => (plan?.half ? [...plan.fill, ...plan.outline.map(([x, y]): [number, number] => [x, y])] : []),
    footprint: (p) => (ed.shapeStyle === "half" && !(onShape() && xf.hit(p)) ? { cells: [[p.x, p.hy]], half: true } : null),
    handles: () => (onShape() ? xf.handles() : null),
    cursor: (p) => (onShape() ? xf.cursor(xf.hit(p)) : null),
  });

  let framing: { x: number; y: number; cur: Pointer } | null = null;   // Type tool: dragging out a new prose frame
  let selecting = false;                                                 // Type tool: dragging over prose selects text
  // text tool state
  let caret: { x: number; y: number; home: number } | null = null;

  const typeCell = (x: number, y: number, cell: { glyph: number } | null): void => {
    const s = Stroke.begin(ed);
    if (!s) return;
    s.at(x, y, (lx, ly) => {
      if (cell) s.edit.set(lx, ly, { glyph: cell.glyph, ...(ed.drawFg ? { fg: ed.fg } : {}), ...(ed.drawBg ? { bg: ed.bg } : {}) });
      else s.edit.clear(lx, ly);
    });
    s.end(cell ? "Type" : "Erase");
  };

  return [
    {
      // the Brush, as in Moebius: one tool whose mode says what it paints (half block by default)
      id: "brush", label: "Brush", key: "b",
      get hint() {
        return BRUSH_HINTS[ed.brushMode];
      },
      down(p) { stroke = Stroke.begin(ed); last = null; this.move(p); },
      move(p) {
        if (!stroke) return;
        const half = ed.brushMode === "half";
        // the first dab, then each segment without its start (already painted): shading must not step a cell twice
        const pts = !last ? [[p.x, half ? p.hy : p.y] as [number, number]]
          : (half ? lineCells(last.x, last.hy, p.x, p.hy) : lineCells(last.x, last.y, p.x, p.y)).slice(1);
        const off = brushOffsets(ed);
        for (const [x, y] of pts) for (const dy of off) for (const dx of off) paintBrush(ed, stroke, x + dx, y + dy, p);
        stroke.flush();
        last = p;
      },
      up() { stroke?.end(BRUSH_LABELS[ed.brushMode]); stroke = null; last = null; },
      footprint(p) {
        const off = brushOffsets(ed), half = ed.brushMode === "half", y = half ? p.hy : p.y;
        return { cells: off.flatMap((dy) => off.map((dx): [number, number] => [p.x + dx, y + dy])), half };
      },
    },
    freehand("eraser", "Eraser", "e", "Make cells see-through again, so the layers below show.", false,
      (s, x, y) => s.at(x, y, (lx, ly) => s.edit.clear(lx, ly))),
    shape("line", "line", "Line", "l", "Drag a line: the brush character, half-block pixels, or a box-drawing edge when it is straight."),
    shape("rect", "rect", "Rectangle", "r", "Drag corner to corner. The outline can be the brush character, half blocks or CP437 box drawing; hold Shift to fill it."),
    shape("ellipse", "ellipse", "Ellipse", "o", "Drag corner to corner: the ellipse fits the box you drag out. Hold Shift to fill it."),
    {
      id: "fill", label: "Fill", key: "f", hint: "Flood-fill connected identical cells on the active layer with the brush.",
      down(p) {
        const s = Stroke.begin(ed);
        if (!s) return;
        const g = s.layer.grid, doc = ed.doc, L = s.layer;
        const sx = p.x - L.x, sy = p.y - L.y;
        if (!g.inBounds(sx, sy)) { s.end("Fill"); return; }
        const t = g.get(sx, sy);
        const same = (i: number): boolean => g.present[i] === t.present
          && (!(t.present & CH_GLYPH) || g.glyph[i] === t.glyph) && (!(t.present & CH_FG) || g.fg[i] === t.fg)
          && (!(t.present & CH_BG) || g.bg[i] === t.bg);
        const seen = new Uint8Array(g.width * g.height), queue = [[sx, sy]], brush = brushCell(ed);
        while (queue.length) {
          const [x, y] = queue.pop()!;
          const dx = x + L.x, dy = y + L.y;
          if (!g.inBounds(x, y) || dx < 0 || dy < 0 || dx >= doc.width || dy >= doc.height) continue;
          const i = g.index(x, y);
          if (seen[i] || !same(i)) continue;
          seen[i] = 1;
          queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        seen.forEach((v, i) => { if (v) s.at(i % g.width + L.x, Math.floor(i / g.width) + L.y, (lx, ly) => s.edit.set(lx, ly, brush)); });
        s.end("Fill");
      },
      move() {}, up() {},
    },
    {
      id: "pick", label: "Pick up", key: "i", hint: "Take the character and colours of a cell as the brush (also Alt-click with any tool).",
      down(p) { pickUp(ed, p.x, p.y); }, move(p) { if (p.button >= 0) pickUp(ed, p.x, p.y); }, up() {},
    },
    {
      id: "move", label: "Move / transform", key: "v",
      hint: "Free transform (Ctrl/Cmd+T): drag the handles to scale, inside to move. A cells layer scales its content — or just the selected cells; a live layer keeps its recipe.",
      down(p) {
        const l = ed.active;
        if (!l || l.type === "group") { ed.setStatus("Select a layer to move."); return; }
        if (l.locked) { ed.setStatus(`"${l.name}" is locked.`); return; }
        if (!l.visible) { ed.setStatus(`"${l.name}" is hidden.`); return; }
        xf.begin(p, xf.hit(p) ?? "move");   // outside the handles' box, dragging still moves the layer
      },
      move(p) { xf.drag(p); },
      up(p) { xf.end(p); },
      cursor: (p) => xf.cursor(xf.hit(p)) ?? "move",
      handles: () => xf.handles(),
      // double-click a text layer to edit its text: select it, switch to Type, caret in the text field
      dblclick(p) {
        const g = ed.comp.grid;
        const owner = g.inBounds(p.x, p.y) ? ed.comp.layers[ed.comp.owner[g.index(p.x, p.y)]] : undefined;
        const active = ed.active;
        const within = active?.type === "font" && active.cache
          && p.x >= active.x && p.y >= active.y && p.x < active.x + active.cache.width && p.y < active.y + active.cache.height;
        const target = owner?.type === "font" || owner?.type === "prose" ? owner : within ? active : null;
        if (!target) return;
        if (target.id !== ed.activeId) ed.setActive(target.id);
        ed.chooseTool("text");
        if (target.type === "prose") ed.prose.begin(target, { x: p.x - target.x, y: p.y - target.y });
        else focusTextField();
      },
    },
    {
      id: "text", label: "Type", key: "t",
      hint: "Grid typewriter: click a cell and type; F1–F10 type the character set below, F11/F12 change set. Drag out a frame instead for reflowing prose.",
      typeGlyph(code) {
        if (ed.prose.layer) { ed.prose.insert(String.fromCharCode(code)); return true; }
        if (!caret) return false;
        typeCell(caret.x, caret.y, { glyph: code });
        caret.x = Math.min(ed.doc.width - 1, caret.x + 1);
        ed.emit("ui");
        return true;
      },
      down(p) {
        const l = ed.active;
        if (l?.type === "font") {   // a live TheDraw layer is edited in the sidebar, not cell by cell
          focusTextField();
          return;
        }
        if (l?.type === "prose") {   // a prose layer: the caret goes where you click; Shift extends the selection
          if (!l.locked) { ed.prose.begin(l, { x: p.x - l.x, y: p.y - l.y }, p.shift); selecting = true; }
          return;
        }
        if (ed.drawable()) { ed.prose.end(); framing = { x: p.x, y: p.y, cur: p }; caret = { x: p.x, y: p.y, home: p.x }; ed.emit("ui"); }
      },
      move(p) {
        if (framing) { framing.cur = p; ed.emit("ui"); }
        else if (selecting && ed.prose.layer) { const l = ed.prose.layer; ed.prose.dragTo({ x: p.x - l.x, y: p.y - l.y }); }
      },
      dblclick() { if (ed.prose.layer) ed.prose.selectWord(); },
      up(p) {
        selecting = false;
        if (!framing) return;
        const f = framing;
        framing = null;
        const w = Math.abs(p.x - f.x) + 1, h = Math.abs(p.y - f.y) + 1;
        if (w < 3 || h < 1 || (w === 1 && h === 1)) { ed.emit("ui"); return; }   // a click: typewriter cells
        // a drag: a prose frame of that size, ready to type into
        caret = null;
        const layer = createProseLayer("Prose", w, h);
        layer.x = Math.min(f.x, p.x); layer.y = Math.min(f.y, p.y);
        layer.fg = []; layer.bg = [];
        ed.addLayer(layer, "Add prose layer");
        ed.prose.begin(layer);
        ed.setStatus(`Prose frame ${w}×${h}: type, and it wraps — around anything already drawn inside it.`);
      },
      preview() {
        if (!framing) return [];
        const x0 = Math.min(framing.x, framing.cur.x), x1 = Math.max(framing.x, framing.cur.x), y0 = Math.min(framing.y, framing.cur.y), y1 = Math.max(framing.y, framing.cur.y);
        const out: [number, number][] = [];
        for (let x = x0; x <= x1; x++) { out.push([x, y0]); if (y1 > y0) out.push([x, y1]); }
        for (let y = y0 + 1; y < y1; y++) { out.push([x0, y]); if (x1 > x0) out.push([x1, y]); }
        return out;
      },
      caret: () => { const c = ed.prose.layer ? ed.prose.caretCell() : null; return c ? [c.x, c.y] : caret ? [caret.x, caret.y] : null; },
      keydown(e) {
        if (ed.prose.layer) return ed.prose.keydown(e);
        if (!caret) return false;
        const W = ed.doc.width, H = ed.doc.height;
        if (e.key === "Escape") caret = null;
        else if (e.key === "ArrowLeft") caret.x = Math.max(0, caret.x - 1);
        else if (e.key === "ArrowRight") caret.x = Math.min(W - 1, caret.x + 1);
        else if (e.key === "ArrowUp") caret.y = Math.max(0, caret.y - 1);
        else if (e.key === "ArrowDown") caret.y = Math.min(H - 1, caret.y + 1);
        else if (e.key === "Enter") { caret.x = caret.home; caret.y = Math.min(H - 1, caret.y + 1); }
        else if (e.key === "Backspace") { if (caret.x > 0) { caret.x--; typeCell(caret.x, caret.y, null); } }
        else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
          typeCell(caret.x, caret.y, { glyph: cp437Encode(e.key)[0] });
          caret.x = Math.min(W - 1, caret.x + 1);
        } else return false;
        ed.emit("ui");
        return true;
      },
    },
  ];
}

/** A content layer's cells laid out in document space (what the wand and copy look at). */
export function layerInDocSpace(ed: Editor, layer: ContentLayer): CellGrid | null {
  const g = layerGrid(layer);
  return g ? g.reframed({ x: -layer.x, y: -layer.y, width: ed.doc.width, height: ed.doc.height }) : null;
}

/** Shift adds, Alt subtracts, both intersect; otherwise the mode chosen in the panel. */
function modeFor(ed: Editor, p: Pointer): SelectMode {
  return p.shift && p.alt ? "intersect" : p.shift ? "add" : p.alt ? "subtract" : ed.selectMode;
}

function commitSelection(ed: Editor, made: Selection, p: Pointer): void {
  const sel = Selection.combine(ed.selection, made, modeFor(ed, p));
  ed.setSelection(sel);
  ed.setStatus(sel ? `${sel.count()} cells selected` : "Nothing selected");
}

export function createSelectTools(ed: Editor): Tool[] {
  let anchor: Pointer | null = null, current: Pointer | null = null;
  let path: [number, number][] = [];
  const rectOf = (a: Pointer, b: Pointer): Rect => ({
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1,
  });
  return [
    {
      id: "marquee", label: "Marquee", key: "m", selects: true,
      hint: "Drag a rectangular selection. Shift adds, Alt subtracts, both intersect. Click without dragging to deselect.",
      down(p) { anchor = current = p; },
      move(p) { if (anchor) { current = p; ed.emit("ui"); } },
      up(p) {
        if (!anchor) return;
        const a = anchor;
        anchor = current = null;
        if (a.x === p.x && a.y === p.y && modeFor(ed, p) === "replace") { ed.setSelection(null); ed.setStatus("Nothing selected"); return; }
        commitSelection(ed, Selection.rect(ed.doc.width, ed.doc.height, rectOf(a, p)), p);
      },
      preview() {
        if (!anchor || !current) return [];
        const r = rectOf(anchor, current), out: [number, number][] = [];
        for (let x = r.x; x < r.x + r.width; x++) { out.push([x, r.y]); if (r.height > 1) out.push([x, r.y + r.height - 1]); }
        for (let y = r.y + 1; y < r.y + r.height - 1; y++) { out.push([r.x, y]); if (r.width > 1) out.push([r.x + r.width - 1, y]); }
        return out;
      },
    },
    {
      id: "lasso", label: "Lasso", key: "q", selects: true,
      hint: "Draw around an area to select it. Shift adds, Alt subtracts, both intersect.",
      down(p) { path = [[p.x, p.y]]; },
      move(p) {
        if (!path.length) return;
        const [lx, ly] = path[path.length - 1];
        if (lx !== p.x || ly !== p.y) { path.push(...lineCells(lx, ly, p.x, p.y).slice(1)); ed.emit("ui"); }
      },
      up(p) {
        if (!path.length) return;
        const made = Selection.polygon(ed.doc.width, ed.doc.height, path);
        path = [];
        commitSelection(ed, made, p);
      },
      preview: () => path,
    },
    {
      id: "find", label: "Find & replace", key: "s",
      hint: "Find, select or replace cells by character and colours. Click a cell to search for it.",
      down(p) {
        const layer = ed.active;
        if (!layer || layer.type !== "cells") return;
        const lx = p.x - layer.x, ly = p.y - layer.y;
        if (!layer.grid.inBounds(lx, ly)) return;
        const c = layer.grid.get(lx, ly);
        ed.find.glyph = c.present & CH_GLYPH ? (c.glyph > 32 && c.glyph < 127 ? String.fromCharCode(c.glyph) : `#${c.glyph}`) : "";
        ed.find.fg = c.present & CH_FG && c.fg < 16 ? c.fg : "any";
        ed.find.bg = c.present & CH_BG && c.bg < 16 ? c.bg : "any";
        ed.emit("doc");
      },
      move() {}, up() {},
    },
    {
      id: "wand", label: "Magic wand", key: "w", selects: true,
      hint: "Click to select cells like the one clicked. The options below decide what counts as alike.",
      down(p) {
        const layer = ed.active;
        let grid: CellGrid | null;
        if (ed.wandAllLayers) grid = ed.comp.grid;
        else if (!layer || layer.type === "group") { ed.setStatus("Select a layer for the wand to look at, or turn on “all layers”."); return; }
        else grid = layerInDocSpace(ed, layer);
        if (!grid) return;
        commitSelection(ed, selectWand(grid, p.x, p.y, ed.wand, { palette: ed.doc.palette, glyphs: ed.glyphs }), p);
      },
      move() {}, up() {},
    },
  ];
}

export function pickUp(ed: Editor, x: number, y: number): void {
  const g = ed.comp.grid;
  if (!g.inBounds(x, y)) return;
  const c = g.get(x, y);
  ed.setBrush({ glyph: c.glyph, fg: c.fg, bg: c.bg });
}
