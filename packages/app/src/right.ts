/**
 * Right sidebar: an always-on preview of the whole picture (with the 3D modes),
 * the layer stack, and the active layer's properties.
 */
import {
  MAX_FRONT_PD,
  SLIDER_OUT_PD,
  SLIDER_IN_PD,
  depthToPd,
  deviceShiftPx,
  type CellsLayer, type ContentLayer, type DepthPlan, type Layer, type Raster, type ReferenceLayer, addFontAsset,
  addImageAsset, cloneLayer, createCellsLayer, createFontLayer, createImageLayer, createProseLayer, createRaster,
  isIdentityRemap, layerGrid, newLayerId, planDepth,
  refreshFontLayer, renderDepthView,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { type FontLibrary, pickFont } from "./fonts.js";
import { icon, iconButton } from "./icons.js";
import { type Panel, imagePanel, keyRulesPanel, liveProp, maskPanel, paletteSwapPanel, panel } from "./sections.js";
import { scaleDialog } from "./dialogs.js";
import { imageSize, importImage, refreshImageLayer, rowsForAspect } from "./shadeans.js";
import { focusTextField } from "./tools.js";
import { field, h, pickFile } from "./ui.js";
import type { CanvasView } from "./view.js";

type PreviewMode = "flat" | "wiggle" | "mouse" | "anaglyph" | "sbs";

/** The whole picture, scaled to the sidebar, with the canvas viewport marked. Drag to scroll the canvas. */
function buildPreview(ed: Editor, view: CanvasView): HTMLElement {
  let mode: PreviewMode = "flat", strength = 100, mouseEye = 0, frame = 0;   // strength: the 3DS depth slider, in percent
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
      const [L, R] = eyes(), half = deviceShiftPx(1e9, strength / 100);   // per-eye pixels at infinity: exactly the device's
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
      info.textContent = p.levels.some((d) => d !== 0)
        ? `${p.levels.length} of 16 depths${p.merged ? ", merged" : ""}${p.front.length ? `; popping out: ${p.front.join(", ")}` : ""}`
        : "all layers at the screen — move a layer's depth slider";
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

  const strengthIn = h("input", { type: "range", min: 0, max: 100, step: 1, value: String(strength), title: "The 3DS depth slider: 100% is the device fully up. The preview shifts each eye exactly as 3dBBS does.", oninput: () => { strength = Number(strengthIn.value); refresh(); } });
  const modeSel = h("select", {
    title: "Preview mode. The 3D modes show the layer depths as 3dBBS will.",
    onchange: () => { mode = modeSel.value as PreviewMode; strengthIn.hidden = mode === "flat"; refresh(); },
  },
  h("option", { value: "flat" }, "flat"), h("option", { value: "wiggle" }, "3D: wiggle"), h("option", { value: "mouse" }, "3D: follow mouse"),
  h("option", { value: "anaglyph" }, "3D: red / cyan"), h("option", { value: "sbs" }, "3D: side by side"));
  strengthIn.hidden = true;
  // the app can switch the mode itself: the first launch wiggles the welcome piece, New goes back to flat
  ed.on("preview", (m) => { mode = m as PreviewMode; modeSel.value = mode; strengthIn.hidden = mode === "flat"; refresh(); });

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
    if (layer.type === "cells" || layer.type === "reference" || !grid) return;
    const flat: CellsLayer = { ...createCellsLayer(layer.name, 1, 1), id: layer.id, x: layer.x, y: layer.y, keys: layer.keys, mask: layer.mask, remap: layer.remap, depth: layer.depth, visible: layer.visible, grid: grid.clone() };
    const at = ed.locate(layer.id)!;
    ed.run({
      label: "Rasterize layer",
      redo: () => { at.list[at.list.indexOf(layer)] = flat; },
      undo: () => { at.list[at.list.indexOf(flat)] = layer; },
    });
  };

  const typeIcon = (l: Layer): SVGSVGElement => icon(l.type === "cells" ? "cells" : l.type === "font" ? "text" : l.type === "image" ? "image" : l.type === "prose" ? "prose" : l.type === "reference" ? "reference" : "group", 15);

  const row = (l: Layer, depth: number): HTMLElement[] => {
    const el = h(`div.layer${l.id === ed.activeId ? ".active" : ""}${l.visible ? "" : ".off"}${l.type === "reference" ? ".ref" : ""}`, {
      style: `padding-left:${4 + depth * 14}px`, onclick: () => ed.setActive(l.id),
    },
    iconButton(l.visible ? "eye" : "eyeOff", l.visible ? "Hide layer" : "Show layer", {
      class: "bare", onclick: (e) => { e.stopPropagation(); ed.setProps(l.visible ? "Hide layer" : "Show layer", l, { visible: !l.visible }); },
    }),
    h("span.kind", { title: l.type === "font" ? "live TheDraw text" : l.type === "image" ? "live image" : l.type === "prose" ? "reflowing prose" : l.type === "reference" ? "reference image (not exported)" : l.type }, typeIcon(l)),
    h("span.name", { title: "Double-click to rename", ondblclick: () => { const name = prompt("Layer name", l.name); if (name) ed.setProps("Rename layer", l, { name }); } }, l.name),
    l.type === "reference" && h("span.tag", { title: "Reference image: shown to draw from, never part of the picture" }, "ref"),
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
    // one "Add layer" button with a labelled menu, instead of a row of tiny icons
    const addItem = (name: Parameters<typeof icon>[0], label: string, note: string, onclick: () => void): HTMLElement =>
      h("button", { onclick: () => { addMenu.hidden = true; onclick(); } }, icon(name, 18), h("span.grow", {}, label), h("span.muted", {}, note));
    const addMenu = h("div.menu.add-menu", { hidden: true },
      addItem("cells", "Cells layer", "draw on it", () => ed.addLayer(createCellsLayer(`Layer ${count(ed.doc.layers) + 1}`, ed.doc.width, ed.doc.height))),
      addItem("text", "TheDraw text", "live big-font text", async () => {
        const pick = await pickFont(ed, lib, "Text");
        if (!pick) return;
        const layer = createFontLayer("Text", addFontAsset(ed.doc, pick.entry.file, pick.bytes), "Text", pick.entry.index);
        refreshFontLayer(ed.doc, layer);
        ed.addLayer(layer, "Add text layer");
        ed.chooseTool("text");
        focusTextField();
      }),
      addItem("prose", "Prose", "reflowing text in a frame", () => {
        const layer = createProseLayer("Prose", Math.min(40, ed.doc.width), Math.min(10, ed.doc.height));
        layer.fg = []; layer.bg = [];
        ed.addLayer(layer, "Add prose layer");
        ed.chooseTool("text");
        ed.prose.begin(layer);
      }),
      addItem("image", "Image…", "converted by shadeans, kept editable", async () => {
        const file = await pickFile("image/png,image/jpeg,image/gif,image/webp,image/bmp");
        if (file) await importImage(ed, file.name, new Uint8Array(await file.arrayBuffer()));
      }),
      h("div.menu-sep", {}, "not part of the picture"),
      addItem("reference", "Reference image…", "to draw from; never exported", async () => {
        const file = await pickFile("image/png,image/jpeg,image/gif,image/webp,image/bmp");
        if (!file) return;
        const source = addImageAsset(ed.doc, file.name, new Uint8Array(await file.arrayBuffer()));
        const size = await imageSize(ed.doc, source);
        const width = Math.min(ed.doc.width, 40), height = Math.max(1, await rowsForAspect(size.width, size.height, width));
        const layer: ReferenceLayer = { type: "reference", id: newLayerId(), name: `ref: ${file.name.replace(/\.[^.]+$/, "")}`, visible: true, locked: false, x: 0, y: 0, keys: [], source, width, height, opacity: 0.5 };
        ed.addLayer(layer, "Add reference");
        ed.chooseTool("move");
      }));
    const addBtn = h("button.add-layer", { title: "Add a layer", onclick: (e: Event) => { e.stopPropagation(); addMenu.hidden = !addMenu.hidden; } }, h("span.plus", {}, "+"), "Add layer", h("span.muted", {}, "▾"));
    document.addEventListener("click", () => { addMenu.hidden = true; }, { once: true });
    const buttons = h("div.iconbar", {},
      h("span.menu-anchor", {}, addBtn, addMenu),
      h("span.grow"),
      iconButton("up", "Move layer up", { disabled: !active, onclick: () => active && ed.moveLayer(active.id, 1) }),
      iconButton("down", "Move layer down", { disabled: !active, onclick: () => active && ed.moveLayer(active.id, -1) }),
      iconButton("duplicate", "Duplicate layer", { disabled: !active, tip: "cells, recipe, key rules, mask and palette swap", onclick: () => active && ed.addLayer(cloneLayer(active), "Duplicate layer") }),
      iconButton("trash", "Delete layer", { disabled: !active, onclick: () => active && ed.removeLayer(active.id) }));

    const panels: Panel[] = [];
    if (active?.type === "reference") {
      const r = active;
      panels.push({ el: panel("reference", "Reference image", true, "Something to draw from. It is shown over the canvas at this opacity and never exported.",
        h("label.slider", {}, h("span", {}, "opacity"), h("input", { type: "range", min: 0.05, max: 1, step: 0.05, value: String(r.opacity), oninput: (e: Event) => { r.opacity = Number((e.target as HTMLInputElement).value); ed.emit("ui"); } }), h("span.muted", {}, `${Math.round(r.opacity * 100)}%`)),
        h("p.hint", {}, "Move (V): drag to place, drag the corner or edges to resize."),
        h("div.row", {}, h("button", {
          title: "Convert it with shadeans into a real image layer of the same size and position",
          onclick: async () => {
            const layer = createImageLayer(r.name.replace(/^ref: /, ""), r.source, r.width);
            layer.x = r.x; layer.y = r.y; layer.rows = r.height;
            try { await refreshImageLayer(ed.doc, layer); } catch (err) { ed.setStatus(`Could not convert: ${(err as Error).message}`); return; }
            const at = ed.locate(r.id)!;
            ed.run({ label: "Reference to image layer", redo: () => { at.list[at.list.indexOf(r)] = layer; ed.activeId = layer.id; }, undo: () => { at.list[at.list.indexOf(layer)] = r; ed.activeId = r.id; } });
          },
        }, "convert to image layer"))) });
    } else if (active && active.type !== "group") {
      const live = active.type !== "cells";
      panels.push({
        el: panel("layer", "Layer", true, "3D depth for 3dBBS, in centi-world-units: glass in the middle, into the screen on the left (down to −1800), out of it on the right (to +180). Pick a 3D mode in the preview to see it.",
          (() => {
            // A linear slider, −600 (into the screen) … +180 (pop-out). The markers are icons placed at
            // the true fraction of the track: the glass icon sits exactly where the slider's zero is.
            const MIN = -SLIDER_IN_PD, MAX = SLIDER_OUT_PD;
            const at = (d: number): string => `${((d - MIN) / (MAX - MIN)) * 100}%`;
            const cur = active.depth ?? 0;
            let from: number | undefined | null = null;
            // the readout is measured, not vibes: how far apart the two eyes' copies land on the 3DS at full slider
            const feel = (px: number): string => (px < 8 ? "subtle" : px <= 26 ? "clear" : px <= 40 ? "strong" : "hard to fuse");
            const label = (d: number): string => {
              if (!d) return "at the glass";
              const apart = 2 * Math.abs(deviceShiftPx(depthToPd(d)));
              return `${Math.abs(d)} ${d < 0 ? "in" : "out"} · ${apart.toFixed(0)} px apart, ${feel(apart)}`;
            };
            const readout = h("span.muted", {}, label(cur));
            const input = h("input.depth", {
              type: "range", min: MIN, max: MAX, step: 1, value: String(Math.max(MIN, Math.min(MAX, cur))),
              title: "3D depth: drag left to sink the layer into the screen, right to pop it out. The readout is how far apart the two eyes' copies land on the 3DS at full slider: under ~8 px is subtle, 8–26 reads clearly, past ~26 px (5 mm) the eyes struggle to fuse it. The exact field below goes further.",
              oninput: () => {
                from ??= active.depth;
                const v = Number(input.value);
                active.depth = v || undefined;
                readout.textContent = label(v);
                ed.emit("pixels");   // the preview re-plans depth from the layers
              },
              onchange: () => { if (from !== null) { const to = active.depth; active.depth = from; ed.setProps("Layer depth", active, { depth: to } as Partial<ContentLayer>); from = null; } },
            });
            const marker = (name: Parameters<typeof icon>[0], d: number, tip: string): HTMLElement =>
              h("span.depth-mark", { style: `left:${at(d)}`, title: tip }, icon(name, 14));
            return h("div.depth-row", {},
              h("div.depth-track", {}, input,
                marker("depthIn", MIN, `into the screen (to ${-MIN})`), marker("depthGlass", 0, "at the glass"), marker("depthOut", MAX, `out of the screen (to ${MAX})`)),
              h("div.row", {}, h("span.muted", {}, "3D depth"), h("span.grow"), readout));
          })(),
          h("div.row", {},
            field("exact", liveProp(ed, active, "depth", "Layer depth", active.depth, { min: -1800, max: MAX_FRONT_PD, placeholder: "0", width: 72 }, (v) => v || undefined)),
            active.type === "font" && h("button", { title: "Font, text and spacing are under the Type tool", onclick: () => { ed.chooseTool("text"); focusTextField(); } }, "edit text (T)"),
            active.type === "prose" && h("button", { title: "Edit the text on the canvas", onclick: () => { ed.chooseTool("text"); ed.prose.begin(active); } }, "edit text (T)"),
            live && h("button", { title: "Turn into plain cells you can draw on. It stops being live.", onclick: () => rasterize(active) }, "rasterize"),
            active.type === "cells" && h("button", { title: "Scale or flip the layer's cells", onclick: () => scaleDialog(ed, active) }, "scale…"),
            active.type !== "prose" && field("prose flows around", (() => {
              const sel = h("select", { title: "Whether prose layers wrap around this layer's content. Auto: a layer covering most of the text frame is a background and is written over; anything smaller is an obstacle.",
                onchange: () => ed.setProps("Text wrap", active, { textWrap: sel.value === "auto" ? undefined : sel.value as "always" | "never" }) },
                h("option", { value: "auto" }, "auto"), h("option", { value: "always" }, "always"), h("option", { value: "never" }, "never"));
              sel.value = active.textWrap ?? "auto";
              return sel;
            })())),
          (active.depth ?? 0) > 0 && h("p.hint", {}, "Popping out of the screen (3dBBS protocol 0.4; a 0.3 client shows it at the glass)."),
          (() => {
            const cur = active.opacity ?? 1;
            let from: number | undefined | null = null;
            const readout = h("span.muted", {}, `${Math.round(cur * 100)}%`);
            const input = h("input", {
              type: "range", min: 0.1, max: 1, step: 0.05, value: String(cur),
              oninput: () => { from ??= active.opacity; const v = Number(input.value); active.opacity = v >= 1 ? undefined : v; readout.textContent = `${Math.round(v * 100)}%`; ed.recomposite(); },
              onchange: () => { if (from !== null) { const to = active.opacity; active.opacity = from; ed.setProps("Layer opacity", active, { opacity: to } as Partial<ContentLayer>); from = null; } },
            });
            return h("label.slider", { title: "Below 100% the layer is blended as pixels and its cells re-matched through shadeans in the flattened picture. The layer's own cells never change." }, h("span", {}, "opacity"), input, readout);
          })(),
          (active.opacity ?? 1) < 1 && h("p.hint", {}, "Translucent: what you see (and export) for this layer is shadeans' re-match of the blend, not its cells. Set 100% to get the cells back.")),
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
