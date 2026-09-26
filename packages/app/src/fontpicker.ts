/**
 * Browsing the bitmap fonts, with your own picture in the preview.
 *
 * The font is the codepage: the same byte is a different character in each
 * one. Byte 225 is `ß` in an IBM font and `á` in an Amiga font, and Amiga
 * ASCII art is built out of 225 — so the same file is either a picture or a
 * wall of the wrong letter depending on the font, and no amount of staring at
 * a list of names tells you which. So the preview shows the document itself,
 * and under it the whole character set, where the codepages visibly differ.
 */
import {
  type BitmapFont, CellGrid, STANDARD_FONTS, type StandardFont, createRaster, renderGrid,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";
import type { FontStore } from "./fontstore.js";
import { h } from "./ui.js";

/** As much of the picture as fits the preview, taken from where the content is. */
function sampleOfDocument(ed: Editor, cols: number, rows: number): CellGrid | null {
  const src = ed.comp.grid;
  let top = -1, bottom = -1, left = src.width, right = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = y * src.width + x;
      const g = src.glyph[i];
      if (g === 32 || g === 0 || g === 255) continue;   // blank: not content
      if (top < 0) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top < 0) return null;
  const x0 = Math.max(0, Math.min(left, src.width - cols));
  const y0 = Math.max(0, Math.min(top, src.height - rows));
  const w = Math.min(cols, src.width - x0, Math.max(8, right - x0 + 1));
  const hgt = Math.min(rows, src.height - y0, Math.max(4, bottom - y0 + 1));
  return src.reframed({ x: x0, y: y0, width: w, height: hgt });
}

/** All 256 characters, so a codepage can be seen rather than taken on trust. */
function characterMap(): CellGrid {
  const grid = CellGrid.filled(32, 8, 32, 7, 0);
  for (let i = 0; i < 256; i++) grid.set(i % 32, Math.floor(i / 32), { glyph: i, fg: 7, bg: 0 });
  return grid;
}

function canvasOf(grid: CellGrid, font: BitmapFont, ninePx: boolean, palette: readonly (readonly [number, number, number])[]): HTMLCanvasElement {
  const raster = createRaster(grid.width, grid.height, font, ninePx);
  renderGrid(grid, font, raster, { palette, iceColors: true, letterSpacing9px: ninePx });
  const canvas = h("canvas.font-preview", { width: raster.width, height: raster.height });
  canvas.getContext("2d")!.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0);
  return canvas;
}

/**
 * Modal bitmap-font browser. Resolves with the chosen SAUCE font name, or null.
 * `current` is pre-selected so opening and cancelling changes nothing.
 */
export function pickBitmapFont(ed: Editor, store: FontStore, current: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: StandardFont | null = null;
    const list = h("div.font-list", { tabindex: 0 });
    const preview = h("div.font-preview-box");
    const filter = h("input", { type: "search", placeholder: "filter by name…", oninput: () => fill() });
    const count = h("span.muted");
    const note = h("p.hint");
    const close = (name: string | null): void => { backdrop.remove(); resolve(name); };

    const doc = sampleOfDocument(ed, 72, 20);
    const map = characterMap();
    const nine = ed.doc.letterSpacing9px;

    const show = async (f: StandardFont): Promise<void> => {
      chosen = f;
      list.querySelectorAll(".selected").forEach((n) => n.classList.remove("selected"));
      list.querySelector(`[data-key="${CSS.escape(f.name)}"]`)?.classList.add("selected");
      try {
        const font = await store.load(f.file);
        if (chosen !== f) return;   // arrowed past it while it loaded
        preview.replaceChildren(
          ...(doc ? [h("p.hint", {}, "your picture"), canvasOf(doc, font, nine, ed.doc.palette)] : []),
          h("p.hint", {}, doc ? "every character in this font" : "every character in this font — draw something and it previews here too"),
          canvasOf(map, font, nine, ed.doc.palette));
      } catch (err) {
        preview.replaceChildren(h("p.hint", {}, `Could not load ${f.name}: ${(err as Error).message}`));
      }
    };

    let shown: StandardFont[] = [];
    const fill = (): void => {
      const q = filter.value.trim().toLowerCase();
      const hits = STANDARD_FONTS.filter((f) => !q || f.name.toLowerCase().includes(q));
      count.textContent = `${hits.length} of ${STANDARD_FONTS.length}`;
      shown = hits;
      list.replaceChildren(...hits.map((f) => h("div.font-item", {
        "data-key": f.name, onclick: () => { list.focus(); void show(f); }, ondblclick: () => accept(),
      }, h("span", {}, f.name), h("span.muted", {}, `8×${f.height} · ${f.file.replace(/\.[^.]+$/, "")}`))));
      const keep = shown.find((f) => f.name === chosen?.name);
      if (keep) list.querySelector(`[data-key="${CSS.escape(keep.name)}"]`)?.classList.add("selected");
    };

    const step = (dir: 1 | -1): void => {
      if (!shown.length) return;
      const i = chosen ? shown.findIndex((f) => f.name === chosen!.name) : -1;
      const next = shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? (dir > 0 ? 0 : shown.length - 1) : i + dir))];
      void show(next);
      list.querySelector(`[data-key="${CSS.escape(next.name)}"]`)?.scrollIntoView({ block: "nearest" });
    };

    const accept = (): void => { if (chosen) close(chosen.name); };

    note.textContent = "The font is also the character set: the same byte is a different character in each one. Amiga art is built from characters that an IBM font spells differently, so if a file looks like the wrong letters repeated, it wants an Amiga font.";

    const backdrop = h("div.backdrop", {
      onclick: (e: Event) => { if (e.target === backdrop) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); step(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter" && chosen) { e.preventDefault(); accept(); }
        else if (e.key === "Escape") { e.preventDefault(); close(null); }
        e.stopPropagation();   // the editor's own shortcuts stay out of the dialog
      },
    },
      h("div.dialog.font-dialog", {}, h("h3", {}, "Font"), note,
        h("div.row", {}, filter, count), list, preview,
        h("div.row.end", {}, h("button", { onclick: () => close(null) }, "Cancel"),
          h("button.primary", { onclick: accept }, "Use font"))));
    document.body.append(backdrop);
    fill();
    const start = STANDARD_FONTS.find((f) => f.name.toLowerCase() === current.trim().toLowerCase()) ?? STANDARD_FONTS[0];
    void show(start);
    list.querySelector(`[data-key="${CSS.escape(start.name)}"]`)?.scrollIntoView({ block: "center" });
    filter.focus();
  });
}
