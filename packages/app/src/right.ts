/**
 * Right sidebar: an always-on preview of the whole picture (with the 3D modes),
 * the layer stack, and the active layer's properties.
 */
import {
  type CellsLayer, type ContentLayer, type DepthPlan, type Layer, type Raster, addFontAsset, cloneLayer,
  createCellsLayer, createFontLayer, createProseLayer, createRaster, isIdentityRemap, layerGrid, planDepth,
  refreshFontLayer, renderDepthView,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { type FontLibrary, pickFont } from "./fonts.js";
import { icon, iconButton } from "./icons.js";
import { type Panel, imagePanel, keyRulesPanel, liveProp, maskPanel, paletteSwapPanel, panel } from "./sections.js";
import { importImage } from "./shadeans.js";
import { focusTextField } from "./tools.js";
import { field, h, pickFile } from "./ui.js";
import type { CanvasView } from "./view.js";

type PreviewMode = "flat" | "wiggle" | "mouse" | "anaglyph" | "sbs";

/** The whole picture, scaled to the sidebar, with the canvas viewport marked. Drag to scroll the canvas. */
function buildPreview(ed: Editor, view: CanvasView): HTMLElement {
  let mode: PreviewMode = "flat", strength = 24, mouseEye = 0, frame = 0;
  let plan: DepthPlan | null = null, left: Raster | null = null, right: Raster | null = null;
  const canvas = h("canvas.preview");
  const box = h("div.preview-box", {}, canvas);
  // the width to scale to: the scroll box's content width. The box always shows its scroll track
  // (overflow-y: scroll), so that width cannot change with the canvas height — otherwise a scrollbar
  // appearing shrinks the canvas, which no longer needs the scrollbar, which grows it… every frame
  let width = 0;
  const scratch = document.createElement("canvas");
  const info = h("span.muted.grow");

  const eyes = (): [Raster, Raster] => {
    const { doc, font } = ed, w = doc.width * (doc.letterSpacing9px ? 9 : 8), hgt = doc.height * font.height;
    if (!left || left.width !== w || left.height !== hgt) {
      left = createRaster(doc.width, doc.height, font, doc.letterSpacing9px);
      right = createRaster(doc.width, doc.height, font, doc.letterSpacing9px);
    }
    return [left, right!];
  };

  const draw = (): void => {
    const art = view.artCanvas;
    if (!art.width || !width) return;
    const sbs = mode === "sbs", srcW = sbs ? art.width * 2 + 8 : art.width;
    const scale = Math.min(1, width / srcW);
    const w = Math.max(1, Math.round(srcW * scale)), hgt = Math.max(1, Math.round(art.height * scale));
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; canvas.style.width = `${w}px`; canvas.style.height = `${hgt}px`; }
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    if (mode === "flat") ctx.drawImage(art, 0, 0, w, hgt);
    else {
      plan ??= planDepth(ed.comp);
      const [L, R] = eyes(), half = strength / 2;
      const opts = { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px };
      if (scratch.width !== srcW || scratch.height !== art.height) { scratch.width = srcW; scratch.height = art.height; }
      const sctx = scratch.getContext("2d")!;
      const put = (r: Raster, x: number): void => sctx.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), x, 0);
      if (mode === "sbs" || mode === "anaglyph") {
        renderDepthView(ed.comp, plan, ed.font, L, -half, opts);
        renderDepthView(ed.comp, plan, ed.font, R, half, opts);
        if (mode === "sbs") { sctx.fillStyle = "#000"; sctx.fillRect(0, 0, srcW, art.height); put(L, 0); put(R, L.width + 8); } else {
          for (let i = 0; i < L.data.length; i += 4) { L.data[i + 1] = R.data[i + 1]; L.data[i + 2] = R.data[i + 2]; }   // red = left eye, cyan = right
          put(L, 0);
        }
      } else {
        renderDepthView(ed.comp, plan, ed.font, L, (mode === "wiggle" ? Math.sin(performance.now() / 260) : mouseEye) * half, opts);
        put(L, 0);
      }
      ctx.drawImage(scratch, 0, 0, w, hgt);
    }
    // where the main canvas is looking
    if (!sbs) {
      const v = view.viewport();
      ctx.strokeStyle = "rgba(255,80,220,.95)";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(v.x * scale) + 0.5, Math.round(v.y * scale) + 0.5, Math.max(2, Math.round(v.width * scale) - 1), Math.max(2, Math.round(v.height * scale) - 1));
      const top = v.y * scale, bottom = (v.y + v.height) * scale;   // keep the viewport in sight on tall pieces
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
    if (mode === "flat") info.textContent = `${ed.doc.width}×${ed.doc.height}`;
    else {
      const p = plan!;
      info.textContent = p.levels.some((d) => d > 0)
        ? `${p.levels.length} of 16 depths${p.merged ? ", merged" : ""}${p.clamped.length ? `; at the screen: ${p.clamped.join(", ")}` : ""}`
        : "all layers at the screen — give one a negative depth";
      info.title = "Drawn the way 3dBBS draws text layers: deepest first, shifted by disparity, black where a shifted layer uncovers";
    }
  };

  const loop = (): void => { cancelAnimationFrame(frame); if (mode !== "wiggle") return; draw(); frame = requestAnimationFrame(loop); };
  const refresh = (): void => { plan = null; if (mode === "wiggle") loop(); else draw(); };

  const seek = (e: PointerEvent): void => {
    if (mode === "sbs") return;
    const r = canvas.getBoundingClientRect(), art = view.artCanvas;
    view.centerOn(((e.clientX - r.left) / r.width) * art.width, ((e.clientY - r.top) / r.height) * art.height);
  };
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) seek(e);
    else if (mode === "mouse") { const r = canvas.getBoundingClientRect(); mouseEye = ((e.clientX - r.left) / r.width) * 2 - 1; draw(); }
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });

  const strengthIn = h("input", { type: "range", min: 0, max: 64, step: 1, value: String(strength), title: "Eye separation", oninput: () => { strength = Number(strengthIn.value); refresh(); } });
  const modeSel = h("select", {
    title: "Preview mode. The 3D modes show the layer depths as 3dBBS will.",
    onchange: () => { mode = modeSel.value as PreviewMode; strengthIn.hidden = mode === "flat"; refresh(); },
  },
  h("option", { value: "flat" }, "flat"), h("option", { value: "wiggle" }, "3D: wiggle"), h("option", { value: "mouse" }, "3D: follow mouse"),
  h("option", { value: "anaglyph" }, "3D: red / cyan"), h("option", { value: "sbs" }, "3D: side by side"));
  strengthIn.hidden = true;

  ed.on("pixels", refresh);
  ed.on("doc", refresh);
  ed.on("scroll", () => { if (mode !== "wiggle") draw(); });
  const wrap = h("div.preview-wrap", {}, box, h("div.row.preview-bar", {}, modeSel, strengthIn, info));
  new ResizeObserver(() => {
    const w = box.clientWidth - 2;   // clientWidth excludes the scroll track; 1px each side so the outline is never on the edge
    if (w > 0 && w !== width) { width = w; draw(); }
  }).observe(box);
  return wrap;
}

export function buildRight(ed: Editor, view: CanvasView, lib: FontLibrary): HTMLElement {
  const stack = h("div");
  const root = h("div.panel.layers", {}, buildPreview(ed, view), stack);

  const rasterize = (layer: ContentLayer): void => {
    const grid = layerGrid(layer);
    if (layer.type === "cells" || !grid) return;
    const flat: CellsLayer = { ...createCellsLayer(layer.name, 1, 1), id: layer.id, x: layer.x, y: layer.y, keys: layer.keys, mask: layer.mask, remap: layer.remap, depth: layer.depth, visible: layer.visible, grid: grid.clone() };
    const at = ed.locate(layer.id)!;
    ed.run({
      label: "Rasterize layer",
      redo: () => { at.list[at.list.indexOf(layer)] = flat; },
      undo: () => { at.list[at.list.indexOf(flat)] = layer; },
    });
  };

  const typeIcon = (l: Layer): SVGSVGElement => icon(l.type === "cells" ? "cells" : l.type === "font" ? "text" : l.type === "image" ? "image" : l.type === "prose" ? "prose" : "group", 15);

  const row = (l: Layer, depth: number): HTMLElement[] => {
    const el = h(`div.layer${l.id === ed.activeId ? ".active" : ""}${l.visible ? "" : ".off"}`, {
      style: `padding-left:${4 + depth * 14}px`, onclick: () => ed.setActive(l.id),
    },
    iconButton(l.visible ? "eye" : "eyeOff", l.visible ? "Hide layer" : "Show layer", {
      class: "bare", onclick: (e) => { e.stopPropagation(); ed.setProps(l.visible ? "Hide layer" : "Show layer", l, { visible: !l.visible }); },
    }),
    h("span.kind", { title: l.type === "font" ? "live TheDraw text" : l.type === "image" ? "live image" : l.type === "prose" ? "reflowing prose" : l.type }, typeIcon(l)),
    h("span.name", { title: "Double-click to rename", ondblclick: () => { const name = prompt("Layer name", l.name); if (name) ed.setProps("Rename layer", l, { name }); } }, l.name),
    l.type !== "group" && l.keys.some((k) => k.enabled) && h("span.tag.key", { title: "Has key rules" }, "key"),
    l.type !== "group" && l.mask?.enabled && h("span.tag.key", { title: "Has a mask" }, "mask"),
    l.type !== "group" && !isIdentityRemap(l.remap) && h("span.tag.key", { title: "Palette swap" }, "pal"),
    l.type !== "group" && l.depth !== undefined && h("span.tag.depth", { title: "3D depth (negative = behind the screen)" }, `z${l.depth}`));
    const kids = l.type === "group" ? [...l.children].reverse().flatMap((c) => row(c, depth + 1)) : [];
    return [el, ...kids];
  };

  const render = (): void => {
    const active = ed.active;
    const count = (layers: readonly Layer[]): number => layers.reduce((n, l) => n + 1 + (l.type === "group" ? count(l.children) : 0), 0);
    const buttons = h("div.iconbar", {},
      iconButton("cells", "New cells layer", { plus: true, tip: "a layer you draw on", onclick: () => ed.addLayer(createCellsLayer(`Layer ${count(ed.doc.layers) + 1}`, ed.doc.width, ed.doc.height)) }),
      iconButton("text", "New text layer", {
        plus: true, tip: "live TheDraw text", onclick: async () => {
          const pick = await pickFont(ed, lib, "Text");
          if (!pick) return;
          const layer = createFontLayer("Text", addFontAsset(ed.doc, pick.entry.file, pick.bytes), "Text", pick.entry.index);
          refreshFontLayer(ed.doc, layer);
          ed.addLayer(layer, "Add text layer");
          ed.chooseTool("text");
          focusTextField();
        },
      }),
      iconButton("prose", "New prose layer", {
        plus: true, tip: "reflowing text in a frame; or drag a frame with the Type tool", onclick: () => {
          const layer = createProseLayer("Prose", Math.min(40, ed.doc.width), Math.min(10, ed.doc.height));
          layer.fg = []; layer.bg = [];
          ed.addLayer(layer, "Add prose layer");
          ed.chooseTool("text");
          ed.prose.begin(layer);
        },
      }),
      iconButton("image", "New image layer", {
        plus: true, tip: "an image converted by shadeans, kept editable", onclick: async () => {
          const file = await pickFile("image/png,image/jpeg,image/gif,image/webp,image/bmp");
          if (file) await importImage(ed, file.name, new Uint8Array(await file.arrayBuffer()));
        },
      }),
      h("span.grow"),
      iconButton("up", "Move layer up", { disabled: !active, onclick: () => active && ed.moveLayer(active.id, 1) }),
      iconButton("down", "Move layer down", { disabled: !active, onclick: () => active && ed.moveLayer(active.id, -1) }),
      iconButton("duplicate", "Duplicate layer", { disabled: !active, tip: "cells, recipe, key rules, mask and palette swap", onclick: () => active && ed.addLayer(cloneLayer(active), "Duplicate layer") }),
      iconButton("trash", "Delete layer", { disabled: !active, onclick: () => active && ed.removeLayer(active.id) }));

    const panels: Panel[] = [];
    if (active && active.type !== "group") {
      const live = active.type !== "cells";
      panels.push({
        el: panel("layer", "Layer", true, "Depth is for 3dBBS: 0 = at the screen, negative = behind it (to −1800), positive = in front. Pick a 3D mode in the preview to see it.",
          h("div.row", {},
            field("3D depth", liveProp(ed, active, "depth", "Layer depth", active.depth, { min: -1800, max: 1800, placeholder: "0", width: 72 }, (v) => v || undefined)),
            active.type === "font" && h("button", { title: "Font, text and spacing are under the Type tool", onclick: () => { ed.chooseTool("text"); focusTextField(); } }, "edit text (T)"),
            active.type === "prose" && h("button", { title: "Edit the text on the canvas", onclick: () => { ed.chooseTool("text"); ed.prose.begin(active); } }, "edit text (T)"),
            live && h("button", { title: "Turn into plain cells you can draw on. It stops being live.", onclick: () => rasterize(active) }, "rasterize")),
          (active.depth ?? 0) > 0 && h("p.hint", {}, "In front of the screen: 3dBBS text layers can't do that yet (protocol 0.3), so export puts this layer at the screen.")),
      });
      if (active.type === "image") panels.push(imagePanel(ed, active));
      panels.push(paletteSwapPanel(ed, active), maskPanel(ed, active), keyRulesPanel(ed, active));
    }
    stack.replaceChildren(
      h("div.sec-title", {}, "Layers"), buttons,
      h("div.layer-list", {}, ...[...ed.doc.layers].reverse().flatMap((l) => row(l, 0))),
      ...panels.map((p) => p.el));
  };

  ed.on("doc", render);
  render();
  return root;
}
