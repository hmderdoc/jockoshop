import {
  CH_BG, CH_FG, CH_GLYPH, type CellGrid, type CellsLayer, type Color, type Command, type ContentLayer, GlyphClass,
  type FontLayer, GridEdit, type ImageLayer, type ProseLayer, type Rect, type SelectMode, Selection, cellPatchCommand,
  colorsEqual, cp437Encode, createProseLayer, groupCommand, isHigh, layerGrid, refreshFontLayer, refreshProseLayer,
  selectWand,
} from "@killerdraw/core";
import type { Editor, ToolId } from "./editor.js";
import { commitImage, scheduleImageRefresh, snapshotImage } from "./shadeans.js";

export interface Pointer {
  /** document cell */
  x: number;
  y: number;
  /** document row in half-cell units (2 per cell) */
  hy: number;
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
  keydown?(e: KeyboardEvent): boolean;
  /** document cell of a text caret, if the tool has one */
  caret?(): [number, number] | null;
  /** a selection tool: Alt means "subtract", not "pick up a cell" */
  selects?: boolean;
  dblclick?(p: Pointer): void;
  /** CSS cursor for this position, if not the default */
  cursor?(p: Pointer): string | null;
}

export type Handle = "corner" | "right" | "bottom";

/**
 * Which resize handle of the active layer is under a cell, if any. Image
 * layers resize on the corner and both edges; text layers wrap on the right
 * edge; nothing else resizes.
 */
export function handleAt(ed: Editor, x: number, y: number): Handle | null {
  const l = ed.active;
  if (!l || l.type === "group" || l.type === "cells") return null;
  const g = l.cache;
  if (!g || l.locked) return null;
  const lx = x - l.x, ly = y - l.y;
  if (lx < 0 || ly < 0 || lx >= g.width || ly >= g.height) return null;
  const atRight = lx === g.width - 1, atBottom = ly === g.height - 1;
  if (l.type === "image" || l.type === "prose") return atRight && atBottom ? "corner" : atRight ? "right" : atBottom ? "bottom" : null;
  return atRight ? "right" : null;
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

/** Cells on a line between two points (Bresenham), both ends included. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
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
    const doc = ed.doc, g = layer.grid;
    const x0 = Math.min(0, -layer.x), y0 = Math.min(0, -layer.y);
    const x1 = Math.max(g.width, doc.width - layer.x), y1 = Math.max(g.height, doc.height - layer.y);
    if (x0 < 0 || y0 < 0 || x1 > g.width || y1 > g.height) {
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
      this.grow = {
        label: "Grow layer",
        redo: () => { layer.grid = grown; layer.mask = grownMask; layer.x += x0; layer.y += y0; },
        undo: () => { layer.grid = old; layer.mask = oldMask; layer.x -= x0; layer.y -= y0; },
      };
      this.grow.redo();
    }
    this.edit = new GridEdit(layer.grid);
  }

  static begin(ed: Editor): Stroke | null {
    const layer = ed.drawable();
    return layer ? new Stroke(ed, layer) : null;
  }

  /** Visit a document cell; `fn` gets layer-local coordinates. Cells off the canvas are skipped. */
  at(x: number, y: number, fn: (lx: number, ly: number) => void): void {
    if (x < 0 || y < 0 || x >= this.ed.doc.width || y >= this.ed.doc.height) return;
    if (this.ed.selection && !this.ed.selection.has(x, y)) return;   // a selection confines every edit
    fn(x - this.layer.x, y - this.layer.y);
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

export function createTools(ed: Editor): Tool[] {
  let stroke: Stroke | null = null;
  let last: Pointer | null = null;
  let anchor: Pointer | null = null;
  let current: Pointer | null = null;

  const freehand = (id: ToolId, label: string, key: string, hint: string, useHalf: boolean,
    paint: (s: Stroke, x: number, y: number, p: Pointer) => void): Tool => ({
    id, label, key, hint,
    down(p) { stroke = Stroke.begin(ed); last = p; this.move(p); },
    move(p) {
      if (!stroke || !last) return;
      const pts = useHalf ? lineCells(last.x, last.hy, p.x, p.hy) : lineCells(last.x, last.y, p.x, p.y);
      for (const [x, y] of pts) paint(stroke, x, y, p);
      stroke.flush();
      last = p;
    },
    up() { stroke?.end(label); stroke = null; last = null; },
  });

  const shape = (id: ToolId, label: string, key: string, hint: string,
    cells: (a: Pointer, b: Pointer) => [number, number][]): Tool => ({
    id, label, key, hint,
    down(p) { if (ed.drawable()) { anchor = p; current = p; } },
    move(p) { if (anchor) { current = p; ed.emit("ui"); } },
    up(p) {
      if (!anchor) return;
      const s = Stroke.begin(ed);
      if (s) {
        const brush = brushCell(ed);
        for (const [x, y] of cells(anchor, p)) s.at(x, y, (lx, ly) => s.edit.set(lx, ly, brush));
        s.end(label);
      }
      anchor = current = null;
      ed.emit("ui");
    },
    preview: () => (anchor && current ? cells(anchor, current) : []),
  });

  const rectCells = (a: Pointer, b: Pointer): [number, number][] => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const out: [number, number][] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (b.shift || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y]);
    }
    return out;
  };

  // move tool state
  let moving: { layer: { x: number; y: number }; sx: number; sy: number; ox: number; oy: number } | null = null;
  let resizing: { handle: Handle; layer: ImageLayer | FontLayer | ProseLayer; before: unknown } | null = null;
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
    freehand("pencil", "Pencil", "b", "Draw the brush character. Right button erases. Alt-click picks up a cell.", false,
      (s, x, y, p) => s.at(x, y, (lx, ly) => { if (p.button === 2) s.edit.clear(lx, ly); else s.edit.set(lx, ly, brushCell(ed)); })),
    freehand("half", "Half block", "h", "Paint half-cell pixels: left button = foreground colour, right = background colour.", true,
      (s, x, hy, p) => s.at(x, hy >> 1, (lx, ly) => paintHalf(ed, s, lx, ly, (hy & 1) === 1, p.button === 2 ? ed.bg : ed.fg))),
    freehand("eraser", "Eraser", "e", "Make cells see-through again, so the layers below show.", false,
      (s, x, y) => s.at(x, y, (lx, ly) => s.edit.clear(lx, ly))),
    shape("line", "Line", "l", "Drag a line of the brush character.", (a, b) => lineCells(a.x, a.y, b.x, b.y)),
    shape("rect", "Rectangle", "r", "Drag a rectangle. Hold Shift to fill it.", rectCells),
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
      id: "move", label: "Move layer", key: "v", hint: "Drag the active layer. Content pushed off the canvas is kept.",
      down(p) {
        const l = ed.active;
        if (!l || l.type === "group") { ed.setStatus("Select a layer to move."); return; }
        if (l.locked) { ed.setStatus(`"${l.name}" is locked.`); return; }
        const handle = handleAt(ed, p.x, p.y);
        if (handle && l.type === "image") { resizing = { handle, layer: l, before: snapshotImage(l) }; return; }
        if (handle && l.type === "font") { resizing = { handle, layer: l, before: l.wrapWidth }; return; }
        if (handle && l.type === "prose") { resizing = { handle, layer: l, before: { width: l.width, height: l.height } }; return; }
        moving = { layer: l, sx: p.x, sy: p.y, ox: l.x, oy: l.y };
      },
      move(p) {
        if (resizing) {
          const { handle, layer } = resizing;
          const w = Math.max(1, p.x - layer.x + 1), hgt = Math.max(1, p.y - layer.y + 1);
          if (layer.type === "image") {
            // corner and right edge keep the image's aspect (rows follow); bottom edge sets rows only
            if (handle === "bottom") layer.rows = hgt; else { layer.cols = w; layer.rows = 0; }
            void scheduleImageRefresh(ed, layer);
          } else if (layer.type === "prose") {
            if (handle !== "bottom") layer.width = w;
            if (handle !== "right") layer.height = hgt;
            refreshProseLayer(ed.doc, layer, ed.glyphs);
            ed.recomposite();
          } else {
            layer.wrapWidth = w;
            refreshFontLayer(ed.doc, layer);
            ed.recomposite();
          }
          ed.emit("ui");
          return;
        }
        if (!moving) return;
        moving.layer.x = moving.ox + p.x - moving.sx;
        moving.layer.y = moving.oy + p.y - moving.sy;
        ed.recomposite();
        ed.emit("ui");
      },
      up() {
        if (resizing) {
          const { layer, before } = resizing;
          resizing = null;
          if (layer.type === "image") commitImage(ed, layer, "Resize image", before as ReturnType<typeof snapshotImage>, true);
          else if (layer.type === "prose") {
            const from = before as { width: number; height: number }, to = { width: layer.width, height: layer.height };
            if (from.width !== to.width || from.height !== to.height) {
              layer.width = from.width; layer.height = from.height;
              ed.setProps("Resize text frame", layer, to, () => { refreshProseLayer(ed.doc, layer, ed.glyphs); });
            }
          } else {
            const from = before as number | undefined, to = layer.wrapWidth;
            if (from !== to) {
              layer.wrapWidth = from;
              ed.setProps("Wrap width", layer, { wrapWidth: to }, () => { refreshFontLayer(ed.doc, layer); });
            }
          }
          return;
        }
        if (!moving) return;
        const { layer, ox, oy } = moving, nx = layer.x, ny = layer.y;
        moving = null;
        if (nx === ox && ny === oy) return;
        layer.x = ox; layer.y = oy;
        ed.setProps("Move layer", layer, { x: nx, y: ny });
      },
      cursor(p) {
        const h = handleAt(ed, p.x, p.y);
        return h === "corner" ? "nwse-resize" : h === "right" ? "ew-resize" : h === "bottom" ? "ns-resize" : "move";
      },
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
      id: "text", label: "Type", key: "t", hint: "Click to place the caret, then type. Enter returns to the starting column. Esc leaves.",
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
  ed.glyph = c.glyph; ed.fg = c.fg; ed.bg = c.bg;
  ed.emit("ui");
}
