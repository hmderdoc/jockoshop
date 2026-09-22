import {
  CellGrid, type TdfFont, createRaster, layoutTdf, parseTdf, renderGrid, renderTdf,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { h } from "./ui.js";

export interface FontEntry {
  file: string;
  index: number;
  name: string;
  height: number;
  type: string;
}

/** The TheDraw fonts served from public/tdfonts (see scripts/sync-fonts.mjs). */
export class FontLibrary {
  entries: FontEntry[] = [];
  private files = new Map<string, Promise<Uint8Array>>();

  async load(): Promise<void> {
    try {
      const res = await fetch("/tdfonts/index.json");
      if (!res.ok) return;
      const index = (await res.json()) as { file: string; fonts: { name: string; height: number; type: string }[] }[];
      this.entries = index.flatMap((f) => f.fonts.map((fn, i) => ({ file: f.file, index: i, ...fn })));
    } catch { /* no fonts synced: the picker explains how to get them */ }
  }

  bytes(file: string): Promise<Uint8Array> {
    let p = this.files.get(file);
    if (!p) {
      p = fetch(`/tdfonts/${encodeURIComponent(file)}`).then(async (r) => {
        if (!r.ok) throw new Error(`could not load ${file}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      this.files.set(file, p);
    }
    return p;
  }
}

/** Render sample text in a font to a canvas, for the picker preview. */
export function previewCanvas(ed: Editor, font: TdfFont, text: string): HTMLCanvasElement {
  const styled = [...text].map((ch) => ({ ch, font }));
  const layout = layoutTdf(styled, Infinity, { lineGap: 1, extraSpacing: 0, spaceWidth: 3 }, font);
  const cells = renderTdf(styled, layout, { fg: 7, bg: null });
  const grid = CellGrid.filled(cells.width, cells.height, 32, 7, 0);
  for (let i = 0; i < cells.present.length; i++) {
    if (cells.present[i]) grid.setAt(i, { glyph: cells.glyph[i], fg: cells.fg[i], ...(cells.present[i] & 4 ? { bg: cells.bg[i] } : {}) });
  }
  const raster = createRaster(grid.width, grid.height, ed.font);
  renderGrid(grid, ed.font, raster, { iceColors: true });
  const canvas = h("canvas.font-preview", { width: raster.width, height: raster.height });
  canvas.getContext("2d")!.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0);
  return canvas;
}

/** Modal font picker. Resolves with the chosen font and its file bytes, or null. */
export function pickFont(ed: Editor, lib: FontLibrary, sample: string): Promise<{ entry: FontEntry; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    let chosen: FontEntry | null = null;
    const list = h("div.font-list"), preview = h("div.font-preview-box");
    const filter = h("input", { type: "search", placeholder: "filter by name…", oninput: () => fill() });
    const maxH = h("input", { type: "number", min: 1, max: 40, placeholder: "max height", style: "width:96px", oninput: () => fill() });
    const count = h("span.muted");
    const close = (result: { entry: FontEntry; bytes: Uint8Array } | null): void => { backdrop.remove(); resolve(result); };

    const show = async (e: FontEntry): Promise<void> => {
      chosen = e;
      list.querySelectorAll(".selected").forEach((n) => n.classList.remove("selected"));
      list.querySelector(`[data-key="${CSS.escape(`${e.file}#${e.index}`)}"]`)?.classList.add("selected");
      try {
        const font = parseTdf(await lib.bytes(e.file))[e.index];
        if (chosen !== e) return;
        preview.replaceChildren(previewCanvas(ed, font, sample || "Sample"));
      } catch (err) { preview.replaceChildren(String(err)); }
    };

    const fill = (): void => {
      const q = filter.value.trim().toLowerCase(), mh = Number(maxH.value) || Infinity;
      const hits = lib.entries.filter((e) => e.height <= mh && (!q || e.name.toLowerCase().includes(q) || e.file.toLowerCase().includes(q)));
      count.textContent = `${hits.length} of ${lib.entries.length} fonts${hits.length > 300 ? " (first 300 shown)" : ""}`;
      list.replaceChildren(...hits.slice(0, 300).map((e) => h("div.font-item", {
        "data-key": `${e.file}#${e.index}`, onclick: () => void show(e), ondblclick: () => void accept(),
      }, h("span", {}, e.name || e.file), h("span.muted", {}, `${e.file} · ${e.type} · ${e.height} rows`))));
    };

    const accept = async (): Promise<void> => { if (chosen) close({ entry: chosen, bytes: await lib.bytes(chosen.file) }); };

    const body = lib.entries.length
      ? [h("div.row", {}, filter, maxH, count), list, preview]
      : [h("p", {}, "No TheDraw fonts found. Run ", h("code", {}, "node scripts/sync-fonts.mjs [path/to/tdfonts]"),
          " to copy them from a Synchronet install (ctrl/tdfonts), then reload.")];
    const backdrop = h("div.backdrop", { onclick: (e: Event) => { if (e.target === backdrop) close(null); } },
      h("div.dialog", {}, h("h3", {}, "TheDraw font"), ...body,
        h("div.row.end", {}, h("button", { onclick: () => close(null) }, "Cancel"),
          h("button.primary", { onclick: () => void accept() }, "Use font"))));
    document.body.append(backdrop);
    fill();
    filter.focus();
  });
}
