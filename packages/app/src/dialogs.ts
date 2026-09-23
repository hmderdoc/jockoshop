/** Modal dialogs: SAUCE, scale a layer, canvas size lives in main.ts. */
import {
  type CellsLayer, type ContentLayer, type KdDocument, type Raster, SHADEANS_DEFAULTS, type Sauce, createRaster, depthToPd,
  deviceShiftPx, encodeApng, flipCells, layerGrid, planDepth, renderDepthView, renderGrid, scaleCellsNearest,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { convertPixels } from "./shadeans.js";
import { download, field, h, numberInput } from "./ui.js";

/** A dialog box over a backdrop that closes on a click outside it. Returns the backdrop, to `remove()`. */
export function modal(title: string, body: HTMLElement[], buttons: HTMLElement[], width = 520): HTMLElement {
  const backdrop = h("div.backdrop", { onclick: (e: Event) => { if (e.target === backdrop) backdrop.remove(); } },
    h("div.dialog", { style: `width:${width}px` }, h("h3", {}, title), ...body, h("div.row.end", {}, ...buttons)));
  document.body.append(backdrop);
  return backdrop;
}

/** SAUCE: the metadata record at the end of .ans / .bin / .xb files. */
export function sauceDialog(ed: Editor): void {
  const s = ed.doc.sauce;
  const input = (value: string, max: number, width = 260): HTMLInputElement => h("input", { type: "text", value, maxLength: max, style: `width:${width}px` });
  const title = input(s.title, 35), author = input(s.author, 20), group = input(s.group, 20);
  const date = h("input", { type: "text", value: s.date, placeholder: "export date", maxLength: 8, style: "width:110px", title: "CCYYMMDD; empty = the date of export" });
  const comments = h("textarea", { rows: 5, value: s.comments.join("\n"), spellcheck: false, style: "width:100%", title: "Up to 255 lines of 64 characters; longer lines are cut at export" });
  const fontName = h("input", { type: "text", value: ed.doc.fontName, maxLength: 22, style: "width:200px", title: "The font name written to SAUCE, e.g. IBM VGA, IBM VGA50, Amiga Topaz" });
  const ninePx = h("input", { type: "checkbox", checked: ed.doc.letterSpacing9px });
  const close = (): void => backdrop.remove();
  const save = (): void => {
    const next: Sauce = { title: title.value, author: author.value, group: group.value, date: date.value.replace(/\D/g, "").slice(0, 8), comments: comments.value.split(/\r?\n/).filter((l, i, a) => l !== "" || i < a.length - 1) };
    ed.setProps("SAUCE", ed.doc, { sauce: next, fontName: fontName.value || "IBM VGA", letterSpacing9px: ninePx.checked } as Partial<KdDocument>);
    close();
  };
  const backdrop = modal("SAUCE", [
    h("p.hint", {}, "Written into .ans, .bin and .xb exports and read back from them. Title, author and group are what viewers and archives show."),
    h("div.row", {}, field("title (35)", title)),
    h("div.row", {}, field("author (20)", author), field("group (20)", group)),
    h("div.row", {}, field("date", date), field("font", fontName), h("label.check", { title: "9-pixel-wide cells (VGA text mode): the SAUCE flag viewers use to pick the letter spacing" }, ninePx, "9px letter spacing")),
    field("comments", comments),
  ], [h("button", { onclick: close }, "Cancel"), h("button.primary", { onclick: save }, "Save")]);
  title.focus();
}

/**
 * Scale a cells layer. "Cells" stretches the grid — exact at 2×, 3×…, drops or
 * repeats cells otherwise, never changes a character. "Re-match" renders the
 * layer to pixels, scales the picture and lets shadeans choose characters for
 * it again — the result is shadeans' style, not your strokes.
 */
export function scaleDialog(ed: Editor, layer: CellsLayer): void {
  const g = layer.grid;
  let w = g.width, hgt = g.height, lock = true, mode: "cells" | "rematch" = "cells";
  const wIn = numberInput(w, { min: 1, max: 1000, width: 64 }, (v) => { w = v ?? w; if (lock) { hgt = Math.max(1, Math.round(w * g.height / g.width)); hIn.input.value = String(hgt); } });
  const hIn = numberInput(hgt, { min: 1, max: 5000, width: 64 }, (v) => { hgt = v ?? hgt; if (lock) { w = Math.max(1, Math.round(hgt * g.width / g.height)); wIn.input.value = String(w); } });
  const percent = (p: number) => (): void => { w = Math.max(1, Math.round(g.width * p)); hgt = Math.max(1, Math.round(g.height * p)); wIn.input.value = String(w); hIn.input.value = String(hgt); };
  const modeSel = h("select", { onchange: () => { mode = modeSel.value as typeof mode; } },
    h("option", { value: "cells" }, "cells — stretch the grid, keep every character"),
    h("option", { value: "rematch" }, "re-match — redraw the scaled picture with shadeans"));
  const status = h("p.hint");
  const close = (): void => backdrop.remove();
  const apply = async (): Promise<void> => {
    let next;
    if (mode === "cells") next = scaleCellsNearest(g, w, hgt);
    else {
      status.textContent = "Re-matching…";
      const raster = createRaster(g.width, g.height, ed.font);
      renderGrid(g, ed.font, raster, { palette: ed.doc.palette, iceColors: true });
      // absent cells are transparent in the picture, so they stay absent after re-matching
      const coverage = new Uint8Array(w * hgt);
      for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(g.width - 1, Math.floor((x + 0.5) * g.width / w)), sy = Math.min(g.height - 1, Math.floor((y + 0.5) * g.height / hgt));
        coverage[y * w + x] = g.present[g.index(sx, sy)] ? 255 : 0;
      }
      try { next = await convertPixels(raster.data, raster.width, raster.height, w, hgt, { ...SHADEANS_DEFAULTS, truecolor: false }, ed.doc.iceColors, coverage); }
      catch (err) { status.textContent = `Could not re-match: ${(err as Error).message}`; return; }
    }
    const before = layer.grid, after = next;
    ed.run({ label: "Scale layer", redo: () => { layer.grid = after; }, undo: () => { layer.grid = before; } });
    close();
    ed.setStatus(`Scaled “${layer.name}” to ${w}×${hgt} cells (${mode === "cells" ? "cells" : "re-matched"}).`);
  };
  const flip = (axis: "x" | "y"): void => {
    const before = layer.grid, after = flipCells(before, axis);
    ed.run({ label: axis === "x" ? "Flip horizontal" : "Flip vertical", redo: () => { layer.grid = after; }, undo: () => { layer.grid = before; } });
    close();
  };
  const backdrop = modal(`Scale “${layer.name}”`, [
    h("p.hint", {}, `${g.width}×${g.height} cells now. Hand-drawn cells have no true scale: choose how to make them bigger or smaller.`),
    h("div.row", {}, field("width", wIn), field("height", hIn),
      h("label.check", {}, h("input", { type: "checkbox", checked: lock, onchange: (e: Event) => { lock = (e.target as HTMLInputElement).checked; } }), "keep proportions"),
      h("button", { onclick: percent(2) }, "200%"), h("button", { onclick: percent(0.5) }, "50%")),
    field("method", modeSel),
    h("p.hint", {}, "Cells: exact at whole multiples (200%, 300%), otherwise some cells are dropped or repeated. Re-match: the picture is scaled as pixels and shadeans redraws it in its own style — good for block and shade art, not for lettering."),
    h("div.row", {}, h("span.muted", {}, "also:"), h("button", { onclick: () => flip("x") }, "flip horizontal"), h("button", { onclick: () => flip("y") }, "flip vertical")),
    status,
  ], [h("button", { onclick: close }, "Cancel"), h("button.primary", { onclick: () => void apply() }, "Scale")]);
  wIn.input.focus();
}

/** A raster blown up by a whole factor, nearest-neighbour: crisp pixels for sharing. */
function scaleRaster(r: Raster, k: number): Raster {
  if (k === 1) return r;
  const out: Raster = { width: r.width * k, height: r.height * k, cellWidth: r.cellWidth * k, cellHeight: r.cellHeight * k, data: new Uint8ClampedArray(r.width * k * r.height * k * 4) };
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < out.width; x++) {
      const s = (sy * r.width + Math.floor(x / k)) * 4, d = (y * out.width + x) * 4;
      out.data[d] = r.data[s]; out.data[d + 1] = r.data[s + 1]; out.data[d + 2] = r.data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

/**
 * Export the depth layers as an animated PNG that rocks between the two eyes'
 * views. The dialog animates exactly what will be saved, so the separation,
 * motion, frame count, speed and size can be tuned first.
 */
export function wiggleDialog(ed: Editor, baseName: string): void {
  const opts = { strength: 100, frames: 24, delay: 68, motion: "swing" as "swing" | "flip", scale: 1 };
  let frames: Raster[] = [], playing = 0, at = 0, lastTick = 0;
  const preview = h("canvas.wiggle-preview");
  const info = h("p.hint");
  const comp = ed.comp, plan = planDepth(comp);
  const flat = plan.levels.every((d) => d === 0);
  const opt = { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px };

  const eye = (e: number): Raster => {
    const r = createRaster(ed.doc.width, ed.doc.height, ed.font, ed.doc.letterSpacing9px);
    renderDepthView(comp, plan, ed.font, r, e * deviceShiftPx(1e9, opts.strength / 100), opt);
    return scaleRaster(r, opts.scale);
  };
  const rebuild = (): void => {
    // a flip is the classic two-frame wigglegram; a swing eases through the views in between
    frames = opts.motion === "flip" ? [eye(-1), eye(1)] : Array.from({ length: opts.frames }, (_, k) => eye(Math.sin((2 * Math.PI * k) / opts.frames)));
    at = 0;
    const w = frames[0].width, hgt = frames[0].height;
    if (preview.width !== w || preview.height !== hgt) { preview.width = w; preview.height = hgt; }
    const apart = 2 * Math.abs(deviceShiftPx(depthToPd(Math.max(...plan.levels.map((d) => Math.abs(d)), 0)), opts.strength / 100));
    info.textContent = flat ? "Every layer is at the glass, so nothing will move: give a layer some depth first (Layer panel, right)."
      : `${frames.length} frames of ${w}×${hgt}, ${frames.length * opts.delay} ms per cycle; the deepest layer shifts ${apart.toFixed(0)} px between the two views.`;
  };
  const tick = (now: number): void => {
    if (now - lastTick >= opts.delay) { lastTick = now; at = (at + 1) % frames.length; }
    const f = frames[at];
    preview.getContext("2d")!.putImageData(new ImageData(f.data as Uint8ClampedArray<ArrayBuffer>, f.width, f.height), 0, 0);
    playing = requestAnimationFrame(tick);
  };

  const slider = (label: string, key: "strength" | "frames" | "delay", min: number, max: number, step: number, unit: string, title: string): HTMLElement => {
    const readout = h("span.muted", {}, `${opts[key]}${unit}`);
    const input = h("input", { type: "range", min, max, step, value: String(opts[key]), title, oninput: () => { opts[key] = Number(input.value); readout.textContent = `${opts[key]}${unit}`; rebuild(); } });
    return h("label.slider", { title }, h("span", {}, label), input, readout);
  };
  const motionSel = h("select", { title: "Swing eases between the two views and back; flip alternates them, like a two-frame wigglegram", onchange: () => { opts.motion = motionSel.value as typeof opts.motion; framesRow.hidden = opts.motion === "flip"; rebuild(); } },
    h("option", { value: "swing" }, "swing"), h("option", { value: "flip" }, "flip"));
  const scaleSel = h("select", { title: "Whole-pixel enlargement, so the characters stay crisp", onchange: () => { opts.scale = Number(scaleSel.value); rebuild(); } },
    h("option", { value: "1" }, "1×"), h("option", { value: "2" }, "2×"), h("option", { value: "3" }, "3×"));
  const framesRow = slider("frames", "frames", 4, 48, 2, "", "Frames in one swing: more is smoother and bigger");
  const close = (): void => { cancelAnimationFrame(playing); backdrop.remove(); };
  const save = (): void => {
    const bytes = encodeApng(frames, opts.delay);
    download(`${baseName}-wiggle.png`, bytes, "image/png");
    ed.setStatus(`Saved ${frames.length} frames (${(bytes.length / 1024).toFixed(0)} KB).`);
    close();
  };
  const backdrop = modal("3D wiggle .png", [
    h("p.hint", {}, "An animated PNG that rocks between the two eyes' views of the depth layers. This preview is exactly what will be saved."),
    h("div.wiggle-box", {}, preview),
    slider("separation", "strength", 0, 200, 5, "%", "How far the depth layers shift between the views: 100% is the 3DS at full slider; more exaggerates it"),
    h("div.row", {}, field("motion", motionSel), field("size", scaleSel)),
    framesRow,
    slider("speed", "delay", 30, 250, 2, " ms", "How long each frame shows"),
    info,
  ], [h("button", { onclick: close }, "Cancel"), h("button.primary", { onclick: save }, "Save .png")]);
  rebuild();
  playing = requestAnimationFrame(tick);
}

export type { ContentLayer };
