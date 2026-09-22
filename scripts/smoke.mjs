#!/usr/bin/env node
// Drives the running editor (npm run dev -w @killerdraw/app) in headless Chrome with real mouse
// and keyboard input, checks the document state after each step, and saves screenshots.
//   node scripts/smoke.mjs [outDir]          CHROME_PATH overrides the browser
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const out = process.argv[2] ?? "smoke-out";
mkdirSync(out, { recursive: true });

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  const arch = process.arch === "arm64" ? "mac_arm-" : "mac-";
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith(arch)).sort((a, b) => parseInt(b.split("-")[1]) - parseInt(a.split("-")[1])) : [];
  for (const d of dirs) {
    const inner = readdirSync(join(base, d))[0];
    const bin = join(base, d, inner, "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("no Chrome found: set CHROME_PATH");
}

const browser = await puppeteer.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1000 });
const problems = [];
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.type()); void d.accept(); });
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) });
const kd = (fn, ...args) => page.evaluate(fn, ...args);

/** page coordinates of the centre of a document cell (or of a half row when hy is given) */
async function cellXY(x, y, hy) {
  return kd((x, y, hy) => {
    const r = document.querySelector("canvas.overlay").getBoundingClientRect();
    const z = window.kd.ed.zoom, cw = 8 * z, ch = 16 * z;
    return { x: r.left + x * cw + cw / 2, y: hy === null ? r.top + y * ch + ch / 2 : r.top + hy * (ch / 2) + ch / 4 };
  }, x, y, hy ?? null);
}
async function drag(from, to, opts = {}) {
  const a = await cellXY(from[0], from[1], opts.half ? from[1] : undefined), b = await cellXY(to[0], to[1], opts.half ? to[1] : undefined);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down({ button: opts.button ?? "left" });
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up({ button: opts.button ?? "left" });
}
/** Click a button by its label, inside one panel: several panels have a "delete". */
const clickButton = async (text, scope = "body") => {
  const state = await kd((text, scope) => {
    // icon buttons carry their name in aria-label
    const b = [...document.querySelectorAll(`${scope} button`)].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()).startsWith(text));
    if (!b) return "missing";
    if (b.disabled) return "disabled";
    b.click();
    return "ok";
  }, text, scope);
  if (state !== "ok") throw new Error(`button "${text}" in ${scope}: ${state}`);
};
const cell = (x, y) => kd((x, y) => window.kd.ed.comp.grid.get(x, y), x, y);

await page.goto("http://127.0.0.1:5183/?demo", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
const fitted = await kd(() => ({ fit: window.kd.ed.zoomFit, zoom: window.kd.ed.zoom, canvas: document.querySelector("canvas.art").getBoundingClientRect().width, avail: document.querySelector(".canvas-wrap").clientWidth }));
check("the canvas fits the window on open", fitted.fit && fitted.canvas <= fitted.avail && fitted.zoom < 2, JSON.stringify(fitted));
await page.setViewport({ width: 1280, height: 900 });
await new Promise((r) => setTimeout(r, 200));
const narrower = await kd(() => ({ zoom: window.kd.ed.zoom, canvas: document.querySelector("canvas.art").getBoundingClientRect().width, avail: document.querySelector(".canvas-wrap").clientWidth }));
check("…and refits when the window shrinks", narrower.zoom < fitted.zoom && narrower.canvas <= narrower.avail, JSON.stringify(narrower));
await page.setViewport({ width: 1680, height: 1000 });
await kd(() => window.kd.ed.zoomFit = false);
await clickButton("Zoom in"); await clickButton("Zoom in");
await kd(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });   // the rest of the script drags at 2×
check("zooming by hand leaves fit mode", await kd(() => !window.kd.ed.zoomFit && window.kd.ed.zoom === 2));
await shot("01-demo");
const layers = await kd(() => window.kd.ed.doc.layers.map((l) => `${l.type}:${l.name}`));
check("demo document has backdrop, keyed stamp and live text", layers.length === 3 && layers[2].startsWith("font:"), layers.join(" | "));
const gap = await kd(() => {   // a cell inside the text block that the font never wrote
  const { ed } = window.kd, L = ed.doc.layers[2], g = L.cache;
  for (let i = 0; i < g.present.length; i++) {
    if (!g.present[i]) { const x = (i % g.width) + L.x, y = Math.floor(i / g.width) + L.y; return { cell: ed.comp.grid.get(x, y), owner: ed.comp.layers[ed.comp.owner[ed.comp.grid.index(x, y)]].name }; }
  }
  return null;
});
check("gaps inside the live text show the backdrop", gap !== null && gap.owner === "backdrop", JSON.stringify(gap));

// --- half-block painting on a new layer
await clickButton("New cells layer", ".layers");
await page.keyboard.press("h");
await kd(() => { window.kd.ed.fg = 12; window.kd.ed.bg = 10; window.kd.ed.emit("ui"); });
await drag([10, 30], [40, 30], { half: true });                       // upper halves of row 15, red
await drag([20, 31], [30, 31], { half: true, button: "right" });      // lower halves, green, under part of it
const upperOnly = await cell(12, 15), both = await cell(25, 15);
check("half block: a lone upper half keeps the backdrop in the lower half", upperOnly.glyph === 223 && upperOnly.fg === 12 && upperOnly.bg !== 10, JSON.stringify(upperOnly));
check("half block: upper red + lower green share one cell", both.glyph === 223 && both.fg === 12 && both.bg === 10, JSON.stringify(both));
await shot("02-halfblocks");

// --- undo / redo
await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
check("undo removes the green stroke only", (await cell(25, 15)).bg !== 10 && (await cell(25, 15)).fg === 12);
await page.keyboard.down("Meta"); await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); await page.keyboard.up("Meta");
check("redo brings it back", (await cell(25, 15)).bg === 10);

// --- pencil with the background channel off: characters over whatever is below
await page.keyboard.press("b");
await kd(() => { const e = window.kd.ed; e.glyph = 254; e.fg = 15; e.drawBg = false; e.emit("ui"); });
const under = await cell(60, 12);
await drag([55, 12], [70, 12]);
const over = await cell(60, 12);
check("pencil without BG keeps the colour underneath", over.glyph === 254 && over.fg === 15 && over.bg === under.bg, `${JSON.stringify(under)} -> ${JSON.stringify(over)}`);
await kd(() => { window.kd.ed.drawBg = true; });

// --- rectangle + fill + type
await page.keyboard.press("r");
await kd(() => { const e = window.kd.ed; e.glyph = 177; e.fg = 14; e.bg = 4; e.emit("ui"); });
await drag([2, 18], [20, 23]);
check("rectangle outline drawn, inside untouched", (await cell(2, 18)).glyph === 177 && (await cell(10, 20)).glyph !== 177);
await page.keyboard.press("t");
const at = await cellXY(4, 20);
await page.mouse.click(at.x, at.y);
await page.keyboard.type("Hi!");
check("typed text lands in cells", (await cell(4, 20)).glyph === 72 && (await cell(6, 20)).glyph === 33);
await shot("03-drawing");

// --- key rule: turn the stamp's rule off and on
const stampIsSolid = async () => (await cell(47, 18)).glyph === 32 && (await cell(47, 18)).bg === 0;
check("keyed stamp: black area is see-through", !(await stampIsSolid()));
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[1].id; e.emit("doc"); });
await kd(() => document.querySelector(".rule input[type=checkbox]").click());
check("key rule off: the stamp's black covers the backdrop", await stampIsSolid());
await shot("04-keyrule-off");
await kd(() => document.querySelector(".rule input[type=checkbox]").click());
check("key rule on again: see-through again, nothing was erased", !(await stampIsSolid()));

// --- live text: retype the font layer
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[2].id; e.emit("doc"); });
const before = await kd(() => window.kd.ed.doc.layers[2].cache.width);
await page.click(".run textarea", { clickCount: 3 });
await page.keyboard.type("DRAW");
const after = await kd(() => ({ w: window.kd.ed.doc.layers[2].cache.width, text: window.kd.ed.doc.layers[2].runs[0].text }));
check("editing the text re-renders the font layer live", after.text === "DRAW" && after.w !== before, `${before} -> ${after.w} cells wide`);
await shot("05-text-edited");

// --- move a layer by dragging
await page.keyboard.press("Tab");   // leave the textarea (commits the edit)
await kd(() => document.activeElement?.blur());
await page.keyboard.press("Escape");   // the Type tool still has its caret: letters would be typed, not read as shortcuts
await page.keyboard.press("v");
const pos0 = await kd(() => ({ x: window.kd.ed.doc.layers[2].x, y: window.kd.ed.doc.layers[2].y }));
await drag([10, 5], [22, 9]);
const pos1 = await kd(() => ({ x: window.kd.ed.doc.layers[2].x, y: window.kd.ed.doc.layers[2].y }));
check("move tool drags the active layer", pos1.x === pos0.x + 12 && pos1.y === pos0.y + 4, `${JSON.stringify(pos0)} -> ${JSON.stringify(pos1)}`);

// --- find & replace on the drawn layer
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[3].id; e.emit("doc"); });
const n = await kd(() => {
  const { ed } = window.kd, L = ed.doc.layers[3];
  let count = 0;
  for (let i = 0; i < L.grid.present.length; i++) if (L.grid.present[i] && L.grid.glyph[i] === 177 && L.grid.fg[i] === 14 && L.grid.bg[i] === 4) count++;
  return count;
});
await shot("06-final");

// --- save / reload round trip through the real project code path
const same = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd;
  const back = core.loadProject(core.saveProject(ed.doc));
  for (const l of back.layers) if (l.type === "font") core.refreshFontLayer(back, l);
  return core.composite(back, { glyphs: ed.glyphs }).grid.equals(ed.comp.grid);
});
check("project save → load → re-render text gives the identical picture", same);
check(`rectangle cells available for find & replace`, n > 0, `${n} yellow-on-red ▒ cells`);
// --- image layers (shadeans via WebAssembly)
/** RGBA PNG from a pixel function, so the test needs no fixture files */
function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (1 + w * 4) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => { const o = Buffer.alloc(12 + body.length); o.writeUInt32BE(body.length, 0); o.write(type, 4, "ascii"); body.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + body.length)), 8 + body.length); return o; };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const photo = join(out, "fixture-gradient.png"), disc = join(out, "fixture-disc.png");
writeFileSync(photo, png(320, 160, (x, y) => [Math.round(255 * x / 319), Math.round(200 * y / 159), Math.round(255 * (1 - x / 319)), 255]));
writeFileSync(disc, png(200, 200, (x, y) => { const d = Math.hypot(x - 100, y - 100); return [255, Math.round(d * 2), 40, d < 90 ? 255 : 0]; }));

const mod = async (keys, fn) => { for (const k of keys) await page.keyboard.down(k); await fn(); for (const k of [...keys].reverse()) await page.keyboard.up(k); };
const addImage = async (file) => {
  const before = await kd(() => window.kd.ed.doc.layers.length);
  const [chooser] = await Promise.all([page.waitForFileChooser(), clickButton("New image layer", ".layers")]);
  await chooser.accept([file]);
  await page.waitForFunction((n) => window.kd.ed.doc.layers.length > n, {}, before);
  return kd(() => { const e = window.kd.ed, l = e.active; return { type: l.type, w: l.cache.width, h: l.cache.height, source: l.source, asset: e.doc.assets.get(l.source).length }; });
};
const activeCache = () => kd(() => { const c = window.kd.ed.active.cache; let sum = 0, rgbCells = 0, absent = 0; for (let i = 0; i < c.present.length; i++) { sum = (sum * 31 + c.glyph[i] + c.fg[i] * 7 + c.bg[i] * 13) >>> 0; if (c.fg[i] > 0xffffff) rgbCells++; if (!c.present[i]) absent++; } return { w: c.width, h: c.height, sum, rgbCells, absent }; });
const settle = () => new Promise((r) => setTimeout(r, 700));

const img = await addImage(photo);
check("image layer: converted by shadeans to the canvas width, original embedded", img.type === "image" && img.w === 80 && img.h === 20 && img.asset > 0, JSON.stringify(img));
check("adding or selecting an image layer leaves a tool that can act on it", await kd(() => window.kd.ed.toolApplies(window.kd.ed.tool)) && ["move", "marquee", "lasso", "wand"].includes(await kd(() => window.kd.ed.tool)), await kd(() => window.kd.ed.tool));
const base = await activeCache();
await shot("07-image-layer");

await kd(() => { const s = [...document.querySelectorAll(".slider")].find((l) => l.textContent.startsWith("texture")).querySelector("input"); s.value = "1"; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); });
await settle();
const pixelArt = await activeCache();
check("image layer: dragging 'texture' re-converts live", pixelArt.sum !== base.sum, `${base.sum} -> ${pixelArt.sum}; status: ${await kd(() => window.kd.ed.status)}`);

await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
await settle();
check("image layer: undo restores the settings and the picture", (await activeCache()).sum === base.sum && await kd(() => window.kd.ed.active.options.lambda === 0.1));

await kd(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.trim() === "24-bit").querySelector("input").click());
await settle();
const tc = await activeCache();
check("image layer: 24-bit gives exact colours per cell", tc.rgbCells > tc.w * tc.h * 0.9, `${tc.rgbCells} of ${tc.w * tc.h} cells`);
await shot("08-image-truecolor");

await kd(() => { const i = [...document.querySelectorAll(".field")].find((f) => f.textContent.startsWith("columns")).querySelector("input"); i.value = "40"; i.dispatchEvent(new Event("change", { bubbles: true })); });
await settle();
const small = await activeCache();
check("image layer: resizes from the original at any time", small.w === 40 && small.h === 10, `${small.w}x${small.h}`);

const d = await addImage(disc);
const discCache = await activeCache();
check("image layer: transparent pixels become see-through cells", discCache.absent > 0 && discCache.absent < discCache.w * discCache.h, `${discCache.absent} of ${discCache.w * discCache.h} cells absent (${d.w}x${d.h})`);
await shot("09-image-alpha");

const imgRoundTrip = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd;
  const back = core.loadProject(core.saveProject(ed.doc));
  const imgs = back.layers.filter((l) => l.type === "image");
  return { same: core.composite(back, { glyphs: ed.glyphs }).grid.equals(ed.comp.grid), images: imgs.length, recipeKept: imgs[0].cols === 40 && imgs[0].options.truecolor === true, assets: [...back.assets.keys()].filter((k) => k.startsWith("assets/images/")).length };
});
// drop an image onto the canvas: it becomes a layer where it landed
const dropAt = await cellXY(20, 6);
const layersBeforeDrop = await kd(() => window.kd.ed.doc.layers.length);
const pngBytes = [...readFileSync(disc)];
await kd(async (bytes, x, y) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
  document.querySelector("canvas.overlay").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
}, pngBytes, dropAt.x, dropAt.y);
await page.waitForFunction((n) => window.kd.ed.doc.layers.length > n, {}, layersBeforeDrop);
const dropped = await kd(() => { const l = window.kd.ed.active; return { type: l.type, name: l.name, x: l.x, y: l.y, cells: l.cache.width * l.cache.height }; });
check("dropping an image on the canvas adds it as an image layer at the drop point", dropped.type === "image" && dropped.name === "dropped" && dropped.x === 20 && dropped.y === 6 && dropped.cells > 0, JSON.stringify(dropped));
await mod(["Meta"], () => page.keyboard.press("z"));

check("project keeps image layers: source images, settings and cells", imgRoundTrip.same && imgRoundTrip.images === 2 && imgRoundTrip.recipeKept && imgRoundTrip.assets === 2, JSON.stringify(imgRoundTrip));

// tactile resize: drag the image layer's corner with the Move tool
await kd(() => { const e = window.kd.ed; e.chooseTool("move"); const l = e.active; l.x = 0; l.y = 0; e.recomposite(); e.emit("doc"); });
await kd(() => { const i = [...document.querySelectorAll(".field")].find((f) => f.textContent.startsWith("columns")).querySelector("input"); i.value = "40"; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); });
await settle();   // 40x20: the whole layer is inside the viewport, where synthetic mouse events can reach
const sz0 = await kd(() => ({ w: window.kd.ed.active.cache.width, h: window.kd.ed.active.cache.height }));
const cornerCursor = await kd((x, y) => { const t = window.kd.tools.find((t) => t.id === "move"); return t.cursor({ x, y }); }, sz0.w - 1, sz0.h - 1);
check("the Move tool shows a resize cursor on the image's corner", cornerCursor === "nwse-resize", cornerCursor);
await drag([sz0.w - 1, sz0.h - 1], [sz0.w - 21, sz0.h - 1]);
await settle();
const sz1 = await kd(() => ({ w: window.kd.ed.active.cache.width, h: window.kd.ed.active.cache.height, cols: window.kd.ed.active.cols, rows: window.kd.ed.active.rows }));
check("dragging the corner resizes the image, keeping its aspect", sz1.cols === sz0.w - 20 && sz1.rows === 0 && sz1.w === sz0.w - 20 && sz1.h < sz0.h, `${JSON.stringify(sz0)} -> ${JSON.stringify(sz1)}`);
await drag([sz1.w - 1, Math.floor(sz1.h / 2)], [sz1.w - 6, Math.floor(sz1.h / 2)]);
await settle();
check("dragging the right edge changes the width only", await kd(() => window.kd.ed.active.cols) === sz1.w - 5);
await drag([Math.floor(sz1.w / 2), (await kd(() => window.kd.ed.active.cache.height)) - 1], [Math.floor(sz1.w / 2), 4]);
await settle();
const sz2 = await kd(() => ({ w: window.kd.ed.active.cache.width, h: window.kd.ed.active.cache.height }));
check("dragging the bottom edge changes the height only", sz2.h === 5 && sz2.w === sz1.w - 5, JSON.stringify(sz2));
await mod(["Meta"], () => page.keyboard.press("z"));
await settle();
check("a resize is one undo step", await kd(() => window.kd.ed.active.rows === 0 && window.kd.ed.active.cache.height > 0));
await kd(() => { const e = window.kd.ed; e.chooseTool("marquee"); });

// spinners: a held spinner / arrow key keeps stepping, on a field whose commit rebuilds its panel
const stepField = async (label, steps) => {
  await kd((label) => { const i = [...document.querySelectorAll(".field")].find((f) => f.textContent.startsWith(label)).querySelector("input"); i.focus(); }, label);
  for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowDown");
  const still = await kd(() => document.activeElement?.type === "number");
  await settle();
  return still;
};
const colsBefore = await kd(() => window.kd.ed.active.cols);
const stillFocused = await stepField("columns", 5);
check("a held spinner steps the image width repeatedly, live", stillFocused && await kd(() => window.kd.ed.active.cols) === colsBefore - 5, `${colsBefore} -> ${await kd(() => window.kd.ed.active.cols)}`);
const depthBefore = await kd(() => window.kd.ed.active.depth ?? 0);
const stillFocused2 = await stepField("3D depth", 7);
check("…and a field that rebuilds its panel on commit (depth) steps 7 times as one change", stillFocused2 && await kd(() => window.kd.ed.active.depth) === depthBefore - 7 && await kd(() => window.kd.ed.history.canUndo), `${depthBefore} -> ${await kd(() => window.kd.ed.active.depth)}`);
await page.keyboard.press("Tab");
// hold the mouse on the spin button: it repeats on its own
const undoCount = await kd(() => window.kd.ed.history.position);
const spinBtn = await kd(() => { const b = [...document.querySelectorAll(".field")].find((f) => f.textContent.startsWith("3D depth")).querySelector(".spin:last-child").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
const d0 = await kd(() => window.kd.ed.active.depth ?? 0);
await page.mouse.move(spinBtn.x, spinBtn.y);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 1500));
await page.mouse.up();
await settle();
const d1 = await kd(() => window.kd.ed.active.depth ?? 0);
// the picture follows a held spin button: canvas height in the top bar
const hBtn = await kd(() => { const b = [...document.querySelectorAll(".topbar .num")][1].querySelector(".spin:first-child").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
const h0 = await kd(() => ({ doc: window.kd.ed.doc.height, canvas: document.querySelector("canvas.art").height }));
await page.mouse.move(hBtn.x, hBtn.y);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 700));
const mid = await kd(() => ({ doc: window.kd.ed.doc.height, canvas: document.querySelector("canvas.art").height, undo: window.kd.ed.history.position }));
await page.mouse.up();
await settle();
const h1 = await kd(() => ({ doc: window.kd.ed.doc.height, canvas: document.querySelector("canvas.art").height, undo: window.kd.ed.history.position }));
check("the canvas grows while the height spin button is still held", mid.doc > h0.doc && mid.canvas === mid.doc * 16, `held: ${h0.doc} -> ${mid.doc} rows, canvas ${mid.canvas}px`);
check("…and the hold becomes one undo step on release", h1.doc === mid.doc && h1.undo !== mid.undo);
await mod(["Meta"], () => page.keyboard.press("z"));
check("undoing it restores the original height", await kd(() => window.kd.ed.doc.height) === h0.doc, await kd(() => `height ${window.kd.ed.doc.height}, focus ${document.activeElement?.tagName}, status "${window.kd.ed.status}"`));
check("holding a spin button repeats (1.5 s hold steps many times), as one undo step", d0 - d1 >= 15 && await kd((p) => window.kd.ed.history.position !== p, undoCount), `${d0} -> ${d1} in 1.5 s`);


// ===================================================== selections, masks, palette swap, canvas, 3D
check("the title shows unsaved changes", await kd(() => window.kd.ed.dirty && document.title.startsWith("•") && document.querySelector(".title").textContent.endsWith("•")), await kd(() => document.title));
await page.goto("http://127.0.0.1:5183/?demo", { waitUntil: "networkidle0" });
check("leaving with unsaved changes asks first", dialogs.includes("beforeunload"), dialogs.join(","));
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
await kd(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });   // this section drags at 2×
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
const selCount = () => kd(() => window.kd.ed.selection?.count() ?? 0);
const selHas = (x, y) => kd((x, y) => !!window.kd.ed.selection?.has(x, y), x, y);
const layerNames = () => kd(() => window.kd.ed.doc.layers.map((l) => l.name));
const owner = (x, y) => kd((x, y) => { const c = window.kd.ed.comp; const o = c.owner[c.grid.index(x, y)]; return o < 0 ? null : c.layers[o].name; }, x, y);

await clickButton("New cells layer", ".layers");
await page.keyboard.press("m");
await drag([5, 14], [10, 17]);
check("marquee selects a rectangle", await selCount() === 24 && await selHas(5, 14) && !(await selHas(11, 14)), `${await selCount()} cells`);
await mod(["Shift"], () => drag([20, 14], [21, 15]));
check("Shift-drag adds to the selection", await selCount() === 28 && await selHas(21, 15));
await mod(["Alt"], () => drag([5, 14], [10, 14]));
check("Alt-drag subtracts (and does not pick up a cell)", await selCount() === 22 && !(await selHas(7, 14)) && await kd(() => window.kd.ed.glyph === 219));

await page.keyboard.press("b");
await kd(() => { const e = window.kd.ed; e.glyph = 219; e.fg = 13; e.bg = 0; e.emit("ui"); });
await drag([2, 16], [30, 16]);
const inside = await cell(7, 16), outside = await cell(14, 16);
check("drawing is confined to the selection", inside.fg === 13 && inside.glyph === 219 && outside.fg !== 13, `${JSON.stringify(inside)} / ${JSON.stringify(outside)}`);

await page.keyboard.press("q");
await page.mouse.move((await cellXY(40, 2)).x, (await cellXY(40, 2)).y);
await page.mouse.down();
for (const [x, y] of [[60, 2], [50, 12], [40, 2]]) { const pt = await cellXY(x, y); await page.mouse.move(pt.x, pt.y, { steps: 10 }); }
await page.mouse.up();
check("lasso selects what the path encloses", await selHas(50, 6) && !(await selHas(41, 10)) && !(await selHas(5, 15)), `${await selCount()} cells`);

// magic wand by look on the imported-style stamp: everything that shows flat black, in one click
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[1].id; e.emit("doc"); });
await page.keyboard.press("w");
await kd(() => { const e = window.kd.ed; e.wand.byLook = true; e.wand.contiguous = false; e.emit("ui"); });
const wandAt = await cellXY(47, 18);
await page.mouse.click(wandAt.x, wandAt.y);
check("magic wand 'by look' grabs every flat-black cell of the layer", await selCount() === 150 - 15, `${await selCount()} cells (30x5 stamp minus the 15 visible characters)`);

await kd(() => { const e = window.kd.ed; e.doc.layers[1].keys[0].enabled = false; e.recomposite(); });
check("before delete: with its key rule off the stamp's black covers the backdrop", await owner(47, 18) === "stamp (keyed)");
await page.keyboard.press("Delete");
check("Delete makes the selection see-through on the layer itself (a destructive mask)", await owner(47, 18) === "backdrop" && await owner(48, 20) === "stamp (keyed)", `${await owner(47, 18)} / letter: ${await owner(48, 20)}`);
await mod(["Meta"], () => page.keyboard.press("z"));
check("undo brings the cells back", await owner(47, 18) === "stamp (keyed)");
await mod(["Meta"], async () => { await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); });

// BG-only delete: strip backgrounds under the letters, keep the characters
await page.keyboard.press("m");
await drag([48, 20], [65, 20]);
await kd(() => { const e = window.kd.ed; e.drawGlyph = false; e.drawFg = false; e.drawBg = true; e.emit("ui"); });
await page.keyboard.press("Delete");
const letter = await cell(48, 20);
check("Delete with only BG switched on strips backgrounds and keeps the characters", letter.glyph === 108 && letter.fg === 14 && letter.bg !== 0, JSON.stringify(letter));
await kd(() => { const e = window.kd.ed; e.drawGlyph = e.drawFg = e.drawBg = true; e.emit("ui"); });

// fill + copy/paste
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[3].id; e.glyph = 177; e.fg = 10; e.bg = 2; e.emit("doc"); });
await drag([30, 21], [35, 23]);
await clickButton("fill", ".toolbox");
check("fill paints the selection with the brush", (await cell(32, 22)).glyph === 177 && (await cell(32, 22)).fg === 10 && (await cell(36, 22)).glyph !== 177);
await mod(["Meta"], () => page.keyboard.press("c"));
await mod(["Meta"], () => page.keyboard.press("v"));
const pasted = await kd(() => { const e = window.kd.ed, l = e.active; return { name: l.name, x: l.x, y: l.y, w: l.grid.width, h: l.grid.height, tool: e.tool, sel: !!e.selection }; });
check("copy + paste lands as a new layer in place, ready to move", pasted.name === "Pasted" && pasted.x === 30 && pasted.y === 21 && pasted.w === 6 && pasted.h === 3 && pasted.tool === "move" && !pasted.sel, JSON.stringify(pasted));

// non-destructive mask from a selection, on the live text layer
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[2].id; e.tool = "marquee"; e.emit("doc"); });
const textOwned = () => kd(() => { const c = window.kd.ed.comp; let n = 0; for (const o of c.owner) if (o >= 0 && c.layers[o].type === "font") n++; return n; });
const textBefore = await textOwned();
await drag([4, 3], [30, 12]);
await clickButton("show only this", ".toolbox");
const textMasked = await textOwned();
check("mask from selection hides the rest of a live text layer", textMasked > 0 && textMasked < textBefore, `${textBefore} -> ${textMasked} cells`);
await kd(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.trim() === "mask on").querySelector("input").click());
check("turning the mask off shows it all again: nothing was erased", await textOwned() === textBefore);
await page.keyboard.press("Escape");

// duplicate + palette swap
const namesBefore = await layerNames();
await clickButton("Duplicate layer", ".layers");
const namesAfter = await layerNames();
check("duplicate makes an independent copy above", namesAfter.length === namesBefore.length + 1 && namesAfter.includes("title (live text) copy"), namesAfter.join(" | "));
await clickButton("Delete layer", ".layers");
check("deleting the copy leaves the original", JSON.stringify(await layerNames()) === JSON.stringify(namesBefore));
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[2].id; e.emit("doc"); });
const hues = () => kd(() => { const c = window.kd.ed.comp, seen = new Set(); c.owner.forEach((o, i) => { if (o >= 0 && c.layers[o].type === "font") { seen.add(c.grid.fg[i]); } }); return [...seen].sort((a, b) => a - b); });
const huesBefore = await hues();
await kd(() => { const s = [...document.querySelectorAll("select")].find((s) => s.options[0]?.textContent === "presets…"); s.value = String([...s.options].findIndex((o) => o.textContent === "all red") - 1); s.dispatchEvent(new Event("change", { bubbles: true })); });
const huesAfter = await hues();
const onlyRedAndGrey = huesAfter.every((c) => [0, 4, 12].includes(c));   // greys and white are tinted too
check("palette swap recolours a live text layer — greys and white included — without changing it", onlyRedAndGrey && JSON.stringify(huesBefore) !== JSON.stringify(huesAfter) && await kd(() => window.kd.ed.doc.layers[2].runs[0].text === "KILLER"), `${huesBefore} -> ${huesAfter}`);
await kd(() => [...document.querySelectorAll(".layers label.check")].find((l) => l.textContent.trim() === "white").querySelector("input").click());
await kd(() => { const s = [...document.querySelectorAll("select")].find((s) => s.options[0]?.textContent === "presets…"); s.value = String([...s.options].findIndex((o) => o.textContent === "all red") - 1); s.dispatchEvent(new Event("change", { bubbles: true })); });
const keptWhite = await hues();
check("with “white” unticked, white stays as the highlight", keptWhite.includes(15) && !keptWhite.includes(7), `${keptWhite}`);
await clickButton("randomize", ".layers");
check("randomize moves the greys too", await kd(() => { const r = window.kd.ed.doc.layers[2].remap; return !!r && r[7] !== 7 && r[8] !== 8; }));
const blinkCells = () => kd(() => { const g = window.kd.ed.comp.grid; let n = 0; for (let i = 0; i < g.bg.length; i++) if (g.bg[i] >= 8 && g.bg[i] < 16) n++; return n; });
check("with iCE off, a palette swap never creates blinking backgrounds", await blinkCells() === 0 && !(await kd(() => window.kd.ed.doc.iceColors)), `${await blinkCells()} cells would blink`);
check("randomize gives a valid 16-colour map", await kd(() => { const r = window.kd.ed.doc.layers[2].remap; return !r || (r.length === 16 && r.every((v) => v >= 0 && v < 16)); }));
await shot("10-selection-mask-palette");

// canvas: add rows at the top and columns at the left
const probe = await cell(10, 5);
await clickButton("Canvas size");
await kd(() => { const ins = document.querySelectorAll(".dialog input"); const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }; set(ins[0], "2"); set(ins[2], "3"); });
await clickButton("Apply");
const grown = await kd(() => ({ w: window.kd.ed.doc.width, h: window.kd.ed.doc.height }));
const moved = await cell(13, 7), fresh = await cell(0, 0);
check("canvas: rows added at the top and columns at the left shift everything", grown.w === 83 && grown.h === 27 && moved.glyph === probe.glyph && moved.fg === probe.fg && fresh.glyph === 32 && fresh.bg === 0, `${JSON.stringify(grown)}; (10,5) -> (13,7)`);
await mod(["Meta"], () => page.keyboard.press("z"));
check("canvas resize undoes exactly", await kd(() => window.kd.ed.doc.width === 80 && window.kd.ed.doc.height === 25) && (await cell(10, 5)).glyph === probe.glyph);

// preview: always on, in the right sidebar; its 3D modes replace the old pane
const previewPixels = () => kd(() => { const c = document.querySelector("canvas.preview"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let lit = 0, sum = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] | d[i + 1] | d[i + 2]) lit++; sum = (sum * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0; } return { w: c.width, h: c.height, lit, sum, main: document.querySelector("canvas.art").width }; });
const flatView = await previewPixels();
check("preview is always on, smaller than the canvas, and shows the picture", flatView.w > 100 && flatView.w < flatView.main && flatView.lit > flatView.w * flatView.h * 0.5, JSON.stringify(flatView));
await page.evaluate(() => { document.querySelector(".canvas-wrap").scrollLeft = 0; });
const p0 = await kd(() => document.querySelector(".canvas-wrap").scrollLeft);
const pv = await kd(() => { const r = document.querySelector("canvas.preview").getBoundingClientRect(); return { x: r.right - 4, y: r.top + r.height / 2 }; });
await page.mouse.click(pv.x, pv.y);
check("clicking the preview scrolls the canvas there", await kd(() => document.querySelector(".canvas-wrap").scrollLeft) > p0);
await kd(() => { const s = document.querySelector(".preview-bar select"); s.value = "anaglyph"; s.dispatchEvent(new Event("change", { bubbles: true })); });
await new Promise((r) => setTimeout(r, 300));
const anaglyph = await previewPixels();
const info = await kd(() => document.querySelector(".preview-bar .grow").textContent);
check("preview 3D mode draws the depth layers differently from the flat picture", anaglyph.sum !== flatView.sum && info.startsWith("3 of 16 depths"), info);
await shot("11-3d-preview");
await clickButton("Export");
await clickButton("3dBBS", ".menu");
// every export in the menu produces a file that reads back
const exportsOk = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd, g = ed.comp.grid, results = {};
  const opts = { iceColors: ed.doc.iceColors, palette: ed.doc.palette, sauce: ed.doc.sauce };
  const tryIt = (name, bytes, parse) => { try { const back = parse(bytes); results[name] = back.grid.width === g.width ? "ok" : `width ${back.grid.width}`; } catch (e) { results[name] = e.message; } };
  tryIt("ans", core.encodeAnsi(g, opts), (b) => core.parseArt(b, "x.ans"));
  tryIt("bin", core.encodeBin(g, opts), (b) => core.parseArt(b, "x.bin"));
  tryIt("xb", core.encodeXbin(g, { iceColors: ed.doc.iceColors, sauce: ed.doc.sauce }), (b) => core.parseArt(b, "x.xb"));
  tryIt("tnd", core.encodeTundra(g, ed.doc.palette), (b) => core.parseTundra(b, { width: g.width }));
  tryIt("msg", core.encodeCtrlA(g, ed.doc.palette), (b) => core.parseCtrlA(b, { width: g.width }));
  results.txt = core.encodeText(g, "cp437").length > 0 && core.encodeText(g, "utf8").length > 0 ? "ok" : "empty";
  return results;
});
check("all export formats encode and read back at the right width", Object.values(exportsOk).every((v) => v === "ok"), JSON.stringify(exportsOk));
check("the app is called jockoshop", await kd(() => document.querySelector(".logo").textContent === "jockoshop" && document.title.includes("jockoshop")));
check("3dBBS export reports its depth layers", (await kd(() => window.kd.ed.status)).startsWith("Exported with 3 depth layer"), await kd(() => window.kd.ed.status));

// the tool decides the left sidebar
const leftPanels = () => kd(() => [...document.querySelectorAll(".toolbox details.sec")].map((d) => d.dataset.panel));
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[0].id; e.emit("doc"); });
await page.keyboard.press("b");
const forDraw = await leftPanels();
await page.keyboard.press("w");
const forWand = await leftPanels();
await page.keyboard.press("s");
const forFind = await leftPanels();
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[2].id; e.emit("doc"); });
await page.keyboard.press("t");
const forType = await leftPanels();
check("left sidebar follows the tool", JSON.stringify([forDraw, forWand, forFind, forType]) === JSON.stringify([["brush", "character"], ["selectTool", "selection"], ["find"], ["font"]]), JSON.stringify([forDraw, forWand, forFind, forType]));
// the tool follows the layer
const clickLayer = (name) => kd((name) => [...document.querySelectorAll(".layer")].find((r) => r.querySelector(".name").textContent === name).click(), name);
const toolNow = () => kd(() => window.kd.ed.tool);
await clickLayer("backdrop");
await page.keyboard.press("b");
await clickLayer("title (live text)");
check("selecting a text layer with a brush active switches to Type, with its text on the left", await toolNow() === "text" && JSON.stringify(await leftPanels()) === '["font"]', `${await toolNow()} ${JSON.stringify(await leftPanels())}`);
const dimmed = await kd(() => [...document.querySelectorAll(".palette .na")].map((b) => b.getAttribute("aria-label").split(" (")[0]));
check("tools that can't act on a text layer are dimmed", JSON.stringify(dimmed) === JSON.stringify(["Pencil", "Half block", "Eraser", "Line", "Rectangle", "Ellipse", "Fill", "Pick up", "Find & replace"]), dimmed.join(", "));
await page.keyboard.press("h");
check("choosing a dimmed tool is refused, with the reason", await toolNow() === "text" && (await kd(() => window.kd.ed.status)).includes("rasterize"), await kd(() => window.kd.ed.status));
await clickLayer("backdrop");
check("going back to a cells layer brings the brush back", await toolNow() === "pencil");
await page.keyboard.press("v");
await clickLayer("title (live text)");
check("Move sticks when switching to a text layer", await toolNow() === "move");
await clickLayer("backdrop");
await page.keyboard.press("m");
await clickLayer("title (live text)");
check("select tools stick too", await toolNow() === "marquee");

// Move tool: double-click a text layer to edit its text
await clickLayer("backdrop");
await page.keyboard.press("v");
await kd(() => { document.querySelector(".canvas-wrap").scrollLeft = 0; document.querySelector(".canvas-wrap").scrollTop = 0; });
const onText = await kd(() => { const { ed } = window.kd, L = ed.doc.layers[2], g = L.cache; for (let i = 0; i < g.present.length; i++) if (g.present[i]) return { x: (i % g.width) + L.x, y: Math.floor(i / g.width) + L.y }; });
const dbl = await cellXY(onText.x, onText.y);
await page.mouse.click(dbl.x, dbl.y, { clickCount: 2 });
await new Promise((r) => setTimeout(r, 150));
const editing = await kd(() => ({ tool: window.kd.ed.tool, active: window.kd.ed.active.name, focus: document.activeElement?.tagName, inRun: !!document.activeElement?.closest(".run"), moved: window.kd.ed.doc.layers[2].x }));
check("double-click with Move on a text layer: selects it, switches to Type, caret in its text", editing.tool === "text" && editing.active === "title (live text)" && editing.focus === "TEXTAREA" && editing.inRun, JSON.stringify(editing));
await page.keyboard.type("S");
check("…and typing goes straight into the text", await kd(() => window.kd.ed.doc.layers[2].runs[0].text === "KILLERS"));
await kd(() => document.activeElement?.blur());
await shot("13-tool-follows-layer");

// ===================================================== prose: a word processor on the canvas
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
await kd(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });
// a box drawn on the cells layer: the border will be an obstacle
await page.keyboard.press("r");
await kd(() => { const e = window.kd.ed; e.glyph = 219; e.fg = 4; e.bg = 0; e.emit("ui"); });
await drag([12, 3], [17, 6]);
check("a box is drawn for the text to flow around", (await cell(12, 3)).glyph === 219 && (await cell(14, 5)).glyph !== 219);
// drag out a prose frame over it with the Type tool
await page.keyboard.press("t");
await drag([2, 2], [25, 9]);
const proseMade = await kd(() => { const l = window.kd.ed.active; return { type: l.type, x: l.x, y: l.y, w: l.width, h: l.height, editing: window.kd.ed.prose.layer === l }; });
check("dragging with Type makes a prose frame and starts editing", proseMade.type === "prose" && proseMade.x === 2 && proseMade.y === 2 && proseMade.w === 24 && proseMade.h === 8 && proseMade.editing, JSON.stringify(proseMade));
await page.keyboard.type("the quck brown fox jumps over the lazy dog and keeps on running");
const rowText = (y) => kd((y) => { const g = window.kd.ed.comp.grid; let s = ""; for (let x = 0; x < 30; x++) { const c = g.get(x, y); s += c.glyph === 32 ? "." : c.glyph === 219 ? "#" : String.fromCharCode(c.glyph); } return s; }, y);
const typed = [await rowText(2), await rowText(3), await rowText(4)];
check("typed prose wraps in the frame and flows around the box", typed[0].startsWith("..the.quck.brown.fox") && /^\.\.\S+.*\.\.######/.test(typed[1]) && typed[1].indexOf("######") === 12 && typed[1].slice(18).trim(".") !== "", typed.join(" | "));
// go back and fix the typo: click between "qu" and "ck", type "i"
const fix = await cellXY(8, 2);
await page.mouse.click(fix.x, fix.y);
check("clicking places the caret in the word", await kd(() => window.kd.ed.prose.caret === 6));
await page.keyboard.type("i");
const fixed = [await rowText(2), await rowText(3)];
check("inserting the missing letter reflows the paragraph", fixed[0].startsWith("..the.quick.brown.fox") && fixed.join("").includes("jumps"), fixed.join(" | "));
// Backspace works, Home/End move, and the box was never overwritten
await page.keyboard.press("Backspace");
check("Backspace removes it again", (await rowText(2)).startsWith("..the.quck.brown"));
await page.keyboard.type("i");
check("the box under the text is untouched", (await cell(12, 3)).glyph === 219 && (await cell(17, 6)).glyph === 219);
// the burst becomes one undo step after a pause
await new Promise((r) => setTimeout(r, 1700));
const posA = await kd(() => window.kd.ed.history.position);
await mod(["Meta"], () => page.keyboard.press("z"));
check("a typing burst is one undo step, and placing the caret had closed the previous one", await kd((p) => window.kd.ed.history.position !== p, posA) && (await rowText(2)).includes("quck"), await rowText(2));
await mod(["Meta"], async () => { await page.keyboard.down("Shift"); await page.keyboard.press("z"); await page.keyboard.up("Shift"); });
check("…and redo brings the fix back", (await rowText(2)).includes("quick"));
// moving the box makes the text reflow around its new position
await page.keyboard.press("Escape");
await kd(() => { const e = window.kd.ed; e.setActive(e.doc.layers[0].id); });
await page.keyboard.press("v");
await drag([14, 4], [14, 7]);
const movedRow = await rowText(3);
check("moving the layer under the prose reflows the text around it", !movedRow.includes("#") && (await rowText(6)).includes("#"), `${movedRow} / ${await rowText(6)}`);
// text selection inside the prose
await kd(() => { const e = window.kd.ed; e.setActive(e.doc.layers[1].id); e.chooseTool("text"); });
const pat = await kd(() => { const l = window.kd.ed.doc.layers[1]; return { x: l.x, y: l.y }; });
const c1 = await cellXY(pat.x + 4, pat.y), c2 = await cellXY(pat.x + 12, pat.y);
await page.mouse.move(c1.x, c1.y); await page.mouse.down(); await page.mouse.move(c2.x, c2.y, { steps: 6 }); await page.mouse.up();
const dragSel = await kd(() => window.kd.ed.prose.selectedText());
check("dragging with Type selects text", dragSel === "quick br", JSON.stringify(dragSel));
await mod(["Shift"], () => page.keyboard.press("ArrowRight"));
check("Shift+arrow extends it", await kd(() => window.kd.ed.prose.selectedText()) === "quick bro");
await kd(() => [...document.querySelectorAll(".toolbox .swatch")][14].click());   // yellow
const recol = await kd(() => { const l = window.kd.ed.doc.layers[1]; return { still: window.kd.ed.prose.selectedText(), fg: l.fg.slice(4, 13), before: l.fg[3] }; });
check("clicking a swatch recolours the selection and keeps it", recol.still === "quick bro" && recol.fg.every((c) => c === 14) && recol.before !== 14, JSON.stringify(recol));
await page.keyboard.type("slow");
check("typing replaces the selection", (await rowText(2)).startsWith("..the.slowwn.fox"), await rowText(2));
await mod(["Meta"], () => page.keyboard.press("a"));
const all = await kd(() => ({ sel: window.kd.ed.prose.selectedText().length, text: window.kd.ed.doc.layers[1].text.length }));
check("Cmd+A selects the whole prose, not the canvas", all.sel === all.text && all.sel > 40 && await kd(() => window.kd.ed.selection === null), JSON.stringify(all));
const dbl2 = await cellXY(pat.x + 2, pat.y);
await page.mouse.click(dbl2.x, dbl2.y, { clickCount: 2 });
check("double-click selects a word", await kd(() => window.kd.ed.prose.selectedText()) === "the");
await mod(["Meta"], () => page.keyboard.press("x"));
check("Cmd+X cuts it", (await rowText(2)).startsWith("...slowwn") || (await rowText(2)).startsWith("..slowwn"), await rowText(2));
await kd(() => { const e = window.kd.ed; e.prose.caret = e.doc.layers[1].text.length; e.prose.anchor = null; });
await kd(() => document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: new DataTransfer() })));   // empty system clipboard: the in-app copy is used
check("Cmd+V pastes what was cut", await kd(() => window.kd.ed.doc.layers[1].text.endsWith("the")));
await page.keyboard.press("Escape");
await shot("14-prose");

// F-key character sets: the TheDraw / PabloDraw / Moebius convention
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
await kd(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });
await page.keyboard.press("t");
const fkBar = await kd(() => ({ shown: !!document.querySelector(".status .fkeys"), slots: [...document.querySelectorAll(".fkey:not(.arrow) .g")].map((g) => g.textContent).join(""), set: window.kd.ed.charset }));
check("with the Type tool the footer shows the F-key set bar, blocks set by default", fkBar.shown && fkBar.set === 5 && fkBar.slots === "░▒▓█▀▄▌▐■·", JSON.stringify(fkBar));
const fkAt = await cellXY(10, 10);
await page.mouse.click(fkAt.x, fkAt.y);
await page.keyboard.press("F1"); await page.keyboard.press("F4"); await page.keyboard.press("F6");
const fkTyped = await kd(() => [10, 11, 12].map((x) => window.kd.ed.comp.grid.get(x, 10).glyph));
check("F1–F10 type the set's glyphs at the typewriter caret on the grid", JSON.stringify(fkTyped) === "[176,219,220]", JSON.stringify(fkTyped));
await page.keyboard.press("F12");
check("F12 moves to the next set and the bar follows", await kd(() => window.kd.ed.charset === 6 && document.querySelector(".fkey:not(.arrow) .g").textContent === "☺"));
await page.keyboard.press("F1");
check("…and F1 now types from that set", (await cell(13, 10)).glyph === 1);
await page.keyboard.down("Control"); await page.keyboard.press(","); await page.keyboard.up("Control");
check("Ctrl+, goes back a set (Moebius's binding)", await kd(() => window.kd.ed.charset === 5));
await page.keyboard.press("Escape");
await page.keyboard.press("b");
await page.keyboard.press("F3");
check("with a drawing tool, an F-key sets the brush character instead", await kd(() => window.kd.ed.glyph === 178 && !document.querySelector(".status .fkeys")));
await page.keyboard.press("t");
await kd(() => document.querySelectorAll(".fkey:not(.arrow)")[1].click());
check("clicking a slot in the bar with no caret sets the brush", await kd(() => window.kd.ed.glyph === 177));
await shot("15-fkeys");

// ===================================================== ellipse, mirror, SAUCE, reference, scale
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
await kd(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });
await page.keyboard.press("o");
await kd(() => { const e = window.kd.ed; e.glyph = 219; e.fg = 14; e.bg = 0; e.emit("ui"); });
await drag([10, 4], [30, 12]);
const ellInfo = await kd(() => { const g = window.kd.ed.comp.grid; let n = 0; for (let y = 4; y <= 12; y++) for (let x = 10; x <= 30; x++) if (g.get(x, y).glyph === 219) n++; return { n, mid: g.get(20, 8).glyph, top: g.get(20, 4).glyph, corner: g.get(10, 4).glyph }; });
check("ellipse tool draws an outline: hollow middle, touches the top, misses the corner", ellInfo.n > 30 && ellInfo.mid !== 219 && ellInfo.top === 219 && ellInfo.corner !== 219, JSON.stringify(ellInfo));
await mod(["Shift"], () => drag([40, 4], [60, 12]));
check("…and filled with Shift", (await cell(50, 8)).glyph === 219);

await page.keyboard.press("x");
check("X turns on mirror mode", await kd(() => window.kd.ed.mirrorX && document.querySelector('[aria-label^="Mirror"]').classList.contains("active")));
await page.keyboard.press("b");
await kd(() => { const e = window.kd.ed; e.glyph = 221; e.fg = 12; e.bg = 0; e.emit("ui"); });   // ▌
await drag([5, 20], [5, 22]);
const mirInfo = await kd(() => ({ left: window.kd.ed.comp.grid.get(5, 21).glyph, right: window.kd.ed.comp.grid.get(74, 21).glyph }));
check("mirror mode repeats the stroke across the centre and mirrors the glyph (▌ becomes ▐)", mirInfo.left === 221 && mirInfo.right === 222, JSON.stringify(mirInfo));
await page.keyboard.press("x");

await clickButton("SAUCE", ".topbar");
await kd(() => { const [t, a, g] = document.querySelectorAll(".dialog input[type=text]"); t.value = "My Piece"; a.value = "me"; g.value = "grp"; document.querySelector(".dialog textarea").value = "hello\nworld"; });
await clickButton("Save", ".dialog");
const sauceNow = await kd(() => window.kd.ed.doc.sauce);
check("the SAUCE editor sets title, author, group and comments, undoably", sauceNow.title === "My Piece" && sauceNow.author === "me" && sauceNow.comments.length === 2 && await kd(() => window.kd.ed.history.canUndo), JSON.stringify(sauceNow));
const withSauce = await kd(async () => { const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts"); const { ed } = window.kd; return core.parseAnsi(core.encodeAnsi(ed.comp.grid, { iceColors: false, sauce: ed.doc.sauce })).sauce.title; });
check("…and it goes out in the .ans", withSauce === "My Piece");

const [refChooser] = await Promise.all([page.waitForFileChooser(), clickButton("New reference image", ".layers")]);
await refChooser.accept([photo]);
await page.waitForFunction(() => window.kd.ed.active?.type === "reference");
// the image decodes asynchronously before it can be drawn
await page.waitForFunction(() => { const c = document.querySelector("canvas.refs"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }, { timeout: 5000 }).catch(() => {});
const refInfo = await kd(() => { const e = window.kd.ed, l = e.active; return { tool: e.tool, w: l.width, h: l.height, opacity: l.opacity, exported: e.comp.layers.some((c) => c.type === "reference") && e.comp.owner.some((o) => o >= 0 && e.comp.layers[o].type === "reference"), refsDrawn: (() => { const c = document.querySelector("canvas.refs"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })() }; });
check("a reference image shows on the canvas but owns no cells of the picture", refInfo.tool === "move" && refInfo.w === 40 && refInfo.h === 10 && !refInfo.exported && refInfo.refsDrawn > 1000, JSON.stringify(refInfo));
await drag([39, 9], [59, 9]);
check("Move's corner handle resizes the reference", await kd(() => window.kd.ed.active.width === 60));
await clickButton("convert to image layer", ".layers");
await page.waitForFunction(() => window.kd.ed.active?.type === "image");
check("…and it converts to a real image layer at the same size", await kd(() => { const l = window.kd.ed.active; return l.cols === 60 && l.x === 0 && l.cache.width === 60; }));

await kd(() => { const e = window.kd.ed; e.setActive(e.doc.layers[0].id); });
const preScale = await kd(() => ({ w: window.kd.ed.active.grid.width, g: window.kd.ed.active.grid.get(20, 4).glyph }));
await clickButton("scale", ".layers");
await kd(() => { const b = [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "200%"); b.click(); });
await clickButton("Scale", ".dialog .end");
await new Promise((r) => setTimeout(r, 300));
const scaled = await kd(() => ({ w: window.kd.ed.active.grid.width, h: window.kd.ed.active.grid.height, g: window.kd.ed.active.grid.get(40, 8).glyph }));
check("scale ×2 by cells doubles the layer and keeps its characters", scaled.w === preScale.w * 2 && scaled.h === 50 && scaled.g === preScale.g, JSON.stringify(scaled));
await mod(["Meta"], () => page.keyboard.press("z"));
check("scaling is one undo step", await kd(() => window.kd.ed.active.grid.width === 80));
await clickButton("scale", ".layers");
await kd(() => { const s = document.querySelector(".dialog select"); s.value = "rematch"; s.dispatchEvent(new Event("change", { bubbles: true })); const b = [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "50%"); b.click(); });
await clickButton("Scale", ".dialog .end");
await page.waitForFunction(() => window.kd.ed.active.grid.width === 40, { timeout: 5000 });
const remInfo = await kd(() => { const g = window.kd.ed.active.grid; let n = 0; for (let i = 0; i < g.present.length; i++) if (g.present[i]) n++; return { w: g.width, h: g.height, cells: n }; });
check("scale 50% by re-matching redraws the picture through shadeans at the new size", remInfo.w === 40 && remInfo.h === 13 && remInfo.cells > 20, JSON.stringify(remInfo));
await shot("16-more-tools");

// ===================================================== depth tags back in; opacity by re-matching
await page.goto("http://127.0.0.1:5183/?demo", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
const reopened = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd, comp = ed.comp, plan = core.planDepth(comp);
  const bytes = core.encodeAnsi(comp.grid, { iceColors: ed.doc.iceColors, sauce: ed.doc.sauce, depth: plan });
  const doc = core.documentFromArt(core.parseArt(bytes, "demo-3d.ans"));
  const same = core.composite(doc).grid.equals(comp.grid);
  ed.setDocument(doc, "demo-3d.ans");
  return { layers: doc.layers.map((l) => `${l.name}@${l.depth ?? 0}`), same };
});
check("a 3dBBS export reopens as one layer per depth plane, deepest first, same picture", reopened.same && reopened.layers.length === 3 && reopened.layers[0] === "depth −300@-300" && reopened.layers[2] === "at the screen@0", JSON.stringify(reopened));

await page.goto("http://127.0.0.1:5183/?demo", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
await kd(() => { const e = window.kd.ed; e.setActive(e.doc.layers[2].id); });
const opaque = await kd(() => { const c = window.kd.ed.comp; const own = [], other = []; for (let i = 0; i < c.owner.length; i++) (c.layers[c.owner[i]]?.type === "font" ? own : other).push(`${c.grid.glyph[i]}:${c.grid.fg[i]}:${c.grid.bg[i]}`); return { own, other, layerCells: window.kd.ed.doc.layers[2].cache.present.filter(Boolean).length }; });
await kd(() => { const s = [...document.querySelectorAll(".layers label.slider")].find((l) => l.textContent.startsWith("opacity")).querySelector("input"); s.value = "0.5"; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForFunction((first) => { const c = window.kd.ed.comp; for (let i = 0; i < c.owner.length; i++) if (c.layers[c.owner[i]]?.type === "font") return `${c.grid.glyph[i]}:${c.grid.fg[i]}:${c.grid.bg[i]}` !== first; return false; }, { timeout: 8000 }, opaque.own[0]).catch(() => {});
const half = await kd(() => { const c = window.kd.ed.comp; const own = [], other = []; for (let i = 0; i < c.owner.length; i++) (c.layers[c.owner[i]]?.type === "font" ? own : other).push(`${c.grid.glyph[i]}:${c.grid.fg[i]}:${c.grid.bg[i]}`); return { own, other, layerCells: window.kd.ed.doc.layers[2].cache.present.filter(Boolean).length, opacity: window.kd.ed.doc.layers[2].opacity }; });
const changedOwn = half.own.filter((v, i) => v !== opaque.own[i]).length;
check("at 50% opacity the title's cells in the picture are re-matched blends; nothing else moves; the layer itself is untouched", half.opacity === 0.5 && changedOwn > half.own.length * 0.3 && JSON.stringify(half.other) === JSON.stringify(opaque.other) && half.layerCells === opaque.layerCells, `${changedOwn}/${half.own.length} owned cells changed`);
await mod(["Meta"], () => page.keyboard.press("z"));
await new Promise((r) => setTimeout(r, 600));
check("undo puts the opaque cells back", await kd((first) => { const c = window.kd.ed.comp; for (let i = 0; i < c.owner.length; i++) if (c.layers[c.owner[i]]?.type === "font") return `${c.grid.glyph[i]}:${c.grid.fg[i]}:${c.grid.bg[i]}` === first; }, opaque.own[0]));
await kd(() => { const s = [...document.querySelectorAll(".layers label.slider")].find((l) => l.textContent.startsWith("opacity")).querySelector("input"); s.value = "0.4"; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); });
await new Promise((r) => setTimeout(r, 900));
await shot("17-opacity");

check("every tool is an icon with a hover tip", await kd(() => { const b = [...document.querySelectorAll(".palette button")]; return b.length === 14 && b.every((x) => x.querySelector("svg") && x.title.length > 10 && !x.textContent.trim()); }));
await shot("12-ui");

check("no console errors or page errors", problems.length === 0, problems.slice(0, 3).join(" ; "));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
