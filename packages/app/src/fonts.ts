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

/** How the list is ordered. `rows` is the font's height in cells. */
type SortKey = "name" | "type" | "rows" | "file";

/**
 * Modal font picker. Resolves with the chosen font and its file bytes, or null.
 *
 * There are ~3,500 fonts, so finding one is the whole job: the list sorts by
 * any column, and the row filter takes a range — setting both ends to the same
 * number is how you ask for exactly that size, which is the common case when a
 * piece already has a height and you want another font that fits it.
 */
export function pickFont(ed: Editor, lib: FontLibrary, sample: string): Promise<{ entry: FontEntry; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    let chosen: FontEntry | null = null;
    let sort: { by: SortKey; dir: 1 | -1 } = { by: "name", dir: 1 };
    const list = h("div.font-list", { tabindex: 0 }), preview = h("div.font-preview-box");   // focusable, so the arrows work after a click
    const filter = h("input", { type: "search", placeholder: "filter by name…", oninput: () => fill() });
    const minH = h("input", { type: "number", min: 1, max: 40, placeholder: "min", style: "width:70px", title: "Shortest font to show", oninput: () => fill() });
    const maxH = h("input", { type: "number", min: 1, max: 40, placeholder: "max", style: "width:70px", title: "Tallest font to show — put the same number in both to get exactly that size", oninput: () => fill() });
    const exact = h("button", { title: "Show only fonts of the size in the min box", onclick: () => { if (minH.value) { maxH.value = minH.value; fill(); } } }, "only");
    const count = h("span.muted");
    const head = h("div.font-head");
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

    const by = (e: FontEntry): string | number =>
      sort.by === "rows" ? e.height : sort.by === "type" ? e.type : sort.by === "file" ? e.file.toLowerCase() : (e.name || e.file).toLowerCase();

    const LIMIT = 300;
    let shown: FontEntry[] = [];
    const fill = (): void => {
      const q = filter.value.trim().toLowerCase();
      const lo = Number(minH.value) || 0, hi = Number(maxH.value) || Infinity;
      const hits = lib.entries.filter((e) => e.height >= lo && e.height <= hi
        && (!q || e.name.toLowerCase().includes(q) || e.file.toLowerCase().includes(q)));
      hits.sort((a, b) => {
        const x = by(a), y = by(b);
        // ties fall back to the name, so the order never wobbles between renders
        const d = x < y ? -1 : x > y ? 1 : (a.name || a.file).toLowerCase().localeCompare((b.name || b.file).toLowerCase());
        return d * sort.dir;
      });
      count.textContent = `${hits.length} of ${lib.entries.length}${hits.length > LIMIT ? ` — first ${LIMIT} shown, narrow it down` : ""}`;
      shown = hits.slice(0, LIMIT);
      list.replaceChildren(...shown.map((e) => h("div.font-item", {
        "data-key": `${e.file}#${e.index}`, onclick: () => { list.focus(); void show(e); }, ondblclick: () => void accept(),
      }, h("span", {}, e.name || e.file), h("span.muted", {}, e.type), h("span.muted.num", {}, String(e.height)), h("span.muted.file", {}, e.file))));
      const keep = chosen && shown.find((e) => e.file === chosen!.file && e.index === chosen!.index);
      if (keep) list.querySelector(`[data-key="${CSS.escape(`${keep.file}#${keep.index}`)}"]`)?.classList.add("selected");
      drawHead();
    };

    const drawHead = (): void => {
      const col = (key: SortKey, label: string, cls = ""): HTMLElement => h(`button.col${cls}${sort.by === key ? ".sorted" : ""}`, {
        title: `Sort by ${label.toLowerCase()}`,
        onclick: () => { sort = { by: key, dir: sort.by === key ? (sort.dir === 1 ? -1 : 1) : 1 }; fill(); },
      }, label, sort.by === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");
      head.replaceChildren(col("name", "Name"), col("type", "Type"), col("rows", "Rows", ".num"), col("file", "File", ".file"));
    };

    /** Up/Down step through the list (from the filter box or the list itself), previewing as they go. */
    const step = (dir: 1 | -1): void => {
      if (!shown.length) return;
      const i = chosen ? shown.findIndex((e) => e.file === chosen!.file && e.index === chosen!.index) : -1;
      const next = shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? (dir > 0 ? 0 : shown.length - 1) : i + dir))];
      void show(next);
      list.querySelector(`[data-key="${CSS.escape(`${next.file}#${next.index}`)}"]`)?.scrollIntoView({ block: "nearest" });
    };

    const accept = async (): Promise<void> => { if (chosen) close({ entry: chosen, bytes: await lib.bytes(chosen.file) }); };

    const body = lib.entries.length
      ? [h("div.row", {}, filter, h("span.muted", {}, "rows"), minH, "–", maxH, exact, count), head, list, preview]
      : [h("p", {}, "No TheDraw fonts found. Run ", h("code", {}, "node scripts/sync-fonts.mjs [path/to/tdfonts]"),
          " to copy them from a Synchronet install (ctrl/tdfonts), then reload.")];
    const backdrop = h("div.backdrop", {
      onclick: (e: Event) => { if (e.target === backdrop) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        const inNumber = e.target instanceof HTMLInputElement && e.target.type === "number";
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !inNumber) { e.preventDefault(); step(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter" && chosen && !inNumber) { e.preventDefault(); void accept(); }
        else if (e.key === "Escape") { e.preventDefault(); close(null); }
        e.stopPropagation();   // the editor's own shortcuts stay out of the dialog
      },
    },
      h("div.dialog.tdf-dialog", {}, h("h3", {}, "TheDraw font"), ...body,
        h("div.row.end", {}, h("button", { onclick: () => close(null) }, "Cancel"),
          h("button.primary", { onclick: () => void accept() }, "Use font"))));
    document.body.append(backdrop);
    fill();
    filter.focus();
  });
}

/**
 * A font of the same height as `height`, chosen at random — the size is the
 * point: a random font that also changes how tall the text is throws the
 * layout out and reads as a mistake rather than a suggestion. Avoids `notFile`
 * / `notIndex` so pressing it twice never gives you the same font back.
 */
export function randomFontOfHeight(lib: FontLibrary, height: number, notFile?: string, notIndex?: number): FontEntry | null {
  const pool = lib.entries.filter((e) => e.height === height && !(e.file === notFile && e.index === notIndex));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
