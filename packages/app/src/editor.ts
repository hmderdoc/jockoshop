import {
  type BitmapFont, type CellGrid, type CellsLayer, type Color, type Command, type Composite, type ContentLayer,
  type GlyphInfo, History, type KdDocument, type Layer, REMAP_DEFAULTS, type Rect, type RemapOptions, type SelectMode,
  type Selection, WAND_DEFAULTS,
  type WandOptions, composite, createDocument, findLayer, glyphInfoFromFont, groupCommand, propertyCommand,
  refreshProseLayer,
} from "@killerdraw/core";
import { ProseEditing } from "./prosetool.js";

export type ToolId = "pencil" | "half" | "eraser" | "line" | "rect" | "fill" | "pick" | "move" | "text"
  | "marquee" | "lasso" | "wand" | "find";

/** Tools that can act on a live layer; a cells layer takes every tool. */
const LIVE_LAYER_TOOLS: Record<"font" | "image" | "prose", readonly ToolId[]> = {
  font: ["text", "move", "marquee", "lasso", "wand"],
  image: ["move", "marquee", "lasso", "wand"],
  prose: ["text", "move", "marquee", "lasso", "wand"],
};

const TOOL_NAMES: Record<ToolId, string> = {
  pencil: "Pencil", half: "Half block", eraser: "Eraser", line: "Line", rect: "Rectangle", fill: "Fill", pick: "Pick up",
  move: "Move", text: "Type", marquee: "Marquee", lasso: "Lasso", wand: "Magic wand", find: "Find & replace",
};

type EventName = "doc" | "pixels" | "ui" | "status" | "scroll";

/** All editor state, plus the one place where the document changes and the view is told about it. */
export class Editor {
  doc: KdDocument = createDocument(80, 25);
  history = new History();
  comp!: Composite;
  glyphs: GlyphInfo;
  fileName = "untitled";
  /** where the project was opened from or last saved to (desktop only) */
  filePath: string | undefined;
  /** history position at the last save: anywhere else means unsaved changes */
  private savedAt = "0:0";

  activeId = "";
  tool: ToolId = "pencil";
  fg: Color = 7;
  bg: Color = 0;
  glyph = 219;
  /** which channels the drawing tools write; turning one off leaves it as it is (or see-through) */
  drawGlyph = true;
  drawFg = true;
  drawBg = true;
  zoom = 2;
  /** zoom follows the window: the largest zoom at which the whole width fits (up to 4×) */
  zoomFit = true;
  status = "";
  /** selected document cells; drawing and editing are confined to it while it exists */
  selection: Selection | null = null;
  /** bumped whenever the selection changes, so the view can cache its outline */
  selectionVersion = 0;
  selectMode: SelectMode = "replace";
  wand: WandOptions = { ...WAND_DEFAULTS };
  /** wand samples the flattened picture instead of the active layer */
  wandAllLayers = false;
  clipboard: { grid: CellGrid; x: number; y: number } | null = null;
  /** whether palette-swap presets and randomize also move the greys / white */
  remapOptions: RemapOptions = { ...REMAP_DEFAULTS };
  /** the Find tool's fields, kept here so they survive the sidebar being rebuilt */
  find: { glyph: string; fg: number | string; bg: number | string; rGlyph: string; rFg: number | string; rBg: number | string } =
    { glyph: "", fg: "any", bg: "any", rGlyph: "", rFg: "keep", rBg: "keep" };
  /** cells highlighted by Find */
  found: { layerId: string; indices: number[] } | null = null;

  private listeners = new Map<EventName, Set<(arg?: unknown) => void>>();

  constructor(readonly font: BitmapFont) {
    this.glyphs = glyphInfoFromFont(font);
    this.setDocument(this.doc, "untitled");
  }

  on(event: EventName, fn: (arg?: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  emit(event: EventName, arg?: unknown): void {
    this.listeners.get(event)?.forEach((fn) => fn(arg));
  }

  /** the tool an automatic switch replaced, to come back to when it applies again */
  private toolBeforeAuto: ToolId | null = null;

  /** Can this tool do anything on this layer? */
  toolApplies(tool: ToolId, layer: Layer | undefined = this.active): boolean {
    if (!layer || layer.type === "cells" || layer.type === "group") return true;
    return LIVE_LAYER_TOOLS[layer.type].includes(tool);
  }

  /** Pick a tool by hand. Refused, with the reason, if it can't act on the active layer. */
  chooseTool(tool: ToolId): boolean {
    const layer = this.active;
    if (!this.toolApplies(tool)) {
      this.setStatus(`${TOOL_NAMES[tool]} doesn't work on a live ${layer!.type === "font" ? "text" : layer!.type === "prose" ? "prose" : "image"} layer — rasterize “${layer!.name}” to edit its cells, or pick a cells layer.`);
      return false;
    }
    if (tool !== "text" && this.prose.layer) this.prose.end();
    this.tool = tool;
    this.toolBeforeAuto = null;   // a deliberate choice: nothing to come back to
    this.emit("ui");
    return true;
  }

  /** Make a layer the active one; the tool follows if it has to. */
  setActive(id: string): void {
    if (this.prose.layer && this.prose.layer.id !== id) this.prose.end();
    this.activeId = id;
    this.found = null;
    this.syncToolToLayer();
    this.emit("doc");
  }

  /**
   * After the active layer changed: a tool that can't act on it gives way to
   * the natural one (Type for text, Move for an image). Move and the select
   * tools work everywhere, so they stay. Coming back to a layer where the
   * replaced tool works restores it.
   */
  private syncToolToLayer(): void {
    const layer = this.active;
    if (!layer) return;
    if (this.toolBeforeAuto && this.toolApplies(this.toolBeforeAuto)) {
      this.tool = this.toolBeforeAuto;
      this.toolBeforeAuto = null;
      return;
    }
    if (this.toolApplies(this.tool)) return;
    this.toolBeforeAuto ??= this.tool;
    this.tool = layer.type === "font" || layer.type === "prose" ? "text" : "move";
    this.setStatus(`${TOOL_NAMES[this.tool]} tool: “${layer.name}” is a live ${layer.type === "font" ? "text" : layer.type === "prose" ? "prose" : "image"} layer.`);
  }

  setSelection(sel: Selection | null): void {
    this.selection = sel;
    this.selectionVersion++;
    this.emit("ui");
  }

  setStatus(text: string): void {
    this.status = text;
    this.emit("status");
  }

  /** Unsaved changes? True whenever the undo position differs from the one at the last save. */
  get dirty(): boolean {
    return this.history.position !== this.savedAt;
  }

  markSaved(): void {
    this.savedAt = this.history.position;
    this.emit("ui");
  }

  setDocument(doc: KdDocument, fileName: string, filePath?: string): void {
    this.doc = doc;
    this.fileName = fileName;
    this.filePath = filePath;
    this.history = new History();
    this.savedAt = "0:0";
    this.found = null;
    this.selection = null;
    this.selectionVersion++;
    this.activeId = topContentLayer(doc.layers)?.id ?? "";
    this.toolBeforeAuto = null;
    this.syncToolToLayer();
    this.recomposite();
    this.emit("doc");
  }

  get active(): Layer | undefined {
    return findLayer(this.doc.layers, this.activeId);
  }

  /** The active layer if it can be drawn on; otherwise explains why not and returns null. */
  drawable(): CellsLayer | null {
    const l = this.active;
    if (!l) { this.setStatus("No layer selected."); return null; }
    if (l.type !== "cells") { this.setStatus(`"${l.name}" is a ${l.type} layer — rasterize it to draw on it, or pick a cells layer.`); return null; }
    if (l.locked) { this.setStatus(`"${l.name}" is locked.`); return null; }
    if (!l.visible) { this.setStatus(`"${l.name}" is hidden.`); return null; }
    return l;
  }

  /** the prose layer being edited on the canvas, if any */
  prose = new ProseEditing(this);
  private reflowing = false;

  /** Prose layers that flow around other content depend on everything else: refresh them before compositing. */
  private reflowProse(): void {
    if (this.reflowing) return;
    this.reflowing = true;
    try {
      const walk = (layers: Layer[]): void => layers.forEach((l) => {
        if (l.type === "group") walk(l.children);
        else if (l.type === "prose" && l.visible && (l.flowAround || !l.cache)) refreshProseLayer(this.doc, l, this.glyphs);
      });
      walk(this.doc.layers);
    } finally { this.reflowing = false; }
  }

  /** Re-flatten. With `rect` only that part of the document is recomputed and redrawn. */
  recomposite(rect?: Rect): void {
    this.reflowProse();
    const fresh = !this.comp || this.comp.grid.width !== this.doc.width || this.comp.grid.height !== this.doc.height;
    if (this.selection && (this.selection.width !== this.doc.width || this.selection.height !== this.doc.height)) {
      this.selection = null;   // the canvas changed size under it
      this.selectionVersion++;
    }
    this.comp = composite(this.doc, { glyphs: this.glyphs }, fresh ? undefined : rect, fresh ? undefined : this.comp);
    this.emit("pixels", fresh ? undefined : rect);
  }

  /** Apply an undoable change. */
  run(command: Command, structural = true): void {
    this.history.run(command);
    this.afterChange(structural);
  }

  /** Record a change that has already been applied (a finished stroke). */
  push(command: Command): void {
    this.history.push(command);
    this.emit("ui");
  }

  undo(): void {
    const c = this.history.undo();
    if (c) { this.setStatus(`Undo: ${c.label}`); this.afterChange(true); }
  }

  redo(): void {
    const c = this.history.redo();
    if (c) { this.setStatus(`Redo: ${c.label}`); this.afterChange(true); }
  }

  private afterChange(structural: boolean): void {
    this.found = null;
    if (!findLayer(this.doc.layers, this.activeId)) this.activeId = topContentLayer(this.doc.layers)?.id ?? "";
    this.syncToolToLayer();   // adding, deleting, rasterizing or undoing can change what the active layer is
    this.recomposite();
    this.emit(structural ? "doc" : "ui");
  }

  /** Undoable change of one or more properties on the same object. */
  setProps<T extends object>(label: string, target: T, values: Partial<T>, after?: () => void): void {
    const commands: Command[] = [];
    for (const key of Object.keys(values) as (keyof T)[]) {
      commands.push(propertyCommand(label, target, key, target[key], values[key] as T[keyof T]));
    }
    const cmd = groupCommand(label, commands);
    this.run(after ? { label, redo: () => { cmd.redo(); after(); }, undo: () => { cmd.undo(); after(); } } : cmd);
  }

  /** Where `layer` sits: its sibling list and index. */
  locate(id: string, layers: Layer[] = this.doc.layers): { list: Layer[]; index: number } | null {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l.id === id) return { list: layers, index: i };
      if (l.type === "group") {
        const hit = this.locate(id, l.children);
        if (hit) return hit;
      }
    }
    return null;
  }

  addLayer(layer: Layer, label = "Add layer"): void {
    const at = this.locate(this.activeId);
    const list = at?.list ?? this.doc.layers, index = at ? at.index + 1 : this.doc.layers.length;
    const prev = this.activeId;
    this.run({
      label,
      redo: () => { list.splice(index, 0, layer); this.activeId = layer.id; },
      undo: () => { list.splice(list.indexOf(layer), 1); this.activeId = prev; },
    });
  }

  removeLayer(id: string): void {
    const at = this.locate(id);
    if (!at) return;
    const layer = at.list[at.index];
    this.run({
      label: "Delete layer",
      redo: () => { at.list.splice(at.list.indexOf(layer), 1); },
      undo: () => { at.list.splice(at.index, 0, layer); this.activeId = layer.id; },
    });
  }

  /** dir +1 = towards the top of the stack */
  moveLayer(id: string, dir: 1 | -1): void {
    const at = this.locate(id);
    if (!at) return;
    const to = at.index + dir;
    if (to < 0 || to >= at.list.length) return;
    const swap = (): void => { const a = at.list.indexOf(findLayer(this.doc.layers, id)!); const b = a === at.index ? to : at.index; [at.list[a], at.list[b]] = [at.list[b], at.list[a]]; };
    this.run({ label: "Reorder layer", redo: swap, undo: swap });
  }
}

export function topContentLayer(layers: readonly Layer[]): ContentLayer | undefined {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.type === "group") { const hit = topContentLayer(l.children); if (hit) return hit; } else return l;
  }
  return undefined;
}
