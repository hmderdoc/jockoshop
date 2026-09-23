/**
 * The collapsible panels both sidebars are made of. Each builder returns the
 * panel plus, where it shows live editor state, an `update()` that refreshes it
 * in place — so panels holding text fields are never rebuilt under the cursor.
 */
import {
  type CellMatch, CellGrid, type CellsLayer, type ContentLayer, type FontLayer, type ImageLayer, type KeyRule, type ProseLayer,
  SHADEANS_DEFAULTS, type SelectMode, Selection, type ShadeansOptions, type ShapeLayer, addFontAsset, cellPatchCommand, createRaster,
  emptyIsTransparentRule, findCells, fontsOfAsset, identityRemap, isIdentityRemap, randomRemap, refreshFontLayer,
  refreshProseLayer, refreshShapeLayer, remapPresets, renderGrid, replaceCells,
} from "@killerdraw/core";
import { type BrushMode, type Editor, MAX_BRUSH_SIZE, type ShapeFill, type ShapeStyle } from "./editor.js";
import { type FontLibrary, pickFont } from "./fonts.js";
import { iconButton } from "./icons.js";
import {
  copySelection, cutSelection, deleteSelection, fillSelection, maskLayerFromSelection, paste, selectAll,
  selectFromMask, selectInverse, selectLayerContent, selectNone,
} from "./selectionops.js";
import { type ImageRecipe, commitImage, imageSize, scheduleImageRefresh, snapshotImage } from "./shadeans.js";
import type { Tool } from "./tools.js";
import { colorName, colorSelect, cssColor, field, glyphLabel, h, numberInput, parseGlyph } from "./ui.js";

export interface Panel {
  el: HTMLElement;
  /** refresh live state without rebuilding */
  update?(): void;
}

// which panels are open, remembered across rebuilds and reloads
const openState: Record<string, boolean> = (() => {
  try { return JSON.parse(localStorage.getItem("jockoshop.panels") ?? "{}") as Record<string, boolean>; } catch { return {}; }
})();

/** A collapsible panel. `tip` explains it on hover, so the panel itself can stay terse. */
export function panel(id: string, title: string, defaultOpen: boolean, tip: string, ...children: (Node | string | null | false | undefined)[]): HTMLDetailsElement {
  const el = h("details.sec", { open: openState[id] ?? defaultOpen, "data-panel": id }, h("summary", { title: tip }, title));
  for (const c of children) if (c) el.append(c);
  el.addEventListener("toggle", () => {
    openState[id] = el.open;
    try { localStorage.setItem("jockoshop.panels", JSON.stringify(openState)); } catch { /* private mode */ }
  });
  return el;
}

/**
 * A number field bound to one property of an object: the picture follows every
 * step while a spin button is held, and the whole hold is one undo step.
 * `after` runs on each live step and on undo/redo (e.g. to re-render a layer).
 */
export function liveProp<T extends object, K extends keyof T>(
  ed: Editor, target: T, key: K, label: string, value: number | undefined,
  opts: Parameters<typeof numberInput>[1], toValue: (v: number | undefined) => T[K], after?: () => void,
): HTMLElement {
  let from: T[K] | undefined, holding = false;
  const show = (v: number | undefined): void => {
    if (!holding) { holding = true; from = target[key]; }
    target[key] = toValue(v);
    after?.();
    ed.recomposite();
    ed.emit("ui");
  };
  return numberInput(value, opts, (v) => {
    const start = holding ? from! : target[key];
    holding = false;
    const end = toValue(v);
    target[key] = start;
    if (end !== start) ed.setProps(label, target, { [key]: end } as unknown as Partial<T>, after);
    else { after?.(); ed.recomposite(); }
  }, show);
}

const check = (label: string, checked: boolean, title: string, onchange: () => void, disabled = false): HTMLElement =>
  h("label.check", { title }, h("input", { type: "checkbox", checked, disabled, onchange }), label);

// ------------------------------------------------------------------ left: drawing

export function setBrushSize(ed: Editor, n: number): void {
  ed.brushSize = Math.max(1, Math.min(MAX_BRUSH_SIZE, Math.round(n)));
  ed.emit("ui");
}

export function brushPanel(ed: Editor): Panel {
  const body = h("div");
  const blinks = (bg: number): boolean => !ed.doc.iceColors && bg >= 8 && bg < 16;
  const update = (): void => {
    const sized = ed.tool === "brush" || ed.tool === "eraser";
    const modes: [BrushMode, string, string][] = [
      ["half", "half block", "Half-block pixels (H): left button paints the foreground colour, right the background. Two per cell, so a picture can be drawn at double the vertical resolution."],
      ["char", "character", "The character below, in the brush colours"],
      ["shade", "shading", "Steps cells up the ░ ▒ ▓ █ ramp; right button steps back down"],
      ["colorize", "colorize", "Recolours without changing characters: the fg / bg switches say which"],
    ];
    const modeSeg = ed.tool === "brush" && h("div.seg.cols2", {}, ...modes.map(([m, label, title]) =>
      h(`button${ed.brushMode === m ? ".active" : ""}`, { title, onclick: () => { ed.brushMode = m; ed.emit("ui"); } }, label)));
    const channels = ed.tool !== "brush" || ed.brushMode === "char" || ed.brushMode === "colorize";
    const cell = CellGrid.filled(1, 1, ed.glyph, ed.fg, ed.bg), r = createRaster(1, 1, ed.font);
    renderGrid(cell, ed.font, r, { palette: ed.doc.palette, iceColors: true });
    const sample = h("canvas.brush-sample", { width: 8, height: ed.font.height });
    sample.getContext("2d")!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, 8, ed.font.height), 0, 0);
    const toggle = (label: string, key: "drawGlyph" | "drawFg" | "drawBg", title: string): HTMLElement =>
      check(label, ed[key], title, () => ed.setDrawChannel(key, !ed[key]));
    body.replaceChildren(...[
      modeSeg,
      h("div.brush", {}, sample,
        h("div.grow", {}, h("div", {}, glyphLabel(ed.glyph)),
          h("div.muted", {}, `${colorName(ed.fg)} on ${colorName(ed.bg)}`),
          blinks(ed.bg) && h("div.warn", { title: "With iCE off, a bright background means blink in every viewer. Turn on iCE (top bar) for 16 background colours." }, "blinks (iCE off)")),
        iconButton("swap", "Swap foreground and background", { onclick: () => ed.setBrush({ fg: ed.bg, bg: ed.fg }) })),
      channels && h("div.row", { title: "What drawing, Fill and Delete act on" }, h("span.muted", {}, "affects"),
        ed.brushMode !== "colorize" && toggle("char", "drawGlyph", "Off: drawing recolours without changing characters"),
        toggle("fg", "drawFg", "Off: the foreground colour is left alone"),
        toggle("bg", "drawBg", "Off: new cells get no background, so lower layers show behind the character")),
      ...(sized ? [h("div.row", { title: "The square the brush and eraser paint — [ and ] change it" }, h("span.muted", {}, "size"),
        h("span.stepper", {},
          h("button", { title: "Smaller ([)", disabled: ed.brushSize <= 1, onclick: () => setBrushSize(ed, ed.brushSize - 1) }, "−"),
          h("span.value", {}, `${ed.brushSize}`),
          h("button", { title: "Larger (])", disabled: ed.brushSize >= MAX_BRUSH_SIZE, onclick: () => setBrushSize(ed, ed.brushSize + 1) }, "+")),
        h("span.muted", {}, ed.tool === "brush" && ed.brushMode === "half" ? (ed.brushSize === 1 ? "half block" : `${ed.brushSize}×${ed.brushSize} half blocks`) : ed.brushSize === 1 ? "cell" : `${ed.brushSize}×${ed.brushSize} cells`))] : []),
      h("div.swatches", {}, ...Array.from({ length: 16 }, (_, i) => h(
        `button.swatch${ed.fg === i ? ".is-fg" : ""}${ed.bg === i ? ".is-bg" : ""}`, {
          style: `background:${cssColor(i, ed.doc.palette)}`,
          title: `${i} ${colorName(i)} — click: foreground, right-click: background${blinks(i) ? " (blinks: iCE is off)" : ""}`,
          onclick: () => { if (ed.prose.recolor(i)) ed.fg = i; else ed.setBrush({ fg: i }); },
          oncontextmenu: (e: Event) => { e.preventDefault(); if (ed.prose.recolor(undefined, i)) ed.bg = i; else ed.setBrush({ bg: i }); },
        }))),
      ...(ed.prose.selection() ? [h("div.row", { title: "The selected text takes a swatch's colour: click for the foreground, right-click for the background" },
        h("span.muted", {}, `${ed.prose.selectedText().length} characters selected`),
        h("button", { title: "Selected text: no background, so the layer below shows through", onclick: () => ed.prose.recolor(undefined, -1) }, "see-through bg"))] : []),
    ].filter((n): n is HTMLDivElement => !!n));
  };
  update();
  return { el: panel("brush", "Brush", true, "The character and colours the drawing tools use. Alt-click the canvas to pick up a cell.", body), update };
}

/** Line, Rectangle, Ellipse: what the outline is made of, and what goes inside. */
export function shapePanel(ed: Editor, tool: Tool): Panel {
  const body = h("div");
  const update = (): void => {
    const styles: [ShapeStyle, string, string][] = [
      ["char", "character", "The brush character, in the brush colours"],
      ["half", "half block", "Half-block pixels, like the half-block brush: left button paints the foreground colour, right the background"],
      ["single", "single line", tool.id === "ellipse" ? "Box drawing has no curves: an ellipse uses the brush character" : "CP437 box drawing: ┌─┐ │ └─┘ (a diagonal line keeps the brush character)"],
      ["double", "double line", tool.id === "ellipse" ? "Box drawing has no curves: an ellipse uses the brush character" : "CP437 box drawing: ╔═╗ ║ ╚═╝ (a diagonal line keeps the brush character)"],
    ];
    const fills: [ShapeFill, string, string][] = [
      ["none", "hollow", "Only the outline (Shift while dragging fills with the character)"],
      ["color", "colour", "A flat background colour inside: spaces in the brush colours"],
      ["char", "character", "The brush character inside as well"],
    ];
    const seg = <T extends string>(cls: string, items: [T, string, string][], cur: T, set: (v: T) => void, dim: (v: T) => boolean = () => false): HTMLElement =>
      h(`div.seg.${cls}`, {}, ...items.map(([v, label, title]) => h(`button${cur === v ? ".active" : ""}${dim(v) ? ".dim" : ""}`, { title, onclick: () => set(v) }, label)));
    const rows = [
      h("div.muted", {}, "outline"),
      seg("cols2", styles, ed.shapeStyle, (v) => ed.setShapeOptions({ style: v }), (v) => tool.id === "ellipse" && (v === "single" || v === "double")),
    ];
    if (tool.id !== "line") rows.push(h("div.muted", {}, "inside"), seg("cols3", fills, ed.shapeFill, (v) => ed.setShapeOptions({ fill: v })));
    const shapeLayer = ed.active?.type === "shape";
    rows.push(h("p.hint", {}, shapeLayer
      ? "Restyling the selected shape. Drag its handles to reshape it, inside to move it; drag outside it for another shape."
      : ed.active?.type === "cells" ? "On a cells layer the shape is painted as cells. On any other layer (or after Add layer → Shape) it becomes a live shape layer."
        : "The drag becomes a live shape layer: reshape and restyle it any time; rasterize it for cells."));
    body.replaceChildren(...rows);
  };
  update();
  return { el: panel("shape", tool.label, true, tool.hint, body), update };
}

export function characterPanel(ed: Editor): Panel {
  const picker = h("canvas.glyph-picker", { width: 16 * 8, height: 16 * 16 });
  const all = new CellGrid(16, 16);
  for (let i = 0; i < 256; i++) all.setAt(i, { glyph: i, fg: 15, bg: 0 });
  const raster = createRaster(16, 16, ed.font);
  renderGrid(all, ed.font, raster, { iceColors: true });
  const image = new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height);
  picker.addEventListener("click", (e) => {
    const r = picker.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * 16), y = Math.floor(((e.clientY - r.top) / r.height) * 16);
    ed.setBrush({ glyph: Math.max(0, Math.min(255, y * 16 + x)) });
  });
  const update = (): void => {
    const ctx = picker.getContext("2d")!;
    ctx.putImageData(image, 0, 0);
    ctx.strokeStyle = "#ff50dc";
    ctx.strokeRect((ed.glyph % 16) * 8 + 0.5, Math.floor(ed.glyph / 16) * 16 + 0.5, 7, 15);
  };
  update();
  return { el: panel("character", "Character", true, "All 256 CP437 characters. F1–F10 pick from the active F-key set (F11/F12 change set; the set shows in the footer while typing).", picker), update };
}

// ------------------------------------------------------------------ left: selecting

export function selectOptionsPanel(ed: Editor, tool: Tool): Panel {
  const body = h("div");
  const update = (): void => {
    const modes: [SelectMode, string, string][] = [["replace", "new", "Replace the selection"], ["add", "add", "Add to it (or hold Shift)"],
      ["subtract", "subtract", "Take away from it (or hold Alt)"], ["intersect", "overlap", "Keep only the overlap (Shift+Alt)"]];
    const rows: HTMLElement[] = [h("div.seg", {}, ...modes.map(([m, label, title]) =>
      h(`button${ed.selectMode === m ? ".active" : ""}`, { title, onclick: () => { ed.selectMode = m; ed.emit("ui"); } }, label)))];
    if (tool.id === "wand") {
      const w = (label: string, key: keyof typeof ed.wand, title: string): HTMLElement =>
        check(label, ed.wand[key], title, () => { ed.wand[key] = !ed.wand[key]; ed.emit("ui"); });
      rows.push(
        h("div.row", {}, h("span.muted", {}, "alike in"), w("char", "glyph", "The character must be the same"), w("fg", "fg", "The foreground must be the same"), w("bg", "bg", "The background must be the same")),
        h("div.row.wrap", {},
          w("by look", "byLook", "Match what cells look like: every spelling of a flat colour (space on black, black █, black-on-black text) counts as the same"),
          w("connected", "contiguous", "Only cells touching the one you click; off = everywhere on the canvas"),
          w("diagonals", "diagonals", "Corner-touching cells count as connected")),
        h("div.row", {}, check("look at all layers", ed.wandAllLayers, "Sample the flattened picture instead of only the active layer", () => { ed.wandAllLayers = !ed.wandAllLayers; ed.emit("ui"); })));
    }
    body.replaceChildren(...rows);
  };
  update();
  return { el: panel("selectTool", tool.label, true, tool.hint, body), update };
}

export function selectionPanel(ed: Editor): Panel {
  const body = h("div");
  const update = (): void => {
    const n = ed.selection?.count() ?? 0;
    const b = (label: string, title: string, fn: () => void, enabled = true): HTMLElement => h("button", { title, disabled: !enabled, onclick: fn }, label);
    body.replaceChildren(
      h("p.hint", {}, n ? `${n} cells selected — drawing is confined to them.` : "Nothing selected."),
      h("div.grid4", {},
        b("all", "Select the whole canvas (Ctrl/Cmd+A)", () => selectAll(ed)),
        b("none", "Deselect (Ctrl/Cmd+D or Esc)", () => selectNone(ed), n > 0),
        b("invert", "Select everything else (Ctrl/Cmd+Shift+I)", () => selectInverse(ed)),
        b("layer", "Select every cell the active layer has something in", () => selectLayerContent(ed))),
      h("div.grid4", {},
        b("fill", "Fill with the brush, through the char / fg / bg switches", () => fillSelection(ed), n > 0),
        b("delete", "Make the selection see-through on this layer (Delete). With some of char / fg / bg off, only the others are removed", () => deleteSelection(ed), n > 0),
        b("copy", "Ctrl/Cmd+C — with Shift, the flattened picture", () => void copySelection(ed), n > 0),
        b("cut", "Ctrl/Cmd+X", () => cutSelection(ed), n > 0)),
      h("div.grid4", {}, b("paste", "Paste as a new layer (Ctrl/Cmd+V)", () => paste(ed), !!ed.clipboard)),
      h("div.replace-with", { title: "A mask hides part of the layer without erasing it; manage it under the layer's Mask panel" }, "mask the layer"),
      h("div.grid2", {},
        b("show only this", "Show the active layer only inside the selection", () => maskLayerFromSelection(ed, false), n > 0),
        b("hide this", "Hide the active layer inside the selection", () => maskLayerFromSelection(ed, true), n > 0)));
  };
  update();
  return { el: panel("selection", "Selection", true, "What to do with the selected cells, on the active layer.", body), update };
}

// ------------------------------------------------------------------ left: move

export function positionPanel(ed: Editor, layer: ContentLayer): Panel {
  const body = h("div");
  const update = (): void => body.replaceChildren(h("div.row", {},
    field("x", liveProp(ed, layer, "x", "Move layer", layer.x, {}, (v) => v ?? 0)),
    field("y", liveProp(ed, layer, "y", "Move layer", layer.y, {}, (v) => v ?? 0)),
    h("button", { title: "Back to the top-left corner", onclick: () => ed.setProps("Move layer", layer, { x: 0, y: 0 } as Partial<ContentLayer>) }, "0,0")));
  update();
  return { el: panel("position", `Position — ${layer.name}`, true, "Drag on the canvas, or type a position. Content pushed off the canvas is kept.", body), update };
}

// ------------------------------------------------------------------ left: type on a text layer

export function fontPanel(ed: Editor, lib: FontLibrary, layer: FontLayer): Panel {
  type Recipe = Pick<FontLayer, "runs" | "wrapWidth" | "spacing" | "lineGap" | "spaceWidth" | "fg" | "bg">;
  const snapshot = (): Recipe => structuredClone({
    runs: layer.runs, wrapWidth: layer.wrapWidth, spacing: layer.spacing, lineGap: layer.lineGap,
    spaceWidth: layer.spaceWidth, fg: layer.fg, bg: layer.bg,
  });
  const restore = (r: Recipe): void => { Object.assign(layer, structuredClone(r)); refreshFontLayer(ed.doc, layer); };
  const commit = (label: string, before: Recipe, structural = true): void => {
    const after = snapshot();
    ed.history.push({ label, redo: () => restore(after), undo: () => restore(before) });
    ed.recomposite();
    ed.emit(structural ? "doc" : "ui");
  };
  const change = (label: string, mutate: () => void): void => {
    const before = snapshot();
    mutate();
    refreshFontLayer(ed.doc, layer);
    commit(label, before);
  };
  /** follows the spinner live; one undo step when released */
  const liveNumber = (value: number | undefined, opts: Parameters<typeof numberInput>[1], label: string, apply: (v: number | undefined) => void): HTMLElement => {
    let from: Recipe | null = null;
    const show = (v: number | undefined): void => { from ??= snapshot(); apply(v); refreshFontLayer(ed.doc, layer); ed.recomposite(); };
    return numberInput(value, opts, (v) => { show(v); commit(label, from!, false); from = null; }, show);
  };

  const runs = layer.runs.map((run, i) => {
    let typingFrom: Recipe | null = null;
    const fontName = (): string => { try { return fontsOfAsset(ed.doc, run.font)[run.fontIndex]?.name || run.font; } catch { return run.font; } };
    const text = h("textarea", {
      rows: 2, value: run.text, spellcheck: false,
      oninput: () => {   // live: re-render on every keystroke, one undo step when the field is left
        typingFrom ??= snapshot();
        run.text = text.value;
        refreshFontLayer(ed.doc, layer);
        ed.recomposite();
      },
      onchange: () => { if (typingFrom) { commit("Edit text", typingFrom, false); typingFrom = null; } },
    });
    return h("div.run", {},
      h("div.row", {},
        h("button.grow.font-name", {
          title: "Choose this run's TheDraw font", onclick: async () => {
            const pick = await pickFont(ed, lib, run.text.split("\n")[0]);
            if (pick) change("Change font", () => { run.font = addFontAsset(ed.doc, pick.entry.file, pick.bytes); run.fontIndex = pick.entry.index; });
          },
        }, fontName()),
        layer.runs.length > 1 && h("button.icon", { title: "Remove this run", onclick: () => change("Remove run", () => { layer.runs.splice(i, 1); }) }, "×")),
      text);
  });

  const el = panel("font", "Text", true, "Live TheDraw text: edit it any time. Each run has its own font, so adding a run switches fonts mid-string.",
    ...runs,
    h("div.row", {}, h("button", {
      title: "Continue the text in another font",
      onclick: () => change("Add run", () => { const last = layer.runs[layer.runs.length - 1]; layer.runs.push({ font: last.font, fontIndex: last.fontIndex, text: "" }); }),
    }, "+ font switch")),
    h("div.row", {},
      field("spacing", liveNumber(layer.spacing, { min: -4, max: 20, width: 48 }, "Letter spacing", (v) => { layer.spacing = v ?? 0; })),
      field("line gap", liveNumber(layer.lineGap, { min: 0, max: 20, width: 48 }, "Line gap", (v) => { layer.lineGap = v ?? 0; })),
      field("space", liveNumber(layer.spaceWidth, { min: 1, max: 20, width: 48 }, "Space width", (v) => { layer.spaceWidth = v ?? 1; })),
      field("wrap", liveNumber(layer.wrapWidth, { min: 1, max: 999, placeholder: "off", width: 52 }, "Wrap width", (v) => { layer.wrapWidth = v; }))),
    h("div.row", {},
      field("behind letters", colorSelect(layer.bg ?? "none", [["none", "see-through"]], (v) => change("Font background", () => { layer.bg = typeof v === "number" ? v : null; }))),
      field("ink", colorSelect(layer.fg, [], (v) => change("Font colour", () => { layer.fg = v as number; })))),
    h("p.hint", {}, "Ink is for outline and block fonts. Colour fonts keep their own colours — recolour them with the layer's Palette swap."));
  return { el };
}

// ------------------------------------------------------------------ left: type in a prose layer

export function prosePanel(ed: Editor, layer: ProseLayer): Panel {
  const body = h("div");
  const refresh = (): void => { refreshProseLayer(ed.doc, layer, ed.glyphs); };
  const set = <K extends keyof ProseLayer>(label: string, key: K, value: ProseLayer[K]): void =>
    ed.setProps(label, layer, { [key]: value } as Partial<ProseLayer>, refresh);
  const update = (): void => {
    const editing = ed.prose.layer === layer;
    const overflow = layer.cache ? 0 : 0;
    body.replaceChildren(
      h("p.hint", {}, editing
        ? "Type on the canvas. Arrows, Home/End, Enter, Backspace, Delete and paste work as in a word processor; Esc stops."
        : "Click inside the frame on the canvas to place the caret and type."),
      h("div.row", {},
        field("width", liveProp(ed, layer, "width", "Text frame", layer.width, { min: 1, max: 999, width: 52 }, (v) => v ?? layer.width, refresh)),
        field("height", liveProp(ed, layer, "height", "Text frame", layer.height, { min: 1, max: 9999, width: 52 }, (v) => v ?? layer.height, refresh)),
        field("align", (() => { const sel = h("select", { onchange: () => set("Align text", "align", sel.value as ProseLayer["align"]) },
          h("option", { value: "left" }, "left"), h("option", { value: "center" }, "centre"), h("option", { value: "right" }, "right")); sel.value = layer.align; return sel; })())),
      h("div.row.wrap", {},
        check("flow around other layers", layer.flowAround, "Cells that other layers draw on inside the frame are obstacles the text wraps around", () => set(layer.flowAround ? "Flow around off" : "Flow around on", "flowAround", !layer.flowAround)),
        layer.flowAround && field("skip gaps under", liveProp(ed, layer, "minGap", "Minimum gap", layer.minGap, { min: 1, max: 40, width: 46 }, (v) => v ?? 1, refresh))),
      h("p.hint", {}, `${layer.text.length} characters${overflow ? `, ${overflow} don't fit` : ""}. New text takes the brush foreground, and its background when “bg” is on. With Move (V), drag the frame's edges to resize it.`));
  };
  update();
  ed.on("ui", update);
  return { el: panel("prose", "Prose", true, "Reflowing text in a frame — a word processor's text, not stamped characters. Edit it on the canvas at any time.", body), update };
}

// ------------------------------------------------------------------ left: find

/** Inputs for a character + foreground + background pattern; "any" leaves a field out. */
function matchForm(ed: Editor, state: { glyph: string; fg: number | string; bg: number | string }): { el: HTMLElement; read: () => CellMatch | null } {
  const glyph = h("input", {
    type: "text", placeholder: "any", value: state.glyph, style: "width:52px", title: "A character, or a CP437 code like 219",
    oninput: () => { state.glyph = glyph.value; },
  });
  const fgSel = colorSelect(state.fg, [["any", "any"]], (v) => { state.fg = v; });
  const bgSel = colorSelect(state.bg, [["any", "any"]], (v) => { state.bg = v; });
  const fromBrush = iconButton("pick", "Use the current brush", {
    onclick: () => {
      state.glyph = glyph.value = ed.glyph > 32 && ed.glyph < 127 ? String.fromCharCode(ed.glyph) : `#${ed.glyph}`;
      state.fg = ed.fg; state.bg = ed.bg;
      fgSel.value = String(ed.fg); bgSel.value = String(ed.bg);
    },
  });
  return {
    el: h("div.row", {}, field("char", glyph), field("fg", fgSel), field("bg", bgSel), fromBrush),
    read: () => {
      const m: CellMatch = {};
      if (state.glyph !== "") {
        const g = parseGlyph(state.glyph);
        if (g === null) { ed.setStatus(`"${state.glyph}" is not a character or a code 0–255.`); return null; }
        m.glyph = { oneOf: [g] };
      }
      if (typeof state.fg === "number") m.fg = { oneOf: [state.fg] };
      if (typeof state.bg === "number") m.bg = { oneOf: [state.bg] };
      return m;
    },
  };
}

export function findPanel(ed: Editor, layer: CellsLayer): Panel {
  const s = ed.find;
  const find = matchForm(ed, s);
  const rGlyph = h("input", { type: "text", placeholder: "keep", value: s.rGlyph, style: "width:52px", oninput: () => { s.rGlyph = rGlyph.value; } });
  const ctx = (): { palette: typeof ed.doc.palette; glyphs: typeof ed.glyphs } => ({ palette: ed.doc.palette, glyphs: ed.glyphs });
  const result = h("span.muted");
  const el = panel("find", "Find & replace", true, "By character and colours, on the active layer. Click a cell on the canvas to search for it.",
    find.el,
    h("div.row", {}, h("button", {
      title: "Outline the matches on the canvas",
      onclick: () => {
        const m = find.read();
        if (!m) return;
        const indices = findCells(layer.grid, m, ctx());
        ed.found = { layerId: layer.id, indices };
        result.textContent = `${indices.length} found`;
        ed.emit("ui");
      },
    }, "Find"), h("button", {
      title: "Turn the matches into the selection",
      onclick: () => {
        const m = find.read();
        if (!m) return;
        const g = layer.grid, sel = new Selection(ed.doc.width, ed.doc.height);
        for (const i of findCells(g, m, ctx())) { const x = (i % g.width) + layer.x, y = Math.floor(i / g.width) + layer.y; if (x >= 0 && y >= 0 && x < sel.width && y < sel.height) sel.mask[y * sel.width + x] = 1; }
        ed.setSelection(sel.count() ? sel : null);
        result.textContent = `${sel.count()} selected`;
      },
    }, "Select"), result),
    h("div.replace-with", {}, "replace with"),
    h("div.row", {}, field("char", rGlyph), field("fg", colorSelect(s.rFg, [["keep", "keep"]], (v) => { s.rFg = v; })),
      field("bg", colorSelect(s.rBg, [["keep", "keep"]], (v) => { s.rBg = v; }))),
    h("div.row", {}, h("button", {
      onclick: () => {
        const m = find.read();
        if (!m) return;
        const g = s.rGlyph === "" ? undefined : parseGlyph(s.rGlyph);
        if (g === null) { ed.setStatus(`"${s.rGlyph}" is not a character or a code 0–255.`); return; }
        const repl = { ...(g !== undefined ? { glyph: g } : {}), ...(typeof s.rFg === "number" ? { fg: s.rFg } : {}), ...(typeof s.rBg === "number" ? { bg: s.rBg } : {}) };
        if (!Object.keys(repl).length) { ed.setStatus("Choose what to replace with."); return; }
        const patch = replaceCells(layer.grid, m, repl, ctx());
        if (!patch) { ed.setStatus("Nothing to replace."); return; }
        ed.history.push(cellPatchCommand("Replace", layer.grid, patch));
        ed.found = null;
        ed.recomposite();
        ed.emit("ui");
        ed.setStatus(`Replaced ${patch.indices.length} cells.`);
      },
    }, "Replace all")));
  return { el };
}

// ------------------------------------------------------------------ right: layer properties

function describeMatch(m: CellMatch): string {
  const parts: string[] = [];
  const set = <T>(s: { oneOf: readonly T[] } | { not: readonly T[] }, name: (v: T) => string): string =>
    "oneOf" in s ? s.oneOf.map(name).join(" / ") : `not ${s.not.map(name).join(" / ")}`;
  if (m.appearsSolid !== undefined) parts.push(`looks solid ${colorName(m.appearsSolid)}`);
  if (m.glyph) parts.push(`char ${set(m.glyph, glyphLabel)}`);
  if (m.fg) parts.push(`fg ${set(m.fg, colorName)}`);
  if (m.bg) parts.push(`bg ${set(m.bg, colorName)}`);
  return parts.join(", ") || "every cell";
}

export function keyRulesPanel(ed: Editor, layer: ContentLayer): Panel {
  const setKeys = (keys: KeyRule[], label: string): void => ed.setProps(label, layer, { keys } as Partial<ContentLayer>);
  const rows = layer.keys.map((k, i) => h("div.rule", {},
    h("input", {
      type: "checkbox", checked: k.enabled, title: "Rule on/off — the cells are never deleted",
      onchange: () => setKeys(layer.keys.map((r, j) => (j === i ? { ...r, enabled: !r.enabled } : r)), "Toggle key rule"),
    }),
    h("span", {}, `${describeMatch(k.match)} → ${k.drop === "cell" ? "see-through" : `drop ${k.drop}`}`),
    h("button.icon", { title: "Remove rule", onclick: () => setKeys(layer.keys.filter((_, j) => j !== i), "Remove key rule") }, "×")));

  const form = matchForm(ed, { glyph: "", fg: "any", bg: "any" });
  let drop: KeyRule["drop"] = "cell";
  const dropSel = h("select", { onchange: () => { drop = dropSel.value as KeyRule["drop"]; } },
    h("option", { value: "cell" }, "whole cell"), h("option", { value: "bg" }, "background only"),
    h("option", { value: "fg" }, "foreground only"), h("option", { value: "glyph" }, "character only"));
  const title = `Key rules${layer.keys.length ? ` (${layer.keys.filter((k) => k.enabled).length})` : ""}`;
  return {
    el: panel("keys", title, layer.keys.length > 0, "Filter matching cells out of this layer so lower layers show through. Nothing is erased: switch a rule off and the cells are back.",
      ...rows,
      h("div.row", {}, h("button", { title: "Anything that shows as flat black: spaces on black, black blocks, black-on-black text", onclick: () => setKeys([...layer.keys, emptyIsTransparentRule()], "Add key rule") }, "+ empty black cells")),
      form.el,
      h("div.row", {}, field("make see-through", dropSel), h("button", {
        onclick: () => {
          const match = form.read();
          if (!match) return;
          if (!Object.keys(match).length) { ed.setStatus("Set at least one of char / fg / bg for the rule."); return; }
          setKeys([...layer.keys, { match, drop, enabled: true }], "Add key rule");
        },
      }, "+ add rule"))),
  };
}

export function maskPanel(ed: Editor, layer: ContentLayer): Panel {
  const m = layer.mask;
  return {
    el: panel("mask", `Mask${m ? (m.enabled ? " (on)" : " (off)") : ""}`, !!m, "Hides part of this layer without erasing it, and moves with the layer. Make one from a selection: pick a select tool, select, then “mask layer”.",
      m ? h("div.row.wrap", {},
        check("mask on", m.enabled, "Show or ignore the mask", () => ed.setProps("Toggle mask", layer, { mask: { ...m, enabled: !m.enabled } } as Partial<ContentLayer>)),
        h("button", { title: "Turn the mask's visible area into the selection", onclick: () => selectFromMask(ed) }, "→ selection"),
        h("button", { onclick: () => ed.setProps("Remove mask", layer, { mask: undefined } as Partial<ContentLayer>) }, "remove"))
        : h("p.hint", {}, "No mask. Select an area (M, Q or W), then choose “mask layer” on the left.")),
  };
}

export function paletteSwapPanel(ed: Editor, layer: ContentLayer): Panel {
  const remap = layer.remap ?? identityRemap();
  const set = (next: number[] | undefined, label: string): void =>
    ed.setProps(label, layer, { remap: next && !isIdentityRemap(next) ? next : undefined } as Partial<ContentLayer>);
  const sw = (i: number, extra: Record<string, unknown> = {}): HTMLElement =>
    h("span.swatch.small", { style: `background:${cssColor(i, ed.doc.palette)}`, ...extra });
  const presets = remapPresets(ed.remapOptions);
  const sel = h("select", { onchange: () => { const p = presets[Number(sel.value)]; if (p) set(p.remap, `Palette swap: ${p.name}`); } },
    h("option", { value: "" }, "presets…"), ...presets.map((p, i) => h("option", { value: String(i) }, p.name)));
  const swapped = !isIdentityRemap(layer.remap);
  return {
    el: panel("palette", `Palette swap${swapped ? " (on)" : ""}`, swapped, "Remap this layer's 16 colours as it is drawn; the layer itself doesn't change. Click a lower swatch to send that colour to the brush foreground, right-click to reset it.",
      h("div.remap", {}, ...remap.map((_, i) => sw(i, { title: `${i} ${colorName(i)}` }))),
      h("div.remap", {}, ...remap.map((to, i) => sw(to, {
        title: `${colorName(i)} → ${colorName(to)}`, class: `target${to !== i ? " changed" : ""}`,
        onclick: () => { if (ed.fg < 16) set(remap.map((v, j) => (j === i ? ed.fg : v)), "Palette swap"); },
        oncontextmenu: (e: Event) => { e.preventDefault(); set(remap.map((v, j) => (j === i ? i : v)), "Palette swap"); },
      }))),
      h("div.row.wrap", {}, sel,
        h("button", { title: "Shuffle colour families; bright stays paired with dark so shading still reads. Shift-click shuffles all 16.", onclick: (e: MouseEvent) => set(randomRemap(Math.random, e.shiftKey, ed.remapOptions), "Randomize palette") }, "randomize"),
        h("button", { disabled: !swapped, onclick: () => set(undefined, "Reset palette swap") }, "reset")),
      h("div.row.wrap", { title: "Whether presets and randomize also move the greys and white. Black only changes with “negative”, a Shift-click randomize, or by hand." },
        h("span.muted", {}, "include"),
        check("greys", ed.remapOptions.greys, "Dark and light grey count as a colour family", () => { ed.remapOptions.greys = !ed.remapOptions.greys; ed.emit("doc"); }),
        check("white", ed.remapOptions.white, "White follows light grey, so highlights take the new hue too", () => { ed.remapOptions.white = !ed.remapOptions.white; ed.emit("doc"); }, !ed.remapOptions.greys))),
  };
}

export function imagePanel(ed: Editor, layer: ImageLayer): Panel {
  type Recipe = ImageRecipe;
  const snapshot = (): Recipe => snapshotImage(layer);
  const commit = (label: string, before: Recipe): void => commitImage(ed, layer, label, before);
  /** a field that follows the spinner / arrow keys live, and is one undo step when released */
  const liveNumber = (value: number | undefined, opts: Parameters<typeof numberInput>[1], label: string, apply: (v: number | undefined) => void): HTMLElement => {
    let from: Recipe | null = null;
    return numberInput(value, opts,
      (v) => { from ??= snapshot(); apply(v); void scheduleImageRefresh(ed, layer); commit(label, from); from = null; },
      (v) => { from ??= snapshot(); apply(v); void scheduleImageRefresh(ed, layer); });
  };
  /** a discrete change: one undo step, panel rebuilt once the new cells are in */
  const change = (label: string, mutate: () => void): void => {
    const before = snapshot();
    mutate();
    void scheduleImageRefresh(ed, layer).then(() => ed.emit("doc"));
    commit(label, before);
  };

  const slider = (label: string, key: keyof ShadeansOptions, min: number, max: number, step: number, fallback: number, title: string): HTMLElement => {
    let from: Recipe | null = null;
    const current = (layer.options[key] as number | undefined) ?? fallback;
    const readout = h("span.muted", {}, String(current));
    const input = h("input", {
      type: "range", min, max, step, value: String(current), title,
      oninput: () => {   // live while dragging; one undo step on release
        from ??= snapshot();
        (layer.options as unknown as Record<string, number>)[key] = Number(input.value);
        readout.textContent = input.value;
        void scheduleImageRefresh(ed, layer);
      },
      onchange: () => { if (from) { commit(label, from); from = null; } },
    });
    return h("label.slider", { title }, h("span", {}, label), input, readout);
  };
  const flag = (label: string, key: "truecolor" | "blocks" | "autoLevels", title: string): HTMLElement =>
    check(label, layer.options[key], title, () => change(label, () => { layer.options[key] = !layer.options[key]; }));

  const tc = layer.options.truecolor, crop = layer.crop;
  let size: { width: number; height: number } | null = null;
  void imageSize(ed.doc, layer.source).then((sz) => { size = sz; });
  const applyCrop = (patch: Partial<NonNullable<ImageLayer["crop"]>>): void => {
    if (!size) return;
    const c = { ...(layer.crop ?? { x: 0, y: 0, width: size.width, height: size.height }), ...patch };
    c.x = Math.max(0, Math.min(size.width - 1, c.x)); c.y = Math.max(0, Math.min(size.height - 1, c.y));
    c.width = Math.max(1, Math.min(size.width - c.x, c.width)); c.height = Math.max(1, Math.min(size.height - c.y, c.height));
    layer.crop = c.x === 0 && c.y === 0 && c.width === size.width && c.height === size.height ? undefined : c;
  };
  const cropField = (label: string, key: keyof NonNullable<ImageLayer["crop"]>, min: number, placeholder: string, fallback: number): HTMLElement =>
    field(label, liveNumber(crop?.[key], { min, placeholder, width: 56 }, "Crop image", (v) => applyCrop({ [key]: v ?? fallback })));

  return {
    el: panel("image", "Image", true, `Converted live by shadeans from ${layer.source.replace("assets/images/", "")}. The original stays in the project, so size and look can change at any time. Transparent parts become see-through cells.`,
      h("div.row", {},
        field("columns", liveNumber(layer.cols, { min: 1, max: 500 }, "Image width", (v) => { layer.cols = v ?? layer.cols; })),
        field("rows", liveNumber(layer.rows || undefined, { min: 1, max: 2000, placeholder: "auto" }, "Image height", (v) => { layer.rows = v ?? 0; })),
        h("button", { title: "Make it as wide as the canvas", onclick: () => change("Fit image to canvas", () => { layer.cols = ed.doc.width; layer.rows = 0; }) }, "fit width")),
      h("div.row", {},
        flag("24-bit", "truecolor", "Exact colours per cell instead of the 16-colour palette"),
        flag("blocks only", "blocks", "Pixel-art baseline: no shade characters"),
        flag("levels", "autoLevels", "Stretch the source to the full black-to-white range")),
      !tc && slider("texture", "lambda", 0.01, 1, 0.01, 0.1, "How visible dither texture is. 1 = pixel art; lower = more and bolder shading"),
      !tc && slider("coherence", "coherence", 0, 0.006, 0.0005, 0.002, "Pulls neighbouring cells onto shared colours. 0 = off, 0.006 = flat"),
      slider("contrast", "contrast", 0.5, 2, 0.05, 1, "Lightness contrast of the source"),
      slider("saturation", "saturation", 0, 2, 0.05, 1, "Colour strength of the source"),
      slider("chroma lift", "autoChroma", 0, 0.4, 0.01, tc ? 0 : 0.16, "Lifts muted colours onto real palette colours instead of grey"),
      slider("local contrast", "localContrast", 0, 1, 0.05, tc ? 0 : 0.5, "Pushes shapes away from their surroundings in lightness"),
      slider("equalize", "equalize", 0, 1, 0.05, 0, "Spreads bunched-up tones apart; try 0.4 on dim, murky pictures"),
      slider("smooth", "smooth", 0, 4, 1, 0, "Edge-preserving smoothing passes on the source"),
      h("div.row", { title: "Part of the source image to convert, in its own pixels" },
        cropField("crop x", "x", 0, "0", 0), cropField("y", "y", 0, "0", 0),
        cropField("w", "width", 1, "full", 1e9), cropField("h", "height", 1, "full", 1e9)),
      h("div.row", {}, h("button", { onclick: () => change("Reset image settings", () => { layer.options = { ...SHADEANS_DEFAULTS, truecolor: layer.options.truecolor }; }) }, "reset look")),
      h("p.hint", {}, "With the Move tool (V), drag the layer's corner to resize it on the canvas; the right edge for width only, the bottom edge for height only.")),
  };
}
