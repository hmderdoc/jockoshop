import {
  ART_EXTENSIONS, type AspectRatio, aspectStretch, CP437_UNICODE, type CellsLayer, EMBEDDED_FONT_ASSET, type Layer, addFontAsset, encodeBin, encodeCtrlA, encodeText, encodeTundra, encodeXbin, canvasResizeCommand, planDepth, composite, createCellsLayer, createDocument, createFontLayer, createRaster,
  deviceShiftPx, documentFromArt, encodeAnsi, encodePng, layerFromArt, loadProject, parseArt, parseRawFont, refreshFontLayer,
  renderDepthView, renderGrid, saveProject, standardFont, stretchRows,
} from "@killerdraw/core";
import fontUrl from "../../core/assets/ibmstd.f16?url";
import welcomeUrl from "../assets/monke.jock?url";
import { Editor } from "./editor.js";
import { FontLibrary } from "./fonts.js";
import { FontStore } from "./fontstore.js";
import { CHARSETS, CHARSET_NAMES } from "./charsets.js";
import { iconButton } from "./icons.js";
import { type FileIO, type Picked, fileIO } from "./io.js";
import { buildMenu } from "./menu.js";
import { confirmUnsaved, sauceDialog, shortcutSheet, wiggleDialog } from "./dialogs.js";
import { JointClient } from "./joint.js";
import { jointDialog, jointPanel } from "./jointui.js";
import { pickBitmapFont } from "./fontpicker.js";
import { type Binding, indexBindings, lookup } from "./keymap.js";
import { buildLeft } from "./left.js";
import { buildRight } from "./right.js";
import { liveProp, setBrushSize } from "./sections.js";
import { importImage, scheduleImageRefresh } from "./shadeans.js";
import { copySelection, cutSelection, deleteSelection, paste, selectAll, selectInverse, selectNone } from "./selectionops.js";
import { createSelectTools, createTools, pickUp } from "./tools.js";
import { colorName, download, field, glyphLabel, h } from "./ui.js";
import { CanvasView } from "./view.js";

const ART = ART_EXTENSIONS;
/** project files: .jock, and .kdraw from before the rename */
const PROJECT_EXTENSIONS = ["jock", "kdraw"];
const isProject = (name: string): boolean => /\.(jock|kdraw)$/i.test(name);

async function start(): Promise<void> {
  const font = parseRawFont(new Uint8Array(await (await fetch(fontUrl)).arrayBuffer()));
  const fonts = new FontStore(font);
  const ed = new Editor(font);
  const io: FileIO = await fileIO();
  const lib = new FontLibrary();
  await lib.load();
  const tools = [...createTools(ed), ...createSelectTools(ed)];
  const currentTool = () => tools.find((t) => t.id === ed.tool)!;
  const view = new CanvasView(ed, currentTool);
  // collaboration: the client drives the document through the Editor's events, the panel floats over the canvas
  const joint = new JointClient(ed, view);
  ed.joint = joint;
  const panel = jointPanel(ed, joint);
  const openJoint = (): void => {
    if (joint.connected || joint.connecting) panel.toggle();
    else jointDialog(joint, () => panel.show());
  };

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
  // the live composite: it also carries the re-matched cells of translucent layers
  const flat = () => ed.comp.grid;

  /**
   * Art that carries no SAUCE record says nothing about its font, and plain
   * text never does — so it is drawn in IBM VGA, which is right for most of it
   * and wrong for Amiga art, where the same bytes are different characters.
   * Worth a word when the picture leans on the range the codepages disagree
   * about, rather than letting it look broken.
   */
  const fontHint = (art: { sauce: { fontName: string } | null }): string => {
    if (art.sauce?.fontName.trim()) return "";
    let high = 0;
    const g = ed.comp.grid;
    for (let i = 0; i < g.glyph.length; i++) if (g.glyph[i] > 127) high++;
    return high > g.glyph.length / 50 ? " It names no font, so it is drawn in IBM VGA — if that is Amiga art, pick an Amiga font from the top bar." : "";
  };

  /** Open a picked file as the document: a project, or flat art as a one-layer document. */
  const openPicked = (file: Picked): void => {
    try {
      const project = isProject(file.name);
      const art = project ? null : parseArt(file.bytes, file.name);
      ed.setDocument(art ? documentFromArt(art) : loadProject(file.bytes), file.name, project ? file.path : undefined);
      remember(file.path);
      ed.setStatus(`Opened ${file.name} — ${ed.doc.width}×${ed.doc.height}.${art ? fontHint(art) : ""}`);
    } catch (err) { ed.setStatus(`Could not open ${file.name}: ${(err as Error).message}`); }
  };

  /** About to lose the document: save first, go ahead, or don't. `what` finishes "before …". */
  const confirmDiscard = async (what: string): Promise<boolean> => {
    // in a joint, a replaced document is pushed into the room: everyone's canvas becomes this one
    if (joint.connected && !confirm(`You are in joint ${joint.path}. The document you open or create here is pushed into the room, replacing its canvas for everyone. Continue?`)) return false;
    if (!ed.dirty) return true;
    const choice = await confirmUnsaved(ed.fileName, what);
    if (choice !== "save") return choice === "discard";
    return saveProjectFile();   // a cancelled Save As means the whole thing is off
  };

  const openFile = async (): Promise<void> => {
    if (!(await confirmDiscard("opening another file"))) return;
    const file = await io.open([...PROJECT_EXTENSIONS, ...ART]);
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

  const PROJECT = { name: "jockoshop project", extensions: ["jock"] };
  /** Save in place when the document has a path, else Save As. */
  const saveProjectFile = async (as = false): Promise<boolean> => {
    const bytes = saveProject(ed.doc);
    if (!as && await io.save(ed.filePath, bytes)) { ed.markSaved(); ed.setStatus(`Saved ${ed.fileName}`); return true; }
    const path = await io.saveAs(`${baseName()}.jock`, bytes, PROJECT);
    if (path === null) return false;
    if (path) { ed.filePath = path; ed.fileName = path.replace(/^.*[\\/]/, ""); }
    remember(ed.filePath);
    ed.markSaved();
    ed.setStatus(`Saved ${ed.fileName}`);
    return true;
  };
  const newDocument = async (): Promise<void> => {
    if (!await confirmDiscard("starting a new document")) return;
    ed.setDocument(createDocument(80, 25), "untitled");
    ed.emit("preview", "flat");   // the welcome piece's wiggle ends where your own work begins
  };

  io.onOpenRequest((files, at) => {
    // a project replaces the document; art and images become layers — an image lands where it was dropped
    const [first] = files;
    if (!first) return;
    void (async () => {
      if (isProject(first.name)) { if (await confirmDiscard(`opening “${first.name}”`)) openPicked(first); return; }
      const cell = at ? view.cellAt(at.x, at.y) ?? undefined : undefined;
      for (const f of files) {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) { await importImage(ed, f.name, f.bytes, cell); continue; }
        try {
          const layer = layerFromArt(parseArt(f.bytes, f.name), f.name.replace(/\.[^.]+$/, ""));
          if (cell) { layer.x = cell.x; layer.y = cell.y; }
          ed.addLayer(layer, "Import as layer");
        }
        catch (err) { ed.setStatus(`Could not import ${f.name}: ${(err as Error).message}`); }
      }
      if (files.length > 1 || cell) ed.setStatus(`Added ${files.length} layer(s)${cell ? ` at ${cell.x + 1},${cell.y + 1}` : ""}.`);
    })();
  });
  io.onCloseRequest(async () => {
    if (!ed.dirty) return true;
    const choice = await confirmUnsaved(ed.fileName, "closing");
    if (choice !== "save") return choice === "discard";
    return saveProjectFile();
  });

  const exportOpts = () => ({
    iceColors: ed.doc.iceColors, palette: ed.doc.palette, sauce: ed.doc.sauce,
    fontName: ed.doc.fontName, letterSpacing9px: ed.doc.letterSpacing9px, aspectRatio: ed.doc.aspectRatio,
  });

  /**
   * Follow the font the document asks for. Cheap to call on every change: it
   * only fetches when the answer would differ from what is already drawn.
   */
  let fontKey = "";
  const syncFont = async (force = false): Promise<void> => {
    const key = FontStore.key(ed.doc);
    if (key === fontKey && !force) return;
    fontKey = key;
    const { font: next, note } = await fonts.forDocument(ed.doc);
    if (FontStore.key(ed.doc) !== key) return;   // the document moved on while we fetched
    ed.setFont(next);
    if (note) ed.setStatus(note);
  };

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
      h("input", { type: "checkbox", checked: ed.doc.iceColors, onchange: () => ed.setProps("iCE colours", ed.doc, { iceColors: !ed.doc.iceColors }, reconvertImages) }), "iCE"),
    h("label.check", { title: "9-pixel cells, as VGA text mode drew them: every cell is a pixel wider, and the 9th column repeats the 8th for the box-drawing and block characters (CP437 192-223) so ─── and ███ join up. Recorded in SAUCE." },
      h("input", { type: "checkbox", checked: ed.doc.letterSpacing9px, onchange: () => ed.setProps("9px letter spacing", ed.doc, { letterSpacing9px: !ed.doc.letterSpacing9px }) }), "9px"));

  /**
   * The bitmap font: what the art is drawn in, and what SAUCE records. It
   * opens a browser rather than a list of 86 names, because the font is also
   * the character set — the only way to tell which one a file wants is to see
   * the file in it.
   */
  const fontPick = h("span.row");
  const browseFonts = async (): Promise<void> => {
    const picked = await pickBitmapFont(ed, fonts, ed.doc.fontName);
    if (picked && picked !== ed.doc.fontName) ed.setProps("Font", ed.doc, { fontName: picked });
  };
  const renderFont = (): void => {
    if (ed.doc.assets.has(EMBEDDED_FONT_ASSET)) {
      fontPick.replaceChildren(h("span.muted.font-embedded", { title: "This file carries its own font bitmap, which is what it is drawn in. Remove it to choose a standard font." }, "font: embedded"));
      return;
    }
    const known = standardFont(ed.doc.fontName);
    fontPick.replaceChildren(h("button.font-pick", {
      title: known
        ? `Drawn in ${known.name}, 8×${known.height}. Click to browse the fonts with this picture in the preview.`
        : `“${ed.doc.fontName}” is not a font jockoshop has, so this is drawn in IBM VGA. The name is kept for export. Click to choose one.`,
      onclick: () => void browseFonts(),
    }, known ? known.name : `${ed.doc.fontName} ⚠`));
  };

  /**
   * The shape the art's pixels were meant to be. Art drawn for a 4:3 screen is
   * squat on square pixels until it is stretched; SAUCE records which was meant.
   */
  const aspectPick = h("span.row");
  const renderAspect = (): void => {
    const select = h("select", {
      title: "How the picture is shown, and what SAUCE records: art drawn for a 4:3 CRT needs stretching vertically to look the way it was drawn",
      onchange: () => ed.setProps("Aspect ratio", ed.doc, { aspectRatio: select.value as AspectRatio }),
    });
    for (const [v, label, tip] of [
      ["none", "as drawn", "No preference recorded: one cell, one pixel grid, no stretching"],
      ["stretch", "4:3 CRT", "Drawn for a CRT: stretched vertically so it looks the way it did there"],
      ["square", "square", "Drawn for square pixels: shown as it is, and SAUCE says so"],
    ] as const) select.append(h("option", { value: v, selected: ed.doc.aspectRatio === v, title: tip }, label));
    select.className = "aspect-pick";
    aspectPick.replaceChildren(select);
  };

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
    jointBtn.classList.toggle("active", joint.connected);
    io.setDirty(ed.dirty);
    io.setTitle(`${ed.dirty ? "• " : ""}${ed.fileName} — jockoshop`);
  };

  const exportPng = (): void => {
    const raster = createRaster(ed.doc.width, ed.doc.height, ed.font, ed.doc.letterSpacing9px);
    renderGrid(flat(), ed.font, raster, { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px });
    // art drawn for a 4:3 screen is exported the way it is shown, stretched back out
    const out = ed.doc.aspectRatio === "stretch" ? stretchRows(raster, aspectStretch(ed.doc.letterSpacing9px)) : raster;
    download(`${baseName()}.png`, encodePng(out), "image/png");
  };
  const export3d = (): void => {
    const comp = ed.comp, plan = planDepth(comp);
    download(`${baseName()}-3d.ans`, encodeAnsi(comp.grid, { ...exportOpts(), depth: plan }));
    ed.setStatus(`Exported with ${plan.levels.length} depth layer(s)${plan.merged ? "; more than 16 depths were merged" : ""}${plan.front.length ? `; in front of the screen (3dBBS 0.4; older shows them at the screen): ${plan.front.join(", ")}` : ""}.`);
  };
  /** One eye's view of the depth layers, as the preview draws it: `eye` −1 … 1, at the device's full slider. */
  const depthFrame = (eye: number): ReturnType<typeof createRaster> => {
    const comp = ed.comp, plan = planDepth(comp);
    const raster = createRaster(ed.doc.width, ed.doc.height, ed.font, ed.doc.letterSpacing9px);
    renderDepthView(comp, plan, ed.font, raster, eye * deviceShiftPx(1e9), { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px });
    return raster;
  };
  const flatDepths = (): boolean => planDepth(ed.comp).levels.every((d) => d === 0);
  // the wiggle: a dialog that previews the animation and tunes it before saving
  const exportWiggle = (): void => wiggleDialog(ed, baseName());
  const exportAnaglyph = (): void => {
    const L = depthFrame(-1), R = depthFrame(1);
    for (let i = 0; i < L.data.length; i += 4) { L.data[i + 1] = R.data[i + 1]; L.data[i + 2] = R.data[i + 2]; }   // red = left eye, cyan = right
    download(`${baseName()}-anaglyph.png`, encodePng(L), "image/png");
    if (flatDepths()) ed.setStatus("Exported — but every layer is at the glass, so there is no depth in it. Give a layer some depth (right sidebar).");
  };
  // export is one button with a small menu, instead of three buttons
  const item = (label: string, note: string, ext: string, make: () => Uint8Array, title?: string): HTMLElement =>
    h("button", { title, onclick: () => { try { download(`${baseName()}.${ext}`, make()); } catch (err) { ed.setStatus(`Export failed: ${(err as Error).message}`); } } }, label, h("span.muted", {}, note));
  const exportMenu = h("div.menu", { hidden: true },
    item(".ans", "ANSI + SAUCE", "ans", () => encodeAnsi(flat(), exportOpts())),
    h("button", { onclick: export3d, title: "CSI = … z depth tags; other terminals ignore them" }, "3dBBS .ans", h("span.muted", {}, "with depth layers")),
    item(".bin", "binary text (even width)", "bin", () => encodeBin(flat(), exportOpts())),
    // XBIN is the format that carries its own font, which is the point of choosing
    // it: the file opens in the font it was drawn in, whatever the viewer defaults to
    item(".xb", "XBin, compressed", "xb", () => encodeXbin(flat(), { iceColors: ed.doc.iceColors, sauce: ed.doc.sauce, fontBytes: ed.font.glyphs })),
    item(".tnd", "TundraDraw, 24-bit", "tnd", () => encodeTundra(flat(), ed.doc.palette), "Every colour exact; TundraDraw and PabloDraw read it"),
    item(".msg", "Synchronet Ctrl-A", "msg", () => encodeCtrlA(flat(), ed.doc.palette), "Colour codes for message bodies and menus; PabloDraw reads it too"),
    item(".txt", "text, CP437", "txt", () => encodeText(flat(), "cp437"), "Characters only"),
    item(".utf8.txt", "text, UTF-8", "utf8.txt", () => encodeText(flat(), "utf8"), "Characters only, for anything modern"),
    h("button", { onclick: exportPng }, ".png", h("span.muted", {}, "picture")),
    h("button", { onclick: exportWiggle, title: "An animated PNG that rocks between the two eyes' views of the depth layers — previewed and tuned before it saves" }, "3D wiggle .png…", h("span.muted", {}, "animated")),
    h("button", { onclick: exportAnaglyph, title: "The depth layers as a red / cyan stereo picture, for anaglyph glasses" }, "3D red/cyan .png", h("span.muted", {}, "anaglyph")));
  const exportBtn = iconButton("export", "Export…", { onclick: (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; } });
  document.addEventListener("click", () => { exportMenu.hidden = true; });

  // recent files (desktop: paths that can be reopened)
  const RECENT_KEY = "jockoshop.recent";
  const recents = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]; } catch { return []; } };
  const remember = (path: string | undefined): void => {
    if (!path) return;
    const list = [path, ...recents().filter((p) => p !== path)].slice(0, 10);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private mode */ }
    renderRecent();
  };
  const recentMenu = h("div.menu", { hidden: true });
  const renderRecent = (): void => {
    const list = recents();
    recentMenu.replaceChildren(...(list.length ? list.map((p) => h("button", { title: p, onclick: async () => { if (await confirmDiscard(`opening “${p.replace(/^.*[\\/]/, "")}”`)) { try { openPicked(await io.readPath(p)); } catch (err) { ed.setStatus(`Could not open ${p}: ${(err as Error).message}`); } } } }, p.replace(/^.*[\\/]/, ""), h("span.muted", {}, p.replace(/[\\/][^\\/]*$/, "").slice(-28)))) : [h("span.muted", { style: "padding:4px 8px" }, "nothing yet")]),
      h("button", { onclick: () => { try { localStorage.removeItem(RECENT_KEY); } catch { /* */ } renderRecent(); } }, "clear"));
  };
  renderRecent();
  const recentBtn = iconButton("recent", "Open recent…", { onclick: (e) => { e.stopPropagation(); recentMenu.hidden = !recentMenu.hidden; } });
  document.addEventListener("click", () => { recentMenu.hidden = true; });

  const jointBtn = iconButton("joint", "joint", { tip: "draw together on a Moebius collaboration server (Ctrl/Cmd+J)", onclick: openJoint });
  const mirrorBtn = iconButton("mirror", "Mirror mode (X)", { tip: "every stroke is repeated across the canvas centre; Shift-click for top/bottom", onclick: (e) => toggleMirror(e.shiftKey ? "y" : "x") });
  const toggleMirror = (axis: "x" | "y"): void => {
    if (axis === "x") ed.mirrorX = !ed.mirrorX; else ed.mirrorY = !ed.mirrorY;
    mirrorBtn.classList.toggle("active", ed.mirrorX || ed.mirrorY);
    ed.setStatus(ed.mirrorX || ed.mirrorY ? `Mirror: ${[ed.mirrorX && "left ↔ right", ed.mirrorY && "top ↕ bottom"].filter(Boolean).join(", ")}` : "Mirror off");
    ed.emit("ui");
  };

  const topbar = h("header.topbar", {},
    h("strong.logo", {}, "jockoshop"),
    iconButton("new", "New document", { onclick: () => void newDocument() }),
    iconButton("open", "Open…", { tip: "a .jock project, or an .ans / .bin / .xb as a new document (drop a file on the window to add it as a layer instead)", onclick: () => void openFile() }),
    ...(io.desktop ? [h("span.menu-anchor", {}, recentBtn, recentMenu)] : []),
    iconButton("importLayer", "Import as layer…", { tip: "add an .ans / .bin / .xb on top as a new layer", onclick: () => void importLayer() }),
    iconButton("save", "Save project (Ctrl/Cmd+S)", { tip: io.inPlace ? "in place; Shift-click for Save As" : "downloads a .jock — layers, live text and key rules stay editable", onclick: (e) => void saveProjectFile(e.shiftKey) }),
    h("span.menu-anchor", {}, exportBtn, exportMenu),
    h("span.sep"), undoBtn, redoBtn, h("span.sep"),
    h("button.ib", { title: "Zoom out", "aria-label": "Zoom out", onclick: () => setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)) }, "−"), zoom,
    h("button.ib", { title: "Zoom in", "aria-label": "Zoom in", onclick: () => setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)) }, "+"),
    h("span.sep"), size, fontPick, aspectPick,
    iconButton("canvas", "Canvas size…", { tip: "add or remove rows / columns at any edge, including the top and left", onclick: canvasDialog }),
    iconButton("sauce", "SAUCE…", { tip: "title, author, group, comments, font", onclick: () => sauceDialog(ed) }),
    h("span.sep"), jointBtn, mirrorBtn,
    h("span.grow"), title);

  /** F1–F10: type the set's glyph where typing is happening, else make it the brush character. */
  const typeSetGlyph = (slot: number): void => {
    const code = CHARSETS[ed.charset][slot];
    if (currentTool().typeGlyph?.(code)) return;
    ed.setBrush({ glyph: code });
    ed.emit("ui");
    ed.setStatus(`Brush character: ${glyphLabel(code)} (F${slot + 1} of set ${ed.charset + 1}, ${CHARSET_NAMES[ed.charset]})`);
  };
  const announceCharset = (): void => {
    ed.setStatus(`Character set ${ed.charset + 1}/${CHARSETS.length}: ${CHARSET_NAMES[ed.charset]}`);
    ed.emit("ui");
  };
  const cycleCharset = (dir: 1 | -1): void => {
    ed.charset = (ed.charset + dir + CHARSETS.length) % CHARSETS.length;
    announceCharset();
  };
  /** Moebius's Alt+F1..F10 (and Alt+Shift for the second ten): straight to a set. */
  const chooseCharset = (n: number): void => {
    if (n < 0 || n >= CHARSETS.length) { ed.setStatus(`There are ${CHARSETS.length} character sets.`); return; }
    ed.charset = n;
    announceCharset();
  };
  /** The F-key bar shown in the footer while the Type tool is active: [F11 ◄] F1░ … F10· [F12 ►] 6/16 */
  const charsetBar = (): HTMLElement => {
    const set = CHARSETS[ed.charset];
    const glyph = (c: number): string => String.fromCodePoint(CP437_UNICODE[c]);
    return h("span.fkeys", {},
      h("button.fkey.arrow", { title: "Previous character set (F11, Ctrl+,)", onclick: () => cycleCharset(-1) }, "F11 ◄"),
      ...set.map((c, i) => h("button.fkey", { title: `F${i + 1}: ${glyphLabel(c)}`, onclick: () => typeSetGlyph(i) }, h("kbd", {}, `F${i + 1}`), h("span.g", {}, glyph(c)))),
      h("button.fkey.arrow", { title: "Next character set (F12, Ctrl+.)", onclick: () => cycleCharset(1) }, "F12 ►"),
      h("span.muted", { title: CHARSET_NAMES[ed.charset] }, `${ed.charset + 1}/${CHARSETS.length} ${CHARSET_NAMES[ed.charset]}`));
  };

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
    // under the Type tool the F-key bar stays put; messages appear beside it and the long hint is dropped
    status.replaceChildren(
      ...(ed.tool === "text" ? [charsetBar(), ed.status && h("span.muted.beside", {}, ed.status)] : [h("span", {}, ed.status || hint)]).filter((n): n is HTMLElement => !!n),
      h("span.grow"),
      ...(joint.connected ? [h("span.muted", { title: `${joint.url} — ${joint.sentDraws} cells sent, ${joint.receivedDraws} received` }, `joint ${joint.path} · ${joint.users.length + 1} here`)] : []),
      h("span.muted", {}, where));
  };

  document.getElementById("app")!.append(topbar,
    h("main", {}, buildLeft(ed, tools, lib), view.root, buildRight(ed, view, lib)), status);

  ed.on("ui", () => { renderBar(); renderStatus(); });
  ed.on("doc", () => { renderBar(); renderSize(); renderFont(); renderAspect(); renderStatus(); void syncFont(); });
  ed.on("status", renderStatus);
  renderBar(); renderSize(); renderFont(); renderAspect(); renderStatus();
  await syncFont(true);

  // pasting text into a prose layer being edited (replaces the selection, if any)
  let lastTextCopy = "";
  window.addEventListener("paste", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const text = e.clipboardData?.getData("text/plain") || lastTextCopy;
    if (typing || !ed.prose.layer || ed.tool !== "text" || !text) return;
    e.preventDefault();
    ed.prose.insert(text);
  });
  /**
   * Every shortcut, as data. The sheet under "?" is generated from this table,
   * so it cannot drift from what the keys do.
   *
   * `moebius: true` marks the ones that are Moebius's own key, which is the
   * point: an artist who draws with keys already has those in their fingers.
   * Where the two disagreed, Moebius wins for anything used while drawing —
   * Cmd+D is Default Colour here, not Deselect (Escape still deselects), and
   * Cmd+E is iCE colours, not Export.
   */
  const editingProse = (): boolean => !!ed.prose.layer && ed.tool === "text";
  const bindings: Binding[] = [
    // --- file
    { combo: "mod+n", label: "New document", group: "File", run: () => void newDocument() },
    { combo: "mod+o", label: "Open…", group: "File", run: () => void openFile() },
    { combo: "mod+s", label: "Save", group: "File", run: () => void saveProjectFile(false) },
    { combo: "mod+shift+s", label: "Save As…", group: "File", run: () => void saveProjectFile(true) },
    { combo: "mod+j", label: "Joint (collaborate)…", group: "File", run: () => openJoint() },
    { combo: "mod+i", label: "SAUCE info…", group: "File", moebius: true, run: () => sauceDialog(ed) },
    { combo: "mod+alt+c", label: "Canvas size…", group: "File", moebius: true, run: () => canvasDialog() },

    // --- edit
    { combo: "mod+z", label: "Undo", group: "Edit", moebius: true, run: () => ed.undo() },
    { combo: ["mod+shift+z", "mod+y"], label: "Redo", group: "Edit", moebius: true, run: () => ed.redo() },
    { combo: "mod+x", label: "Cut", group: "Edit", moebius: true, run: () => { if (!cutProseText("x")) cutSelection(ed); } },
    { combo: "mod+c", label: "Copy", group: "Edit", moebius: true, run: () => { if (!cutProseText("c")) void copySelection(ed, false); } },
    { combo: "mod+shift+c", label: "Copy merged", group: "Edit", run: () => void copySelection(ed, true) },
    { combo: "mod+v", label: "Paste as layer", group: "Edit", moebius: true, when: () => !editingProse(), run: () => paste(ed) },
    { combo: ["delete", "backspace"], label: "Delete selection", group: "Edit", when: () => !!ed.selection, run: () => deleteSelection(ed) },
    { combo: "mod+t", label: "Free transform", group: "Edit", run: () => {
      if (ed.chooseTool("move")) ed.setStatus(ed.selection ? "Free transform: drag a handle to scale the selected cells, inside to move them." : "Free transform: drag a handle to scale, inside to move.");
    } },
    { combo: ["mod+alt+m", "x"], label: "Mirror mode (left/right)", group: "Edit", moebius: true, run: () => toggleMirror("x") },
    { combo: "shift+x", label: "Mirror mode (top/bottom)", group: "Edit", run: () => toggleMirror("y") },

    // --- selection
    { combo: "mod+a", label: "Select all", group: "Select", moebius: true, run: () => { if (editingProse()) ed.prose.selectAll(); else selectAll(ed); } },
    { combo: "escape", label: "Deselect", group: "Select", when: () => !!ed.selection, run: () => selectNone(ed) },
    { combo: "mod+shift+i", label: "Invert selection", group: "Select", run: () => selectInverse(ed) },

    // --- colour: the heart of drawing with keys, all of it Moebius's
    ...Array.from({ length: 8 }, (_, n): Binding => ({
      combo: `ctrl+${n}`, label: n === 0 ? "Foreground colour (again for bright)" : "", group: "Colour", moebius: true, run: () => ed.toggleFg(n),
    })),
    ...Array.from({ length: 8 }, (_, n): Binding => ({
      combo: `alt+${n}`, label: n === 0 ? "Background colour (again for bright)" : "", group: "Colour", moebius: true, run: () => ed.toggleBg(n),
    })),
    { combo: "ctrl+arrowup", label: "Previous foreground colour", group: "Colour", moebius: true, run: () => ed.stepFg(-1) },
    { combo: "ctrl+arrowdown", label: "Next foreground colour", group: "Colour", moebius: true, run: () => ed.stepFg(1) },
    { combo: "ctrl+arrowleft", label: "Previous background colour", group: "Colour", moebius: true, run: () => ed.stepBg(-1) },
    { combo: "ctrl+arrowright", label: "Next background colour", group: "Colour", moebius: true, run: () => ed.stepBg(1) },
    { combo: "mod+d", label: "Default colour (grey on black)", group: "Colour", moebius: true, run: () => ed.defaultColors() },
    { combo: "mod+shift+x", label: "Swap foreground / background", group: "Colour", moebius: true, run: () => ed.swapColors() },
    { combo: "alt+u", label: "Take the colours under the cursor", group: "Colour", moebius: true, run: () => {
      const p = view.hoverCell;
      if (p) { pickUp(ed, p.x, p.y); ed.setStatus(`Brush: ${glyphLabel(ed.glyph)} ${colorName(ed.fg)} on ${colorName(ed.bg)}`); }
      else ed.setStatus("Point at a cell to take its colours.");
    } },

    // --- characters
    ...Array.from({ length: 10 }, (_, n): Binding => ({
      combo: `f${n + 1}`, label: n === 0 ? "Type character 1–10 of the set" : "", group: "Characters", moebius: true, run: () => typeSetGlyph(n),
    })),
    ...Array.from({ length: 10 }, (_, n): Binding => ({
      combo: `alt+f${n + 1}`, label: n === 0 ? "Character set 1–10" : "", group: "Characters", moebius: true, run: () => chooseCharset(n),
    })),
    ...Array.from({ length: 10 }, (_, n): Binding => ({
      combo: `alt+shift+f${n + 1}`, label: n === 0 ? "Character set 11–20" : "", group: "Characters", moebius: true, run: () => chooseCharset(n + 10),
    })),
    { combo: ["ctrl+,", "f11"], label: "Previous character set", group: "Characters", moebius: true, run: () => cycleCharset(-1) },
    { combo: ["ctrl+.", "f12"], label: "Next character set", group: "Characters", moebius: true, run: () => cycleCharset(1) },
    { combo: "ctrl+/", label: "First character set", group: "Characters", moebius: true, run: () => chooseCharset(0) },

    // --- brush
    { combo: ["alt+=", "alt++", "]"], label: "Larger brush", group: "Brush", moebius: true, run: () => setBrushSize(ed, ed.brushSize + 1) },
    { combo: ["alt+-", "["], label: "Smaller brush", group: "Brush", moebius: true, run: () => setBrushSize(ed, ed.brushSize - 1) },
    { combo: "h", label: "Half-block brush", group: "Brush", run: () => { ed.brushMode = "half"; ed.chooseTool("brush"); } },
    { combo: "b", label: "Character brush", group: "Brush", moebius: true, run: () => { ed.brushMode = "char"; ed.chooseTool("brush"); } },

    // --- view and document flags
    { combo: ["mod+=", "mod++"], label: "Zoom in", group: "View", moebius: true, run: () => setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)) },
    { combo: "mod+-", label: "Zoom out", group: "View", moebius: true, run: () => setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)) },
    { combo: ["mod+0", "mod+alt+0"], label: "Zoom to fit", group: "View", run: () => setZoomFit(true) },
    { combo: "mod+e", label: "iCE colours on/off", group: "View", moebius: true, run: () => ed.setProps("iCE colours", ed.doc, { iceColors: !ed.doc.iceColors }, reconvertImages) },
    { combo: "mod+f", label: "9px letter spacing on/off", group: "View", moebius: true, run: () => ed.setProps("9px letter spacing", ed.doc, { letterSpacing9px: !ed.doc.letterSpacing9px }) },
    { combo: ["?", "shift+/"], label: "This list", group: "View", run: () => shortcutSheet(bindings) },
  ];
  const keyIndex = indexBindings(bindings);

  /** Cut or copy prose text while a prose layer is being typed in; false if that is not what is happening. */
  function cutProseText(which: "c" | "x"): boolean {
    if (!editingProse()) return false;
    const text = ed.prose.selectedText();
    if (!text) return true;   // nothing selected, but still a prose edit: do not fall through to the cells clipboard
    lastTextCopy = text;
    navigator.clipboard?.writeText(text).catch(() => { /* no clipboard access: the in-app copy still pastes */ });
    if (which === "x") ed.prose.deleteSelection();
    ed.setStatus(`${which === "x" ? "Cut" : "Copied"} ${text.length} characters.`);
    return true;
  }

  window.addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    // a few work even in a text field, because they are about the document, not the text
    if (typing && !(e.metaKey || e.ctrlKey)) return;
    if (typing && !/^(z|y|s|o|n|j)$/i.test(e.key)) return;
    if (!typing && currentTool().keydown?.(e)) { e.preventDefault(); return; }
    const hit = lookup(keyIndex, e);
    if (hit) {
      if (!hit.passive) e.preventDefault();
      hit.run(e);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const tool = tools.find((t) => t.key === e.key.toLowerCase())
      // Moebius calls the typewriter "keyboard mode" and the fill "paintbucket"
      ?? (e.key.toLowerCase() === "k" ? tools.find((t) => t.id === "text") : undefined)
      ?? (e.key.toLowerCase() === "p" ? tools.find((t) => t.id === "fill") : undefined);
    if (tool) ed.chooseTool(tool.id);
  });

  // ?demo builds a small layered document, so there is something to look at straight away;
  // the very first launch instead opens a real 3D piece, wiggling, so depth is the first thing seen
  let welcomed = true;
  try { welcomed = localStorage.getItem(WELCOME_KEY) === "1"; localStorage.setItem(WELCOME_KEY, "1"); } catch { /* private mode: every launch is the first */ }
  if (new URLSearchParams(location.search).has("demo")) await loadDemo(ed, lib);
  else if (!welcomed) await loadWelcome(ed);
  if (io.desktop) {
    await buildMenu({
      newDocument, open: openFile, importLayer, save: () => saveProjectFile(), saveAs: () => saveProjectFile(true),
      exportAns: () => download(`${baseName()}.ans`, encodeAnsi(flat(), exportOpts())), exportPng, exportWiggle, export3d,
      exportMore: () => { exportMenu.hidden = false; },
      undo: () => ed.undo(), redo: () => ed.redo(),
      selectAll: () => selectAll(ed), selectNone: () => selectNone(ed), selectInverse: () => selectInverse(ed),
      copy: () => void copySelection(ed), cut: () => cutSelection(ed), paste: () => paste(ed), deleteSel: () => deleteSelection(ed),
      zoomIn: () => setZoom(ed.zoom + (ed.zoom < 2 ? 0.5 : 1)), zoomOut: () => setZoom(ed.zoom - (ed.zoom <= 2 ? 0.5 : 1)),
      zoomFit: () => setZoomFit(true), canvasSize: canvasDialog, sauce: () => sauceDialog(ed), mirror: () => toggleMirror("x"),
      joint: openJoint, shortcuts: () => shortcutSheet(bindings),
    });
  }
  (window as unknown as { kd: unknown }).kd = { ed, tools, view, lib, io, joint };

  // the web app works offline once visited, and can be installed (see public/sw.js and manifest.webmanifest);
  // the dev server and the Tauri shell have no use for the worker
  if (import.meta.env.PROD && !io.desktop && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err: unknown) => console.warn("service worker:", err));
  }
}

const WELCOME_KEY = "jockoshop.welcomed";

/** The first launch opens monke.jock — six layers from 565 behind the glass to bananas popping out — with the preview wiggling. */
async function loadWelcome(ed: Editor): Promise<void> {
  try {
    const bytes = new Uint8Array(await (await fetch(welcomeUrl)).arrayBuffer());
    ed.setDocument(loadProject(bytes), "monke.jock");
    ed.emit("preview", "wiggle");
    ed.setStatus("Welcome. This is monke.jock, a layered 3D piece — the preview is wiggling to show its depth. File › New starts your own.");
  } catch { /* no welcome piece, no problem: the blank document stands */ }
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
