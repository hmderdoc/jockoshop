import {
  ART_EXTENSIONS, type CellsLayer, type Layer, addFontAsset, encodeBin, encodeCtrlA, encodeText, encodeTundra, encodeXbin, canvasResizeCommand, planDepth, composite, createCellsLayer, createDocument, createFontLayer, createRaster,
  documentFromArt, encodeAnsi, encodePng, layerFromArt, loadProject, parseArt, parseRawFont, refreshFontLayer,
  renderGrid, saveProject,
} from "@killerdraw/core";
import fontUrl from "../../core/assets/ibmstd.f16?url";
import { Editor } from "./editor.js";
import { FontLibrary } from "./fonts.js";
import { iconButton } from "./icons.js";
import { type FileIO, type Picked, fileIO } from "./io.js";
import { buildMenu } from "./menu.js";
import { buildLeft } from "./left.js";
import { buildRight } from "./right.js";
import { liveProp } from "./sections.js";
import { importImage, scheduleImageRefresh } from "./shadeans.js";
import { copySelection, cutSelection, deleteSelection, paste, selectAll, selectInverse, selectNone } from "./selectionops.js";
import { createSelectTools, createTools } from "./tools.js";
import { download, field, h } from "./ui.js";
import { CanvasView } from "./view.js";

const ART = ART_EXTENSIONS;

async function start(): Promise<void> {
  const font = parseRawFont(new Uint8Array(await (await fetch(fontUrl)).arrayBuffer()));
  const ed = new Editor(font);
  const io: FileIO = await fileIO();
  const lib = new FontLibrary();
  await lib.load();
  const tools = [...createTools(ed), ...createSelectTools(ed)];
  const currentTool = () => tools.find((t) => t.id === ed.tool)!;
  const view = new CanvasView(ed, currentTool);

  /** Add or remove rows and columns at any edge; at the top/left everything shifts along. */
  const canvasDialog = (): void => {
    const v = { top: 0, bottom: 0, left: 0, right: 0 };
    const result = h("p.hint");
    const show = (): void => { result.textContent = `${ed.doc.width}×${ed.doc.height}  →  ${ed.doc.width + v.left + v.right}×${ed.doc.height + v.top + v.bottom}`; };
    const input = (key: keyof typeof v): HTMLInputElement => {
      const el = h("input", { type: "number", value: "0", style: "width:70px", oninput: () => { v[key] = Math.round(Number(el.value)) || 0; show(); } });
      return el;
    };
    const close = (): void => backdrop.remove();
    const apply = (): void => {
      try {
        if (v.top || v.bottom || v.left || v.right) ed.run(canvasResizeCommand(ed.doc, v));
        close();
      } catch (err) { result.textContent = (err as Error).message; }
    };
    const backdrop = h("div.backdrop", { onclick: (e: Event) => { if (e.target === backdrop) close(); } },
      h("div.dialog", { style: "width:420px" }, h("h3", {}, "Canvas size"),
        h("p.hint", {}, "Rows and columns to add at each edge. Adding at the top or left shifts every layer down or right. Negative numbers crop — layers keep what falls outside, so nothing is lost."),
        h("div.row", {}, field("top (rows)", input("top")), field("bottom (rows)", input("bottom"))),
        h("div.row", {}, field("left (columns)", input("left")), field("right (columns)", input("right"))),
        result,
        h("div.row.end", {}, h("button", { onclick: close }, "Cancel"), h("button.primary", { onclick: apply }, "Apply"))));
    document.body.append(backdrop);
    show();
    backdrop.querySelector("input")?.focus();
  };

  const baseName = (): string => ed.fileName.replace(/\.[^.]+$/, "");
  const flat = () => composite(ed.doc, { glyphs: ed.glyphs }).grid;

  /** Open a picked file as the document: a project, or flat art as a one-layer document. */
  const openPicked = (file: Picked): void => {
    try {
      const project = /\.kdraw$/i.test(file.name);
      ed.setDocument(project ? loadProject(file.bytes) : documentFromArt(parseArt(file.bytes, file.name)), file.name, project ? file.path : undefined);
      ed.setStatus(`Opened ${file.name} — ${ed.doc.width}×${ed.doc.height}`);
    } catch (err) { ed.setStatus(`Could not open ${file.name}: ${(err as Error).message}`); }
  };

  const confirmDiscard = async (): Promise<boolean> => !ed.dirty || confirm(`“${ed.fileName}” has unsaved changes. Discard them?`);

  const openFile = async (): Promise<void> => {
    if (!(await confirmDiscard())) return;
    const file = await io.open(["kdraw", ...ART]);
    if (file) openPicked(file);
  };

  const importLayer = async (): Promise<void> => {
    const file = await io.open(ART);
    if (!file) return;
    try {
      const layer = layerFromArt(parseArt(file.bytes, file.name), file.name.replace(/\.[^.]+$/, ""));
      ed.addLayer(layer, "Import as layer");
      ed.setStatus(`Added ${file.name} as a layer. Its black areas are see-through via a key rule you can turn off.`);
    } catch (err) { ed.setStatus(`Could not import ${file.name}: ${(err as Error).message}`); }
  };

  const PROJECT = { name: "jockoshop project", extensions: ["kdraw"] };
  /** Save in place when the document has a path, else Save As. */
  const saveProjectFile = async (as = false): Promise<boolean> => {
    const bytes = saveProject(ed.doc);
    if (!as && await io.save(ed.filePath, bytes)) { ed.markSaved(); ed.setStatus(`Saved ${ed.fileName}`); return true; }
    const path = await io.saveAs(`${baseName()}.kdraw`, bytes, PROJECT);
    if (path === null) return false;
    if (path) { ed.filePath = path; ed.fileName = path.replace(/^.*[\\/]/, ""); }
    ed.markSaved();
    ed.setStatus(`Saved ${ed.fileName}`);
    return true;
  };
  const newDocument = async (): Promise<void> => { if (await confirmDiscard()) ed.setDocument(createDocument(80, 25), "untitled"); };

  io.onOpenRequest((files, at) => {
    // a project replaces the document; art and images become layers — an image lands where it was dropped
    const [first] = files;
    if (!first) return;
    void (async () => {
      if (/\.kdraw$/i.test(first.name)) { if (await confirmDiscard()) openPicked(first); return; }
      const cell = at ? view.cellAt(at.x, at.y) ?? undefined : undefined;
      for (const f of files) {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) { await importImage(ed, f.name, f.bytes, cell); continue; }
        try { ed.addLayer(layerFromArt(parseArt(f.bytes, f.name), f.name.replace(/\.[^.]+$/, "")), "Import as layer"); }
        catch (err) { ed.setStatus(`Could not import ${f.name}: ${(err as Error).message}`); }
      }
      if (files.length > 1 || cell) ed.setStatus(`Added ${files.length} layer(s)${cell ? ` at ${cell.x + 1},${cell.y + 1}` : ""}.`);
    })();
  });
  io.onCloseRequest(async () => {
    if (!ed.dirty) return true;
    const save = confirm(`Save changes to “${ed.fileName}” before closing?\n\nCancel keeps the window open; OK saves (or asks where to).`);
    if (!save) return confirm("Close without saving?");
    return saveProjectFile();
  });

  const exportOpts = () => ({
    iceColors: ed.doc.iceColors, palette: ed.doc.palette, sauce: ed.doc.sauce,
    fontName: ed.doc.fontName, letterSpacing9px: ed.doc.letterSpacing9px,
  });

  /** iCE changes how many background colours shadeans may use */
  const reconvertImages = (): void => {
    const walk = (layers: Layer[]): void => layers.forEach((l) => { if (l.type === "group") walk(l.children); else if (l.type === "image") void scheduleImageRefresh(ed, l); });
    walk(ed.doc.layers);
  };

  const size = h("span.row");
  const renderSize = (): void => size.replaceChildren(
    liveProp(ed, ed.doc, "width", "Canvas width", ed.doc.width, { min: 1, max: 500, width: 54 }, (v) => v ?? ed.doc.width),
    "×", liveProp(ed, ed.doc, "height", "Canvas height", ed.doc.height, { min: 1, max: 5000, width: 60 }, (v) => v ?? ed.doc.height),
    h("label.check", { title: "iCE colours: 16 background colours instead of blink" },
      h("input", { type: "checkbox", checked: ed.doc.iceColors, onchange: () => ed.setProps("iCE colours", ed.doc, { iceColors: !ed.doc.iceColors }, reconvertImages) }), "iCE"));

  const undoBtn = iconButton("undo", "Undo (Ctrl/Cmd+Z)", { onclick: () => ed.undo() });
  const redoBtn = iconButton("redo", "Redo (Ctrl/Cmd+Shift+Z)", { onclick: () => ed.redo() });
  const title = h("span.title");
  const zoom = h("button.ib.zoom", { title: "Zoom follows the window width. Click to switch between fit and manual (Cmd/Ctrl+0)", onclick: () => setZoomFit(!ed.zoomFit) });
  /** + and − step by 0.5 below 2× and by 1 above, and leave fit mode */
  const setZoom = (z: number): void => {
    ed.zoomFit = false;
    ed.zoom = Math.max(0.5, Math.min(6, Math.round(z * 2) / 2));
    view.paint(); renderBar(); ed.emit("scroll");
  };
  const setZoomFit = (fit: boolean): void => { ed.zoomFit = fit; if (fit) view.fitZoom(); view.paint(); renderBar(); ed.emit("scroll"); };
  const renderBar = (): void => {
    undoBtn.disabled = !ed.history.canUndo;
    redoBtn.disabled = !ed.history.canRedo;
    title.textContent = `${ed.fileName}${ed.dirty ? " •" : ""}`;
    title.title = ed.filePath ?? "";
    zoom.textContent = `${ed.zoomFit ? "fit " : ""}${ed.zoom}×`;
    zoom.classList.toggle("active", ed.zoomFit);
    io.setDirty(ed.dirty);
    io.setTitle(`${ed.dirty ? "• " : ""}${ed.fileName} — jockoshop`);
  };

  const exportPng = (): void => {
    const raster = createRaster(ed.doc.width, ed.doc.height, font, ed.doc.letterSpacing9px);
    renderGrid(flat(), font, raster, { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px });
    download(`${baseName()}.png`, encodePng(raster), "image/png");
  };
  const export3d = (): void => {
    const comp = composite(ed.doc, { glyphs: ed.glyphs }), plan = planDepth(comp);
    download(`${baseName()}-3d.ans`, encodeAnsi(comp.grid, { ...exportOpts(), depth: plan }));
    ed.setStatus(`Exported with ${plan.levels.length} depth layer(s)${plan.merged ? "; more than 16 depths were merged" : ""}${plan.clamped.length ? `; shown at the screen because text can't be in front of it: ${plan.clamped.join(", ")}` : ""}.`);
  };
  // export is one button with a small menu, instead of three buttons
  const item = (label: string, note: string, ext: string, make: () => Uint8Array, title?: string): HTMLElement =>
    h("button", { title, onclick: () => { try { download(`${baseName()}.${ext}`, make()); } catch (err) { ed.setStatus(`Export failed: ${(err as Error).message}`); } } }, label, h("span.muted", {}, note));
  const exportMenu = h("div.menu", { hidden: true },
    item(".ans", "ANSI + SAUCE", "ans", () => encodeAnsi(flat(), exportOpts())),
    h("button", { onclick: export3d, title: "CSI = … z depth tags; other terminals ignore them" }, "3dBBS .ans", h("span.muted", {}, "with depth layers")),
    item(".bin", "binary text (even width)", "bin", () => encodeBin(flat(), exportOpts())),
    item(".xb", "XBin, compressed", "xb", () => encodeXbin(flat(), { iceColors: ed.doc.iceColors, sauce: ed.doc.sauce })),
    item(".tnd", "TundraDraw, 24-bit", "tnd", () => encodeTundra(flat(), ed.doc.palette), "Every colour exact; TundraDraw and PabloDraw read it"),
    item(".msg", "Synchronet Ctrl-A", "msg", () => encodeCtrlA(flat(), ed.doc.palette), "Colour codes for message bodies and menus; PabloDraw reads it too"),
    item(".txt", "text, CP437", "txt", () => encodeText(flat(), "cp437"), "Characters only"),
    item(".utf8.txt", "text, UTF-8", "utf8.txt", () => encodeText(flat(), "utf8"), "Characters only, for anything modern"),
    h("button", { onclick: exportPng }, ".png", h("span.muted", {}, "picture")));
  const exportBtn = iconButton("export", "Export…", { onclick: (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; } });
  document.addEventListener("click", () => { exportMenu.hidden = true; });

  const topbar = h("header.topbar", {},
    h("strong.logo", {}, "jockoshop"),
    iconButton("new", "New document", { onclick: () => void newDocument() }),
    iconButton("open", "Open…", { tip: "a .kdraw project, or an .ans / .bin / .xb as a new document", onclick: () => void openFile() }),
    iconButton("importLayer", "Import as layer…", { tip: "add an .ans / .bin / .xb on top as a new layer", onclick: () => void importLayer() }),
    iconButton("save", io.desktop ? "Save project (Ctrl/Cmd+S)" : "Save project (Ctrl/Cmd+S)", { tip: io.desktop ? "in place; Shift-click for Save As" : "downloads a .kdraw — layers, live text and key rules stay editable", onclick: (e) => void saveProjectFile(e.shiftKey) }),
    h("span.menu-anchor", {}, exportBtn, exportMenu),
    h("span.sep"), undoBtn, redoBtn, h("span.sep"),
    h("button.ib", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)) }, "−"), zoom,
    h("button.ib", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)) }, "+"),
    h("span.sep"), size,
    iconButton("canvas", "Canvas size…", { tip: "add or remove rows / columns at any edge, including the top and left", onclick: canvasDialog }),
    h("span.grow"), title);

  const status = h("footer.status");
  const renderStatus = (): void => {
    const p = view.hoverCell, g = ed.comp.grid;
    let where = "";
    if (p && g.inBounds(p.x, p.y)) {
      const c = g.get(p.x, p.y), owner = ed.comp.owner[g.index(p.x, p.y)];
      where = `${p.x + 1},${p.y + 1}  char ${c.glyph}  fg ${c.fg < 16 ? c.fg : "rgb"}  bg ${c.bg < 16 ? c.bg : "rgb"}  from: ${owner < 0 ? "—" : ed.comp.layers[owner].name}`;
    }
    // the Type tool means something different on a live text layer
    const hint = ed.tool === "text" && ed.active?.type === "font"
      ? "Edit the text on the left — it re-renders as you type. Add a font switch to change fonts mid-string."
      : ed.tool === "text" && ed.active?.type === "prose"
        ? (ed.prose.layer ? "Typing into the prose frame. Esc stops editing." : "Click in the frame to place the caret. With Move, drag its edges to resize.")
      : ed.tool === "text" ? "Click to type cells (typewriter), or drag out a frame for reflowing prose."
      : ed.tool === "move" && ed.active?.type === "font" ? `${currentTool().hint} Double-click the text to edit it.` : currentTool().hint;
    status.replaceChildren(h("span", {}, ed.status || hint), h("span.grow"), h("span.muted", {}, where));
  };

  document.getElementById("app")!.append(topbar,
    h("main", {}, buildLeft(ed, tools, lib), view.root, buildRight(ed, view, lib)), status);

  ed.on("ui", () => { renderBar(); renderStatus(); });
  ed.on("doc", () => { renderBar(); renderSize(); renderStatus(); });
  ed.on("status", renderStatus);
  renderBar(); renderSize(); renderStatus();

  // pasting text into a prose layer being edited (replaces the selection, if any)
  let lastTextCopy = "";
  window.addEventListener("paste", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const text = e.clipboardData?.getData("text/plain") || lastTextCopy;
    if (typing || !ed.prose.layer || ed.tool !== "text" || !text) return;
    e.preventDefault();
    ed.prose.insert(text);
  });
  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") { if (typing) return; e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
    if (mod && e.key.toLowerCase() === "y") { if (typing) return; e.preventDefault(); ed.redo(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void saveProjectFile(e.shiftKey); return; }
    if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); void openFile(); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoomFit(true); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)); return; }
    if (mod && e.key === "-") { e.preventDefault(); setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)); return; }
    if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) { e.preventDefault(); void newDocument(); return; }
    if (typing) return;
    if (currentTool().keydown?.(e)) { e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    const editingProse = ed.prose.layer && ed.tool === "text";
    if (editingProse && mod && k === "a") { e.preventDefault(); ed.prose.selectAll(); return; }
    if (editingProse && mod && (k === "c" || k === "x")) {
      const text = ed.prose.selectedText();
      if (!text) return;
      e.preventDefault();
      lastTextCopy = text;
      navigator.clipboard?.writeText(text).catch(() => { /* no clipboard access: the in-app copy still pastes */ });
      if (k === "x") ed.prose.deleteSelection();
      ed.setStatus(`${k === "x" ? "Cut" : "Copied"} ${text.length} characters.`);
      return;
    }
    if (mod && k === "a") { e.preventDefault(); selectAll(ed); return; }
    if (mod && k === "d") { e.preventDefault(); selectNone(ed); return; }
    if (mod && e.shiftKey && k === "i") { e.preventDefault(); selectInverse(ed); return; }
    if (mod && k === "c") { e.preventDefault(); copySelection(ed, e.shiftKey); return; }
    if (mod && k === "x") { e.preventDefault(); cutSelection(ed); return; }
    if (mod && k === "v") { if (ed.prose.layer && ed.tool === "text") return; e.preventDefault(); paste(ed); return; }   // text paste arrives as a paste event
    if ((e.key === "Delete" || e.key === "Backspace") && ed.selection) { e.preventDefault(); deleteSelection(ed); return; }
    if (e.key === "Escape" && ed.selection) { selectNone(ed); return; }
    if (mod) return;
    const shade = ["F1", "F2", "F3", "F4"].indexOf(e.key);
    if (shade >= 0) { e.preventDefault(); ed.glyph = [176, 177, 178, 219][shade]; ed.emit("ui"); return; }
    const tool = tools.find((t) => t.key === e.key.toLowerCase());
    if (tool) ed.chooseTool(tool.id);
  });

  // ?demo builds a small layered document, so there is something to look at straight away
  if (new URLSearchParams(location.search).has("demo")) await loadDemo(ed, lib);
  if (io.desktop) {
    await buildMenu({
      newDocument, open: openFile, importLayer, save: () => saveProjectFile(), saveAs: () => saveProjectFile(true),
      exportAns: () => download(`${baseName()}.ans`, encodeAnsi(flat(), exportOpts())), exportPng, export3d,
      exportMore: () => { exportMenu.hidden = false; },
      undo: () => ed.undo(), redo: () => ed.redo(),
      selectAll: () => selectAll(ed), selectNone: () => selectNone(ed), selectInverse: () => selectInverse(ed),
      copy: () => void copySelection(ed), cut: () => cutSelection(ed), paste: () => paste(ed), deleteSel: () => deleteSelection(ed),
      zoomIn: () => setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)), zoomOut: () => setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)),
      zoomFit: () => setZoomFit(true), canvasSize: canvasDialog,
    });
  }
  (window as unknown as { kd: unknown }).kd = { ed, tools, view, lib, io };
}

async function loadDemo(ed: Editor, lib: FontLibrary): Promise<void> {
  const doc = createDocument(80, 25);
  const bg = doc.layers[0] as CellsLayer;
  bg.name = "backdrop";
  for (let y = 0; y < 25; y++) {
    for (let x = 0; x < 80; x++) {
      const t = (x + y * 2) % 24;
      bg.grid.set(x, y, { glyph: [176, 177, 178, 177][(x + y) % 4], fg: t < 8 ? 1 : t < 16 ? 9 : 3, bg: t < 12 ? 0 : 1 });
    }
  }
  const stamp = createCellsLayer("stamp (keyed)", 30, 5);
  stamp.x = 46; stamp.y = 18;
  stamp.grid = ((): typeof stamp.grid => { const g = stamp.grid; for (let i = 0; i < g.present.length; i++) g.setAt(i, { glyph: 32, fg: 7, bg: 0 }); return g; })();
  [..."layers + key rules"].forEach((ch, i) => stamp.grid.set(2 + i, 2, { glyph: ch.charCodeAt(0), fg: 14, bg: 0 }));
  stamp.keys = [{ match: { appearsSolid: 0 }, drop: "cell", enabled: true }];
  doc.layers.push(stamp);

  const entry = lib.entries.find((e) => e.file === "1911.tdf") ?? lib.entries.find((e) => e.height >= 6 && e.height <= 10);
  if (entry) {
    const text = createFontLayer("title (live text)", addFontAsset(doc, entry.file, await lib.bytes(entry.file)), "KILLER", entry.index);
    text.x = 4; text.y = 3;
    refreshFontLayer(doc, text);
    doc.layers.push(text);
  }
  bg.depth = -300;
  stamp.depth = -120;
  ed.setDocument(doc, "demo");
}

void start();
