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
// this page is not a first launch: the welcome piece is checked on its own, in a fresh profile, at the end
await page.evaluateOnNewDocument(() => { try { localStorage.setItem("jockoshop.welcomed", "1"); } catch { /* */ } });
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
/** Add a layer through the "Add layer" menu by the item's label. */
const addLayerVia = async (label) => {
  await kd(() => document.querySelector(".add-layer").click());
  await kd((label) => { const b = [...document.querySelectorAll(".add-menu button")].find((b) => b.textContent.startsWith(label)); if (!b) throw new Error(`no add item ${label}`); b.click(); }, label);
};
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
await addLayerVia("Cells layer");
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
  const [chooser] = await Promise.all([page.waitForFileChooser(), addLayerVia("Image")]);
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

// what a saved and reloaded project makes of the image layers so far — taken
// before the backdrop fixture below, which embeds a third source image
const imgRoundTrip = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd;
  const back = core.loadProject(core.saveProject(ed.doc));
  const imgs = back.layers.filter((l) => l.type === "image");
  return { same: core.composite(back, { glyphs: ed.glyphs }).grid.equals(ed.comp.grid), images: imgs.length, recipeKept: imgs[0].cols === 40 && imgs[0].options.truecolor === true, assets: [...back.assets.keys()].filter((k) => k.startsWith("assets/images/")).length };
});

// --- cutting a background out of an image (a subject on a flat, opaque backdrop)
const SKY = [80, 140, 220];
const ball = join(out, "fixture-ball.png");
writeFileSync(ball, png(640, 320, (x, y) => {
  const r = Math.hypot(x - 320, y - 160) / 140;
  if (r > 1) return [...SKY, 255];
  const l = Math.max(0.15, 1 - r * 0.8);
  return [Math.round(230 * l), Math.round(120 * l), Math.round(40 * l), 255];
}));
/** cells still showing the backdrop's colour — the halo a cell-by-cell delete leaves behind */
const skyCells = () => kd(() => {
  const ed = window.kd.ed, l = ed.active, g = l.cache ?? l.grid, pal = ed.doc.palette;
  const skyish = (c) => { const p = pal[c]; return p && p[2] > p[0] + 40 && p[2] > 120; };
  let present = 0, withSky = 0, halves = 0;
  for (let i = 0; i < g.present.length; i++) {
    const p = g.present[i];
    if (!p) continue;
    present++;
    if (g.glyph[i] === 223 || g.glyph[i] === 220) halves++;
    if (((p & 2) && skyish(g.fg[i])) || ((p & 4) && skyish(g.bg[i]))) withSky++;
  }
  return { present, withSky, halves };
});
await addImage(ball);
const solid = await skyCells();
check("image layer: an opaque backdrop arrives as cells like any other", solid.present > 1000 && solid.withSky > 0, JSON.stringify(solid));

// the wand works on a live image layer, so Delete has to do something there too
await kd(() => { window.kd.ed.chooseTool("wand"); });
await page.mouse.click((await cellXY(1, 1)).x, (await cellXY(1, 1)).y);
const wandedLive = await kd(() => window.kd.ed.selection?.count() ?? 0);
await page.keyboard.press("Delete");
await settle();
const maskedLive = await kd(() => { const l = window.kd.ed.active; return { type: l.type, mask: !!l.mask?.enabled, hidden: l.mask ? [...l.mask.data].filter((v) => !v).length : 0 }; });
check("Delete on a live layer hides the selection behind a mask instead of refusing",
  maskedLive.type === "image" && maskedLive.mask && maskedLive.hidden === wandedLive, `${JSON.stringify(maskedLive)} for ${wandedLive} selected`);
await kd(() => { window.kd.ed.undo(); window.kd.ed.setSelection(null); });
await settle();
check("undoing that gives the image back whole", await kd(() => !window.kd.ed.active.mask?.enabled));

// keying the backdrop out in the source pixels, before shadeans can blend it into a cell
await kd(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("cut out background")).querySelector("input").click());
await settle();
await settle();
const matted = await skyCells();
const matteOpts = await kd(() => window.kd.ed.active.matte);
check("cut out background: keys on the source's border colour by default",
  matteOpts && matteOpts.edges === true && Math.abs(((matteOpts.color >> 16) & 0xff) - SKY[0]) < 12, JSON.stringify(matteOpts));
check("cut out background: no cell is left holding any of the backdrop",
  matted.withSky === 0 && matted.present > 200 && matted.present < solid.present * 0.6,
  `${solid.present} cells with ${solid.withSky} showing the backdrop -> ${matted.present} with ${matted.withSky}`);
check("cut out background: the silhouette lands on half blocks, not whole cells", matted.halves >= solid.halves, `${solid.halves} -> ${matted.halves} half blocks`);
await shot("09b-image-matte");
check("cut out background: the source image is untouched, so it can be taken back",
  await kd(() => { const l = window.kd.ed.active; return l.type === "image" && l.cols > 0 && window.kd.ed.doc.assets.has(l.source); }));
const mattedRoundTrip = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const back = core.loadProject(core.saveProject(window.kd.ed.doc));
  const m = back.layers.find((l) => l.type === "image" && l.matte)?.matte;
  return m ? { tolerance: m.tolerance, edges: m.edges, color: m.color } : null;
});
check("cut out background: the recipe is saved with the project", mattedRoundTrip !== null && mattedRoundTrip.edges === true, JSON.stringify(mattedRoundTrip));
await kd(() => [...document.querySelectorAll("label.check")].find((l) => l.textContent.includes("cut out background")).querySelector("input").click());
await settle();
check("cut out background: turning it off brings the backdrop back", (await skyCells()).withSky > 0);

// --- the other half of the problem: art that is already cells, with no source
// to re-key. Rasterize the backdrop version and delete it the old way.
const fringeAfterDelete = async (clean) => {
  await kd((c) => { const ed = window.kd.ed; ed.cleanEdges = c; ed.setSelection(null); }, clean);
  await kd(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "rasterize").click());
  await settle();
  await kd(() => { window.kd.ed.chooseTool("wand"); });
  const p = await cellXY(1, 1);
  await page.mouse.click(p.x, p.y);
  // the colour the selection is made of: what a delete takes away, and what it can leave behind
  const key = await kd(async () => {
    const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
    const ed = window.kd.ed, l = ed.active, sel = ed.selection;
    return core.dominantColor(l.grid, { palette: ed.doc.palette, glyphs: ed.glyphs }, (x, y) => sel.has(x + l.x, y + l.y));
  });
  await page.keyboard.press("Delete");
  await settle();
  const left = await kd((k) => {
    const ed = window.kd.ed, l = ed.active, g = l.grid, sel = ed.selection;
    // a cell is "on the edge" when it survived the delete but touches what went
    const onEdge = (x, y) => {
      const dx = x + l.x, dy = y + l.y;
      if (sel.has(dx, dy)) return false;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (sel.has(dx + i, dy + j)) return true;
      return false;
    };
    let present = 0, holdingKey = 0, edgeHoldingKey = 0;
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        const i = y * g.width + x, p = g.present[i];
        if (!p) continue;
        present++;
        if (!(((p & 2) && g.fg[i] === k) || ((p & 4) && g.bg[i] === k))) continue;
        holdingKey++;
        if (onEdge(x, y)) edgeHoldingKey++;
      }
    }
    return { present, holdingKey, edgeHoldingKey };
  }, key);
  const status = await kd(() => window.kd.ed.status);
  await mod(["Meta"], () => page.keyboard.press("z"));   // undo the delete
  await settle();
  await mod(["Meta"], () => page.keyboard.press("z"));   // and the rasterize
  await settle();
  return { key, left, status };
};
const plain = await fringeAfterDelete(false);
const cleaned = await fringeAfterDelete(true);
check("without 'clean edges', a wand delete leaves the deleted colour behind along the edge",
  plain.left.edgeHoldingKey > 0, `colour ${plain.key}: ${JSON.stringify(plain.left)}`);
check("'clean edges' takes that colour out of the cells around the selection",
  cleaned.left.edgeHoldingKey === 0,
  `${plain.left.edgeHoldingKey} edge cells kept it -> ${cleaned.left.edgeHoldingKey}; ${cleaned.status}`);
check("'clean edges' leaves the same colour alone away from the edge, so the subject keeps it",
  cleaned.left.holdingKey === plain.left.holdingKey - plain.left.edgeHoldingKey,
  `${plain.left.holdingKey} cells held it, ${plain.left.edgeHoldingKey} of them on the edge -> ${cleaned.left.holdingKey} left`);
check("'clean edges' keeps the subject: it removes a colour, it does not erase cells wholesale",
  cleaned.left.present > plain.left.present * 0.8, `${plain.left.present} cells -> ${cleaned.left.present}`);
await shot("09c-clean-edges");
await kd(() => { const ed = window.kd.ed; ed.setSelection(null); ed.removeLayer(ed.active.id); });

// stray cells left dotted around a subject
await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const l = core.createCellsLayer("specks", 10, 3);
  l.grid.set(0, 0, { glyph: 219, fg: 7, bg: 0 });   // on its own
  l.grid.set(9, 2, { glyph: 219, fg: 7, bg: 0 });   // and another
  l.grid.set(5, 1, { glyph: 219, fg: 7, bg: 0 });   // a pair, which stays
  l.grid.set(6, 1, { glyph: 219, fg: 7, bg: 0 });
  window.kd.ed.addLayer(l, "specks");
});
await kd(() => { window.kd.ed.chooseTool("marquee"); });
await kd(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "despeckle").click());
const despeckled = await kd(() => {
  const g = window.kd.ed.active.grid;
  return { left: [...g.present].filter(Boolean).length, pair: !!g.present[g.index(5, 1)] && !!g.present[g.index(6, 1)], status: window.kd.ed.status };
});
check("despeckle drops cells with nothing beside them and keeps the rest", despeckled.left === 2 && despeckled.pair, JSON.stringify(despeckled));
await mod(["Meta"], () => page.keyboard.press("z"));
check("undo brings the specks back", await kd(() => [...window.kd.ed.active.grid.present].filter(Boolean).length) === 4);
await kd(() => { const ed = window.kd.ed; ed.removeLayer(ed.active.id); });

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
const stillFocused2 = await stepField("exact", 7);
check("…and a field that rebuilds its panel on commit (depth) steps 7 times as one change", stillFocused2 && await kd(() => window.kd.ed.active.depth) === depthBefore - 7 && await kd(() => window.kd.ed.history.canUndo), `${depthBefore} -> ${await kd(() => window.kd.ed.active.depth)}`);
await page.keyboard.press("Tab");
// hold the mouse on the spin button: it repeats on its own
const undoCount = await kd(() => window.kd.ed.history.position);
const spinBtn = await kd(() => { const b = [...document.querySelectorAll(".field")].find((f) => f.textContent.startsWith("exact")).querySelector(".spin:last-child").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
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

await addLayerVia("Cells layer");
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
check("left sidebar follows the tool", JSON.stringify([forDraw, forWand, forFind, forType]) === JSON.stringify([
  ["brush", "character"], ["selectTool", "selection", "brush.aside", "character.aside"],
  ["find", "brush.aside", "character.aside"], ["font", "brush.aside", "character.aside"],
]), JSON.stringify([forDraw, forWand, forFind, forType]));
// …and the brush is never taken away, only folded up: a selection's fill draws with it
const openness = await kd(() => [...document.querySelectorAll(".toolbox details.sec")].map((d) => `${d.dataset.panel}:${d.open ? "open" : "shut"}`));
check("under a tool that only borrows the brush it is collapsed, not gone", JSON.stringify(openness) === JSON.stringify(["font:open", "brush.aside:shut", "character.aside:shut"]), JSON.stringify(openness));
await kd(() => { const e = window.kd.ed; e.activeId = e.doc.layers[0].id; e.emit("doc"); });
await page.keyboard.press("w");
await kd(() => document.querySelector('.toolbox details[data-panel="brush.aside"] > summary').click());
const swatchesReachable = await kd(() => !!document.querySelector('.toolbox details[data-panel="brush.aside"] .swatch'));
check("…and opening it there gives the swatches the wand's fill will use", swatchesReachable);
await kd(() => { const s = document.querySelectorAll('.toolbox details[data-panel="brush.aside"] .swatch')[9]; s.click(); });
check("…which set the brush like anywhere else", await kd(() => window.kd.ed.fg === 9));
await page.keyboard.press("b");
const backToDraw = await kd(() => { const d = document.querySelector('.toolbox details[data-panel="brush"]'); return d && d.open; });
check("expanding it beside the wand does not follow you back to the brush tool", backToDraw === true);
// the tool follows the layer
const clickLayer = (name) => kd((name) => [...document.querySelectorAll(".layer")].find((r) => r.querySelector(".name").textContent === name).click(), name);
const toolNow = () => kd(() => window.kd.ed.tool);
await clickLayer("backdrop");
await page.keyboard.press("b");
await clickLayer("title (live text)");
check("selecting a text layer with a brush active switches to Type, with its text on the left", await toolNow() === "text" && (await leftPanels())[0] === "font", `${await toolNow()} ${JSON.stringify(await leftPanels())}`);
const dimmed = await kd(() => [...document.querySelectorAll(".palette .na")].map((b) => b.getAttribute("aria-label").split(" (")[0]));
check("tools that can't act on a text layer are dimmed (the shape tools place a shape layer, so they can)", JSON.stringify(dimmed) === JSON.stringify(["Brush", "Eraser", "Fill", "Pick up", "Find & replace"]), dimmed.join(", "));
await page.keyboard.press("h");
check("choosing a dimmed tool is refused, with the reason", await toolNow() === "text" && (await kd(() => window.kd.ed.status)).includes("rasterize"), await kd(() => window.kd.ed.status));
await clickLayer("backdrop");
check("going back to a cells layer brings the brush back", await toolNow() === "brush");
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

// --- shape styles: box drawing, half blocks, fills; brush size
await page.keyboard.press("r");
await kd(() => { const e = window.kd.ed; e.glyph = 219; e.fg = 15; e.bg = 1; e.emit("ui"); });
await clickButton("single line", ".toolbox"); await clickButton("colour", ".toolbox");
await drag([10, 14], [20, 18]);
const box1 = await kd(() => { const g = window.kd.ed.comp.grid; return { tl: g.get(10, 14).glyph, br: g.get(20, 18).glyph, top: g.get(15, 14).glyph, side: g.get(10, 16).glyph, inside: g.get(15, 16) }; });
check("rectangle in single-line box drawing, with a colour fill inside", box1.tl === 218 && box1.br === 217 && box1.top === 196 && box1.side === 179 && box1.inside.glyph === 32 && box1.inside.bg === 1, JSON.stringify(box1));
await clickButton("double line", ".toolbox"); await clickButton("hollow", ".toolbox");
await drag([25, 14], [35, 18]);
const box2 = await kd(() => { const g = window.kd.ed.comp.grid; return { tl: g.get(25, 14).glyph, top: g.get(30, 14).glyph, inside: g.get(30, 16) }; });
check("…and double-line, hollow (the inside keeps its old background)", box2.tl === 201 && box2.top === 205 && box2.inside.bg !== 1 && box2.inside.glyph !== 205, JSON.stringify(box2));
await clickButton("half block", ".toolbox");
await drag([40, 29], [50, 35], { half: true });                       // lower half of row 14 down to lower half of row 17
const box3 = await kd(() => { const g = window.kd.ed.comp.grid; return { top: g.get(45, 14), side: g.get(40, 16), inside: g.get(45, 16).glyph, below: g.get(45, 18).glyph }; });
check("half-block rectangle paints half rows: the top edge is a lone lower half", box3.top.glyph === 220 && box3.top.fg === 15 && box3.side.glyph === 219 && box3.inside !== 219 && box3.inside !== 220 && box3.below !== 220, JSON.stringify(box3));
await page.keyboard.press("l");
await clickButton("single line", ".toolbox");
await drag([55, 14], [70, 14]);
await drag([55, 15], [70, 19]);
const lines = await kd(() => { const g = window.kd.ed.comp.grid; return { straight: g.get(60, 14).glyph, diagonal: g.get(55, 15).glyph }; });
check("a straight box-drawing line is ─; a diagonal falls back to the brush character", lines.straight === 196 && lines.diagonal === 219, JSON.stringify(lines));
await page.keyboard.press("b");
await page.keyboard.press("]"); await page.keyboard.press("]");
check("] grows the brush and the panel shows it", await kd(() => window.kd.ed.brushSize === 3 && document.querySelector(".toolbox .stepper .value").textContent === "3"));
await kd(() => { const e = window.kd.ed; e.fg = 14; e.bg = 0; e.emit("ui"); });
await drag([60, 22], [60, 22]);
const big = await kd(() => { const g = window.kd.ed.comp.grid; return { a: g.get(59, 21).glyph, b: g.get(61, 23).glyph, c: g.get(62, 22).glyph, d: g.get(60, 20).glyph }; });
check("a size-3 pencil paints a 3×3 square around the click", big.a === 219 && big.b === 219 && big.c !== 219 && big.d !== 219, JSON.stringify(big));
await page.keyboard.press("["); await page.keyboard.press("[");
// --- the brush's other modes: shading steps the ramp, colorize keeps the characters
check("B is the brush in character mode; H is the brush in half-block mode", await kd(() => window.kd.ed.tool === "brush" && window.kd.ed.brushMode === "char"));
await clickButton("shading", ".toolbox");
await kd(() => { const e = window.kd.ed; e.fg = 11; e.bg = 0; e.emit("ui"); });
await drag([65, 20], [70, 20]); await drag([65, 20], [70, 20]); await drag([65, 20], [70, 20]);
check("three shading strokes take empty cells to ▓ in the brush colours", await kd(() => { const c = window.kd.ed.comp.grid.get(67, 20); return c.glyph === 178 && c.fg === 11; }));
await drag([65, 20], [70, 20], { button: "right" });
check("…and the right button steps back down to ▒", await kd(() => window.kd.ed.comp.grid.get(67, 20).glyph === 177));
await clickButton("colorize", ".toolbox");
await kd(() => { const e = window.kd.ed; e.fg = 13; e.drawBg = false; e.emit("ui"); });
await drag([65, 20], [70, 20]);
check("colorize recolours the foreground and keeps the character", await kd(() => { const c = window.kd.ed.comp.grid.get(67, 20); return c.glyph === 177 && c.fg === 13; }));
await kd(() => { const e = window.kd.ed; e.drawBg = true; e.brushMode = "char"; e.emit("ui"); });
await page.keyboard.press("h");
check("H: the hover footprint is a half cell", await kd(() => window.kd.ed.brushMode === "half" && window.kd.tools.find((t) => t.id === "brush").footprint({ x: 1, y: 1, hy: 3 }).half));
await page.keyboard.press("b");
await kd(() => { const e = window.kd.ed; e.shapeStyle = "char"; e.shapeFill = "none"; e.emit("ui"); });
await shot("15b-shapes");

// --- shape layers: Add layer → Shape, drag it, restyle from the left, reshape by its handles, then free transform of cells
/** page coordinates of a point in document pixels (a handle knob) */
const docXY = (px, py) => kd((px, py) => { const r = document.querySelector("canvas.overlay").getBoundingClientRect(), z = window.kd.ed.zoom; return { x: r.left + px * z, y: r.top + py * z }; }, px, py);
const dragFromKnob = async (px, py, to) => { const a = await docXY(px, py), b = await cellXY(to[0], to[1]); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up(); };
await page.keyboard.press("r");
await clickButton("double line", ".toolbox");
const layersBefore = await kd(() => window.kd.ed.doc.layers.length);
await addLayerVia("Shape");
check("Add layer → Shape adds nothing yet: it arms the shape tools", await kd((n) => window.kd.ed.pendingShape && window.kd.ed.tool === "rect" && window.kd.ed.doc.layers.length === n, layersBefore));
await drag([5, 14], [25, 20]);
const shapeL = await kd(() => { const l = window.kd.ed.active; return { type: l.type, kind: l.kind, style: l.style, x: l.x, y: l.y, w: l.width, h: l.height, tl: window.kd.ed.comp.grid.get(5, 14).glyph, pending: window.kd.ed.pendingShape }; });
check("…and the drag places a live rectangle layer of that box, in double lines", shapeL.type === "shape" && shapeL.kind === "rect" && shapeL.style === "double" && shapeL.x === 5 && shapeL.y === 14 && shapeL.w === 21 && shapeL.h === 7 && shapeL.tl === 201 && !shapeL.pending, JSON.stringify(shapeL));
await clickButton("half block", ".toolbox");
const asHalf = await kd(() => ({ style: window.kd.ed.active.style, top: window.kd.ed.comp.grid.get(15, 14).glyph }));
check("the Shape panel on the left restyles the selected shape: half blocks", asHalf.style === "half" && asHalf.top === 223, JSON.stringify(asHalf));
await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
check("…undoably", await kd(() => window.kd.ed.active.style === "double" && window.kd.ed.comp.grid.get(5, 14).glyph === 201 && window.kd.ed.shapeStyle === "double"));
await kd(() => document.querySelectorAll(".toolbox .swatch")[12].click());
check("the brush swatches recolour the selected shape", await kd(() => window.kd.ed.active.fg === 12 && window.kd.ed.comp.grid.get(5, 14).fg === 12));
await dragFromKnob(26 * 8, 21 * 16, [35, 22]);   // the bottom-right knob, with the rectangle tool still active
const resized = await kd(() => { const l = window.kd.ed.active; return { type: l.type, w: l.width, h: l.height, br: window.kd.ed.comp.grid.get(35, 22).glyph, old: window.kd.ed.comp.grid.get(25, 20).glyph, n: window.kd.ed.doc.layers.length }; });
check("dragging a corner handle with the shape tool reshapes it (no new layer)", resized.type === "shape" && resized.w === 31 && resized.h === 9 && resized.br === 188 && resized.old !== 188 && resized.n === layersBefore + 1, JSON.stringify(resized));
await drag([10, 16], [20, 18]);   // inside the shape: moves it
check("dragging inside the shape moves it", await kd(() => window.kd.ed.active.x === 15 && window.kd.ed.active.y === 16 && window.kd.ed.comp.grid.get(15, 16).glyph === 201));
await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
await drag([50, 14], [60, 18]);   // outside it: another shape layer
check("dragging outside the shape places another shape layer", await kd((n) => window.kd.ed.doc.layers.length === n + 2 && window.kd.ed.active.x === 50, layersBefore));
await kd(() => window.kd.ed.removeLayer(window.kd.ed.activeId));
await clickButton("rasterize", ".layers");
check("rasterize turns it into cells that keep the drawing", await kd(() => window.kd.ed.active.type === "cells" && window.kd.ed.comp.grid.get(35, 22).glyph === 188));
// free transform of the cells: the handles frame the layer's content; a corner scales it nearest-neighbour
await page.keyboard.down("Meta"); await page.keyboard.press("t"); await page.keyboard.up("Meta");
check("Cmd+T is the Move / transform tool", await kd(() => window.kd.ed.tool === "move"));
await dragFromKnob(36 * 8, 23 * 16, [46, 24]);
const xfScaled = await kd(() => { const g = window.kd.ed.comp.grid; return { br: g.get(46, 24).glyph, tl: g.get(5, 14).glyph, old: g.get(35, 22).glyph }; });
check("scaling a cells layer's content by a corner keeps the box's corners at the new corners", xfScaled.br === 188 && xfScaled.tl === 201 && xfScaled.old !== 188, JSON.stringify(xfScaled));
await page.keyboard.down("Meta"); await page.keyboard.press("z"); await page.keyboard.up("Meta");
check("…as one undo step", await kd(() => window.kd.ed.comp.grid.get(35, 22).glyph === 188 && window.kd.ed.comp.grid.get(46, 24).glyph !== 188));
await page.keyboard.press("m");
await drag([5, 14], [8, 15]);
await page.keyboard.press("v");
await drag([6, 14], [16, 24]);   // inside the selection: moves just those cells
const movedSel = await kd(() => { const g = window.kd.ed.comp.grid, s = window.kd.ed.selection; return { to: g.get(15, 24).glyph, from: g.get(5, 14).glyph, kept: g.get(35, 22).glyph, sel: s && s.has(15, 24) && !s.has(5, 14) }; });
check("with a selection, Move lifts and moves only the selected cells, and the selection follows", movedSel.to === 201 && movedSel.from !== 201 && movedSel.kept === 188 && movedSel.sel === true, JSON.stringify(movedSel));
await page.keyboard.press("Escape");   // Cmd+D is Moebius's Default Colour now; Escape deselects
await kd(() => { const e = window.kd.ed; e.shapeStyle = "char"; e.emit("ui"); });
await shot("15c-shape-layer");

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

// the 3D wiggle export previews and tunes the animation before saving
await clickButton("Export", ".topbar");
await clickButton("3D wiggle", ".menu");
const wig = await kd(() => ({ canvas: !!document.querySelector(".dialog canvas.wiggle-preview"), info: document.querySelector(".dialog p.hint:last-of-type").textContent, w: document.querySelector(".dialog canvas").width }));
check("the wiggle dialog opens with an animated preview and says what it will save", wig.canvas && wig.w === 640 && /24 frames of 640×400/.test(wig.info) || /at the glass/.test(wig.info), JSON.stringify(wig));
await kd(() => { const s = [...document.querySelectorAll(".dialog .slider input")][1]; s.value = "8"; s.dispatchEvent(new Event("input")); const sel = [...document.querySelectorAll(".dialog select")][1]; sel.value = "2"; sel.dispatchEvent(new Event("change")); });
const wig2 = await kd(() => ({ info: document.querySelector(".dialog p.hint:last-of-type").textContent, w: document.querySelector(".dialog canvas").width }));
check("…and follows the frame count and size settings", wig2.w === 1280 && (/8 frames of 1280×800/.test(wig2.info) || /at the glass/.test(wig2.info)), JSON.stringify(wig2));
await clickButton("Cancel", ".dialog");
check("Cancel closes it without saving", await kd(() => !document.querySelector(".dialog")));
const withSauce = await kd(async () => { const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts"); const { ed } = window.kd; return core.parseAnsi(core.encodeAnsi(ed.comp.grid, { iceColors: false, sauce: ed.doc.sauce })).sauce.title; });
check("…and it goes out in the .ans", withSauce === "My Piece");

const [refChooser] = await Promise.all([page.waitForFileChooser(), addLayerVia("Reference image")]);
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

// font picker: arrow keys step through the fonts, previewing each
await addLayerVia("TheDraw text");
await page.waitForSelector(".font-list .font-item");
await page.type(".dialog input[type=search]", "cyber");
const layersBeforePick = await kd(() => window.kd.ed.doc.layers.length);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.waitForSelector(".font-preview-box canvas", { timeout: 5000 }).catch(() => {});   // the font file is fetched first
const stepped = await kd(() => ({ sel: document.querySelector(".font-item.selected")?.textContent.split("cyb")[0], idx: [...document.querySelectorAll(".font-item")].findIndex((i) => i.classList.contains("selected")), preview: !!document.querySelector(".font-preview-box canvas") }));
check("in the font picker, Down from the filter box steps through the list and previews", stepped.idx === 1 && stepped.preview, JSON.stringify(stepped));
await kd(() => document.querySelectorAll(".font-item")[5].click());
await page.keyboard.press("ArrowUp");
check("…and after clicking an item the arrows still work", await kd(() => [...document.querySelectorAll(".font-item")].findIndex((i) => i.classList.contains("selected"))) === 4);
await page.keyboard.press("Enter");
await page.waitForFunction((n) => window.kd.ed.doc.layers.length > n, { timeout: 5000 }, layersBeforePick);
check("Enter picks the font and adds the text layer", await kd(() => { const l = window.kd.ed.active; return l.type === "font" && l.runs[0].font.toLowerCase().includes("cyb"); }));
await page.keyboard.press("Escape");

// --- sorting and the row range: with ~3,500 fonts, finding one is the job
const rows = () => kd(() => [...document.querySelectorAll(".font-item")].map((i) => ({
  name: i.children[0].textContent, type: i.children[1].textContent, h: Number(i.children[2].textContent),
})));
const sortBy = async (label) => {
  await kd((l) => [...document.querySelectorAll(".font-head .col")].find((c) => c.textContent.startsWith(l)).click(), label);
  await settle();
};
await kd(() => window.kd.ed.chooseTool("text"));
await clickButton("+ font switch", ".toolbox").catch(() => {});
await kd(() => [...document.querySelectorAll(".toolbox .font-name")][0].click());
await page.waitForSelector(".font-list .font-item", { timeout: 5000 });
const defaultOrder = await rows();
check("the list starts in name order, so it can be read", defaultOrder.length > 2
  && defaultOrder.slice(0, 20).every((r, i, a) => i === 0 || a[i - 1].name.toLowerCase() <= r.name.toLowerCase()),
  JSON.stringify(defaultOrder.slice(0, 3)));

await sortBy("Rows");
const byRows = await rows();
check("clicking Rows sorts by height", byRows.every((r, i, a) => i === 0 || a[i - 1].h <= r.h), JSON.stringify(byRows.slice(0, 3)));
await sortBy("Rows");
const byRowsDesc = await rows();
check("clicking it again reverses the order", byRowsDesc.every((r, i, a) => i === 0 || a[i - 1].h >= r.h) && byRowsDesc[0].h >= byRows[0].h, `${byRows[0].h}..${byRows.at(-1).h} -> ${byRowsDesc[0].h}..${byRowsDesc.at(-1).h}`);
await sortBy("Type");
check("and by type", (await rows()).every((r, i, a) => i === 0 || a[i - 1].type <= r.type));
await sortBy("Name");

// the point of the range: ask for one size and stop being shown the shorter ones
const setRows = async (lo, hi) => {
  await kd((a, b) => {
    const nums = [...document.querySelectorAll(".dialog input[type=number]")];
    nums[0].value = a; nums[0].dispatchEvent(new Event("input", { bubbles: true }));
    nums[1].value = b; nums[1].dispatchEvent(new Event("input", { bubbles: true }));
  }, String(lo), String(hi));
  await settle();
};
await setRows("", 8);
const maxOnly = await rows();
check("a max on its own still lets the shorter fonts through — the old complaint",
  maxOnly.every((r) => r.h <= 8) && maxOnly.some((r) => r.h < 8), JSON.stringify([...new Set(maxOnly.map((r) => r.h))]));
await setRows(8, 8);
const exactly = await rows();
check("the same number at both ends gives exactly that size", exactly.length > 0 && exactly.every((r) => r.h === 8), JSON.stringify([...new Set(exactly.map((r) => r.h))]));
await setRows(4, "");
await kd(() => [...document.querySelectorAll(".dialog button")].find((b) => b.textContent === "only").click());
await settle();
const onlyBtn = await rows();
check("“only” snaps the range shut on the min", onlyBtn.length > 0 && onlyBtn.every((r) => r.h === 4), JSON.stringify([...new Set(onlyBtn.map((r) => r.h))]));
await page.keyboard.press("Escape");
await settle();

// --- randomize: another font, same height, on the canvas, undoable
const runFont = () => kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const ed = window.kd.ed, l = ed.active, run = l.runs[0];
  const f = core.fontsOfAsset(ed.doc, run.font)[run.fontIndex];
  const g = l.cache;
  let ink = 0;
  if (g) for (let i = 0; i < g.present.length; i++) if (g.present[i]) ink++;
  return { name: f?.name ?? "?", height: f?.height ?? 0, file: run.font, index: run.fontIndex, cells: ink, rows: g?.height ?? 0 };
});
await kd(() => window.kd.ed.chooseTool("text"));
await page.waitForSelector(".toolbox .roll", { timeout: 5000 });
const beforeRoll = await runFont();
await kd(() => document.querySelector(".toolbox .roll").click());
await page.waitForFunction((was) => {
  const r = window.kd.ed.active.runs[0];
  return `${r.font}#${r.fontIndex}` !== was;
}, { timeout: 5000 }, `${beforeRoll.file}#${beforeRoll.index}`).catch(() => {});
await settle();
const afterRoll = await runFont();
check("the dice picks a different font", `${afterRoll.file}#${afterRoll.index}` !== `${beforeRoll.file}#${beforeRoll.index}`,
  `${beforeRoll.name} -> ${afterRoll.name}`);
check("…of the same height, so the layout does not jump", afterRoll.height === beforeRoll.height && afterRoll.rows === beforeRoll.rows,
  `${beforeRoll.height} rows tall, ${beforeRoll.rows} cells -> ${afterRoll.height} / ${afterRoll.rows}`);
check("…and it is drawn on the canvas, not just named", afterRoll.cells > 0 && afterRoll.cells !== beforeRoll.cells,
  `${beforeRoll.cells} cells -> ${afterRoll.cells}`);
check("…and says which font you got", /rows\. Roll again/.test(await kd(() => window.kd.ed.status)), await kd(() => window.kd.ed.status));
await mod(["Meta"], () => page.keyboard.press("z"));
await settle();
const undone = await runFont();
check("undo puts the original font back", `${undone.file}#${undone.index}` === `${beforeRoll.file}#${beforeRoll.index}` && undone.cells === beforeRoll.cells,
  `${afterRoll.name} -> ${undone.name}`);
// rolling twice never hands back the font you already had
const seen = new Set([`${beforeRoll.file}#${beforeRoll.index}`]);
let repeats = 0;
for (let i = 0; i < 4; i++) {
  const was = await runFont();
  await kd(() => document.querySelector(".toolbox .roll").click());
  await settle();
  const now = await runFont();
  if (`${now.file}#${now.index}` === `${was.file}#${was.index}`) repeats++;
  if (now.height !== beforeRoll.height) repeats += 100;
  seen.add(`${now.file}#${now.index}`);
}
check("rolling again always moves, and never off the height", repeats === 0 && seen.size > 2, `${seen.size} different fonts, ${repeats} repeats`);

// --- unsaved changes: save now / proceed anyway / cancel
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
await kd(() => { const e = window.kd.ed; e.glyph = 65; e.fg = 15; e.bg = 0; e.emit("ui"); });
await page.keyboard.press("b");
await drag([3, 3], [9, 3]);
check("the document is dirty after drawing", await kd(() => window.kd.ed.dirty));
const openNew = async () => { await page.keyboard.down("Meta"); await page.keyboard.press("n"); await page.keyboard.up("Meta"); await page.waitForSelector(".dialog", { timeout: 5000 }); };
await openNew();
const asked = await kd(() => ({ title: document.querySelector(".dialog h3").textContent, buttons: [...document.querySelectorAll(".dialog button")].map((b) => b.textContent) }));
check("New with unsaved changes asks, with three ways out", asked.title === "Unsaved changes" && JSON.stringify(asked.buttons) === JSON.stringify(["Cancel", "Proceed anyway", "Save now"]), JSON.stringify(asked));
await clickButton("Cancel", ".dialog");
check("Cancel keeps the document and its changes", await kd(() => !document.querySelector(".dialog") && window.kd.ed.dirty && window.kd.ed.comp.grid.get(5, 3).glyph === 65));
await openNew();
await page.keyboard.press("Escape");
check("Escape is Cancel too", await kd(() => !document.querySelector(".dialog") && window.kd.ed.comp.grid.get(5, 3).glyph === 65));
await openNew();
await clickButton("Proceed anyway", ".dialog");
await page.waitForFunction(() => window.kd.ed.fileName === "untitled" && !window.kd.ed.dirty, { timeout: 5000 });
check("Proceed anyway throws the changes away and starts the new document", await kd(() => window.kd.ed.comp.grid.get(5, 3).glyph !== 65 && !document.querySelector(".dialog")));
await drag([3, 3], [9, 3]);
// the real Save As opens an OS picker that headless Chrome never answers, so only the write is stubbed
await kd(() => { window.__saved = 0; window.kd.io.saveAs = async () => { window.__saved++; return "stubbed.jock"; }; });
await openNew();
await clickButton("Save now", ".dialog");
await page.waitForFunction(() => window.kd.ed.fileName === "untitled" && !window.kd.ed.dirty && !document.querySelector(".dialog"), { timeout: 8000 });
check("Save now saves first, then does what was asked", await kd(() => window.__saved === 1 && window.kd.ed.comp.grid.get(5, 3).glyph !== 65));

// a save the user backs out of stops the whole thing: the document is still there
await drag([3, 3], [9, 3]);
await kd(() => { window.kd.io.saveAs = async () => null; });   // null = the picker was cancelled
await openNew();
await clickButton("Save now", ".dialog");
await new Promise((r) => setTimeout(r, 300));
check("backing out of the save keeps the document and its changes", await kd(() => window.kd.ed.dirty && window.kd.ed.comp.grid.get(5, 3).glyph === 65 && !document.querySelector(".dialog")));

// depth slider: left = into the screen, middle = glass, right = out; the preview follows live
await page.goto("http://127.0.0.1:5183/?demo", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed.fileName === "demo");
await kd(() => { const e = window.kd.ed; e.setActive(e.doc.layers[2].id); });
await kd(() => { const s = document.querySelector(".preview-bar select"); s.value = "anaglyph"; s.dispatchEvent(new Event("change", { bubbles: true })); });
await new Promise((r) => setTimeout(r, 300));
const pvSum = () => kd(() => { const c = document.querySelector("canvas.preview"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) >>> 0; return sum; });
const atGlass = await pvSum();
await kd(() => { const s = document.querySelector("input.depth"); s.value = "40"; s.dispatchEvent(new Event("input", { bubbles: true })); });
const marks = await kd(() => { const i = document.querySelector("input.depth"), r = i.getBoundingClientRect(), g = document.querySelectorAll(".depth-mark")[1].getBoundingClientRect(); return { glassAt: (g.left + g.width / 2 - r.left) / r.width, zeroAt: (0 - Number(i.min)) / (Number(i.max) - Number(i.min)) }; });
check("the glass marker sits exactly where the slider's zero is on the linear track", Math.abs(marks.glassAt - marks.zeroAt) < 0.01 && Math.abs(marks.zeroAt - 300 / 360) < 0.001, JSON.stringify(marks));
await new Promise((r) => setTimeout(r, 300));
const outInfo = await kd(() => ({ depth: window.kd.ed.doc.layers[2].depth, readout: [...document.querySelectorAll(".depth-row .muted")].pop().textContent, info: document.querySelector(".preview-bar .grow").textContent }));
check("dragging the depth slider right pops the layer out, live in the 3D preview", outInfo.depth === 40 && outInfo.readout.startsWith("40 out · 14 px apart") && outInfo.info.includes("popping out") && (await pvSum()) !== atGlass, JSON.stringify(outInfo));
await kd(() => { const s = document.querySelector("input.depth"); s.dispatchEvent(new Event("change", { bubbles: true })); });
check("…as one undo step", await kd(() => window.kd.ed.history.canUndo && window.kd.ed.doc.layers[2].depth === 40));
const wireSeqs = await kd(async () => { const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts"); const { ed } = window.kd; return String.fromCharCode(...core.encodeAnsi(ed.comp.grid, { iceColors: false, sauce: false, depth: core.planDepth(ed.comp) })).match(/\x1b\[=\d+;\d+[*+]z/g); });
check("the export carries it as the `+ z` pop-out extension beside the `* z` depths", wireSeqs.some((w) => w.endsWith("40+z")) && wireSeqs.some((w) => w.includes("300*z")), JSON.stringify(wireSeqs));
await shot("19-depth-slider");

check("every tool is an icon with a hover tip", await kd(() => { const b = [...document.querySelectorAll(".palette button")]; return b.length === 13 && b.every((x) => x.querySelector("svg") && x.title.length > 10 && !x.textContent.trim()); }));
await shot("12-ui");

// first launch: a fresh profile gets monke.jock with the preview wiggling; New puts it back to flat, and it never comes back
const firstProfile = await browser.createBrowserContext();
const first = await firstProfile.newPage();
first.on("pageerror", (e) => problems.push(`pageerror (first launch): ${e.message}`));
await first.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await first.waitForFunction(() => window.kd?.ed.fileName === "monke.jock", { timeout: 10000 }).catch(() => {});
const welcome = await first.evaluate(() => ({ file: window.kd.ed.fileName, layers: window.kd.ed.doc.layers.length, mode: document.querySelector(".preview-bar select").value, dirty: window.kd.ed.dirty, status: document.querySelector(".status")?.textContent ?? "" }));
check("the first launch opens monke.jock, clean, with the preview wiggling", welcome.file === "monke.jock" && welcome.layers === 7 && welcome.mode === "wiggle" && !welcome.dirty, JSON.stringify(welcome));

// the 3D wiggle export, on a real piece with depth: an APNG an independent decoder (Pillow) reads, whose frames differ
const apngB64 = await first.evaluate(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const { ed } = window.kd, plan = core.planDepth(ed.comp), N = 24, frames = [];
  for (let k = 0; k < N; k++) {
    const r = core.createRaster(ed.doc.width, ed.doc.height, ed.font, ed.doc.letterSpacing9px);
    core.renderDepthView(ed.comp, plan, ed.font, r, Math.sin((2 * Math.PI * k) / N) * core.deviceShiftPx(1e9), { palette: ed.doc.palette, iceColors: ed.doc.iceColors, letterSpacing9px: ed.doc.letterSpacing9px });
    frames.push(r);
  }
  const bytes = core.encodeApng(frames, 68);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
});
const apngPath = join(out, "monke-wiggle.png");
writeFileSync(apngPath, Buffer.from(apngB64, "base64"));
let pil = null;
try {
  const { execFileSync } = await import("node:child_process");
  const script = `import json\nfrom PIL import Image\nim = Image.open(${JSON.stringify(apngPath)})\nim.seek(0); a = im.convert('RGB').tobytes()\nim.seek(6); b = im.convert('RGB').tobytes()\nprint(json.dumps({'n': im.n_frames, 'animated': im.is_animated, 'size': im.size, 'differ': a != b, 'delay': im.info.get('duration')}))`;
  pil = JSON.parse(execFileSync("python3", ["-c", script]).toString());
} catch (err) { console.log(`(no Pillow oracle: ${err.message.split("\n")[0]})`); }
if (pil) check("the wiggle APNG decodes in Pillow: 24 frames at 68 ms, and the eyes' views differ", pil.n === 24 && pil.animated && pil.differ && pil.delay === 68 && pil.size[0] === 8 * 80, JSON.stringify(pil));
await first.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("New document")).click());
await first.waitForFunction(() => window.kd?.ed.fileName === "untitled", { timeout: 5000 }).catch(() => {});
const afterNew = await first.evaluate(() => ({ file: window.kd.ed.fileName, mode: document.querySelector(".preview-bar select").value }));
check("New starts a blank document and puts the preview back to flat", afterNew.file === "untitled" && afterNew.mode === "flat", JSON.stringify(afterNew));
await first.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
check("the welcome piece is for the first launch only", await first.evaluate(() => window.kd?.ed.fileName) === "untitled");
await firstProfile.close();

// ===================================================== fonts, 9px cells, aspect ratio
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);

const artSize = () => kd(() => {
  const a = document.querySelector("canvas.art");
  return { w: a.width, h: a.height, cssH: a.style.height, fontH: window.kd.ed.font.height, rows: window.kd.ed.doc.height };
});
/** the font shown on the top-bar button, which is what the document is drawn in */
const fontButton = () => kd(() => document.querySelector(".topbar .font-pick")?.textContent ?? null);
/** choose a font through the browser, the way a person does: filter, arrow, Enter */
const chooseFont = async (query, steps = 1) => {
  await kd(() => document.querySelector(".topbar .font-pick").click());
  await page.waitForSelector(".font-dialog", { timeout: 5000 });
  await page.type(".font-dialog input[type=search]", query);
  await settle();
  for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowDown");
  await settle();
  const previewed = await kd(() => document.querySelector(".font-item.selected span")?.textContent ?? null);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".font-dialog"), { timeout: 5000 });
  await settle();
  return previewed;
};
const aspectTo = (v) => kd((val) => { const s = document.querySelector(".topbar .aspect-pick"); s.value = val; s.dispatchEvent(new Event("change", { bubbles: true })); }, v);

const vgaBase = await artSize();
check("a new document is drawn in IBM VGA, 16 rows to a cell", vgaBase.fontH === 16 && await fontButton() === "IBM VGA", JSON.stringify(vgaBase));

// 9px letter spacing: the toggle lives beside iCE, and widens every cell
const nineBox = await kd(() => {
  const l = [...document.querySelectorAll(".topbar label.check")].find((x) => x.textContent.includes("9px"));
  if (!l) return false;
  l.querySelector("input").click();
  return true;
});
check("the 9px toggle is in the top bar, beside iCE", nineBox);
await settle();
const nine = await artSize();
check("9px makes every cell a pixel wider", nine.w === vgaBase.w / 8 * 9 && await kd(() => window.kd.ed.doc.letterSpacing9px), `${vgaBase.w} -> ${nine.w}`);
// the rule that makes box drawing join: the 9th column repeats the 8th, but only for CP437 192-223
const ninePixels = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const ed = window.kd.ed;
  const g = core.CellGrid.filled(3, 1, 32, 15, 0);
  g.set(0, 0, { glyph: 205, fg: 15, bg: 0 });   // = double line, in the extend range
  g.set(1, 0, { glyph: 219, fg: 15, bg: 0 });   // block, in the range
  g.set(2, 0, { glyph: 65, fg: 15, bg: 0 });    // A, not in the range
  const r = core.createRaster(3, 1, ed.font, true);
  core.renderGrid(g, ed.font, r, { palette: ed.doc.palette, iceColors: true, letterSpacing9px: true });
  const col9 = (cx, y) => r.data[((y * r.width) + cx * 9 + 8) * 4] > 128;
  let dashRow = -1;
  for (let y = 0; y < r.cellHeight; y++) if (r.data[((y * r.width) + 0 * 9 + 3) * 4] > 128) { dashRow = y; break; }
  return { cellWidth: r.cellWidth, dashJoins: dashRow >= 0 && col9(0, dashRow), blockJoins: col9(1, 8), letterDoesNot: !col9(2, 8) };
});
check("9px: box drawing and blocks bridge the 9th column, letters do not",
  ninePixels.cellWidth === 9 && ninePixels.dashJoins && ninePixels.blockJoins && ninePixels.letterDoesNot, JSON.stringify(ninePixels));
await kd(() => [...document.querySelectorAll(".topbar label.check")].find((x) => x.textContent.includes("9px")).querySelector("input").click());
await settle();

// picking a font by its SAUCE name loads a different bitmap, with its own cell height
const previewedVga50 = await chooseFont("VGA50", 1);
check("the browser filters by name and previews as you arrow through it", previewedVga50 === "IBM VGA50", String(previewedVga50));
await page.waitForFunction(() => window.kd.ed.font.height === 8, { timeout: 5000 }).catch(() => {});
const halfHeight = await artSize();
check("choosing IBM VGA50 loads an 8-row font and redraws at that size", halfHeight.fontH === 8 && halfHeight.h === vgaBase.h / 2, JSON.stringify(halfHeight));
check("the document records the font it is drawn in, for SAUCE", await kd(() => window.kd.ed.doc.fontName) === "IBM VGA50");
await chooseFont("Topaz 2+", 1);
check("an Amiga font loads too", await kd(() => window.kd.ed.font.height) === 16 && await fontButton() === "Amiga Topaz 2+", await fontButton());

// the browser previews the document itself, and cancelling changes nothing
await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  // Amiga ASCII is built out of byte 225, which is a different character in every codepage
  const g = core.CellGrid.filled(30, 6, 225, 7, 0);
  const doc = core.createDocument(30, 6);
  const l = core.createCellsLayer("amiga", 30, 6);
  l.grid = g;
  doc.layers = [l];
  window.kd.ed.setDocument(doc, "amiga.asc");
});
await settle();
await kd(() => document.querySelector(".topbar .font-pick").click());
await page.waitForSelector(".font-dialog", { timeout: 5000 });
await settle();
const browser2 = await kd(() => ({
  canvases: document.querySelectorAll(".font-preview-box canvas").length,
  labels: [...document.querySelectorAll(".font-preview-box .hint")].map((x) => x.textContent),
  all: document.querySelector(".font-dialog .muted")?.textContent ?? "",
}));
check("the font browser previews your own picture, and the whole character set under it",
  browser2.canvases === 2 && browser2.labels[0] === "your picture" && /^86 of 86/.test(browser2.all), JSON.stringify(browser2));
const beforeCancel = await kd(() => window.kd.ed.doc.fontName);
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".font-dialog"), { timeout: 5000 });
check("Escape leaves the font as it was", await kd(() => window.kd.ed.doc.fontName) === beforeCancel);

// the same bytes, two fonts: this is what "the Amiga file looked wrong" was
const inkOf = () => kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const ed = window.kd.ed, f = ed.font;
  let ink = "";
  for (let y = 0; y < f.height; y++) ink += f.glyphs[225 * f.height + y].toString(16).padStart(2, "0");
  return ink;
});
const ibmInk = await inkOf();
await chooseFont("Topaz 1", 1);
const amigaInk = await inkOf();
check("byte 225 is a different character in an Amiga font than in an IBM one — which is the whole problem",
  ibmInk !== amigaInk && await fontButton() === "Amiga Topaz 1", `IBM ${ibmInk.slice(0, 12)}… vs Amiga ${amigaInk.slice(0, 12)}…`);
check("choosing a font is undoable like any other document change",
  await kd(() => { window.kd.ed.undo(); return window.kd.ed.doc.fontName; }) === "IBM VGA");

// art that names no font says so, rather than just looking wrong
await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const bytes = new Uint8Array(80 * 5).fill(225);
  for (let y = 1; y < 5; y++) bytes[y * 80 - 1] = 10;
  window.kd.io_lastStatus = null;
  window.kd.ed.setDocument(core.documentFromArt(core.parseArt(bytes, "noname.asc")), "noname.asc");
});
await settle();
// the hint is produced by the open path, so drive that instead of setDocument
const hinted = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const bytes = new Uint8Array(400).fill(225);
  const art = core.parseArt(bytes, "noname.asc");
  return { named: !!art.sauce?.fontName?.trim(), glyph: art.grid.glyph[0] };
});
check("plain text carries no font name, so there is something to tell the artist about", hinted.named === false && hinted.glyph === 225, JSON.stringify(hinted));

// the character grid: clicking a glyph has to give you that glyph, in every font.
// A cell is 8 wide but 8, 14, 16 or 19 rows tall, so a picker sized for one font
// paints another's glyphs somewhere the clicks do not agree with.
for (const [name, height] of [["IBM VGA", 16], ["IBM VGA50", 8], ["IBM EGA", 14], ["IBM VGA25G", 19], ["C64 PETSCII unshifted", 8]]) {
  await kd((n) => { const ed = window.kd.ed; ed.setProps("Font", ed.doc, { fontName: n }); }, name);
  await page.waitForFunction((h) => window.kd.ed.font.height === h, { timeout: 5000 }, height).catch(() => {});
  await settle();
  const out = await kd(() => {
    const c = document.querySelector("canvas.glyph-picker");
    const r = c.getBoundingClientRect(), fh = window.kd.ed.font.height;
    const sx = r.width / c.width, sy = r.height / c.height;
    let wrong = 0;
    for (let code = 0; code < 256; code++) {
      const col = code % 16, row = Math.floor(code / 16);
      // click where the glyph is actually painted, not where a 16-row split would put it
      c.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + (col * 8 + 4) * sx, clientY: r.top + (row * fh + fh / 2) * sy }));
      if (window.kd.ed.glyph !== code) wrong++;
    }
    return { fh, fits: c.height === 16 * fh, wrong };
  });
  check(`character grid: every one of the 256 squares picks its own glyph in ${name}`,
    out.wrong === 0 && out.fits && out.fh === height, JSON.stringify(out));
}
await kd(() => { const ed = window.kd.ed; ed.setProps("Font", ed.doc, { fontName: "IBM VGA" }); });
await settle();

// a name nothing can serve — real files carry tool names in this field
await kd(() => { const ed = window.kd.ed; ed.setProps("Font", ed.doc, { fontName: "SAUCE-ADDER V1.3" }); });
await settle();
const junk = await kd(() => ({ kept: window.kd.ed.doc.fontName, height: window.kd.ed.font.height, status: window.kd.ed.status }));
check("an unknown font name is kept (so exports still ask for it) and drawn in IBM VGA, with a note",
  junk.kept === "SAUCE-ADDER V1.3" && junk.height === 16 && /not a font jockoshop has/.test(junk.status), JSON.stringify(junk));

// exporting .xb carries the font with it, which is why you would pick XBIN
const xbRound = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const ed = window.kd.ed;
  const before = ed.doc.fontName;
  ed.setProps("Font", ed.doc, { fontName: "C64 PETSCII unshifted" });
  await new Promise((r) => setTimeout(r, 900));
  const drawnIn = ed.font.height;
  const bytes = core.encodeXbin(ed.comp.grid, { iceColors: ed.doc.iceColors, sauce: ed.doc.sauce, fontBytes: ed.font.glyphs });
  const back = core.parseArt(bytes, "out.xb");
  const same = !!back.fontBytes && back.fontBytes.length === ed.font.glyphs.length
    && [...back.fontBytes].every((b, i) => b === ed.font.glyphs[i]);
  ed.setProps("Font", ed.doc, { fontName: before });
  return { drawnIn, carried: !!back.fontBytes, rows: back.fontBytes ? back.fontBytes.length / 256 : 0, same };
});
check("exporting .xb embeds the font the art is drawn in, byte for byte",
  xbRound.drawnIn === 8 && xbRound.carried && xbRound.rows === 8 && xbRound.same, JSON.stringify(xbRound));
await settle();

// art that carries its own font bitmap: XBIN, and the embedded one wins
const embedded = await kd(async () => {
  const core = await import("/@fs/Volumes/Crucial2TB/Projects/killerdraw/packages/core/src/index.ts");
  const g = core.CellGrid.filled(4, 2, 65, 7, 0);
  // a font of the right shape but 8 rows to a cell, so it is recognisable by height
  const fontBytes = Uint8Array.from({ length: 256 * 8 }, (_, i) => (i % 8 < 4 ? 0xff : 0x00));
  const bytes = core.encodeXbin(g, { fontBytes });
  window.kd.ed.setDocument(core.documentFromArt(core.parseArt(bytes, "custom.xb")), "custom.xb");
  return true;
});
await page.waitForFunction(() => window.kd.ed.font.height === 8, { timeout: 5000 }).catch(() => {});
const emb = await kd(() => ({
  height: window.kd.ed.font.height,
  asset: window.kd.ed.doc.assets.has("assets/fonts/document.fnt"),
  picker: !!document.querySelector(".topbar .font-pick"),
  label: document.querySelector(".topbar .font-embedded")?.textContent ?? "",
}));
check("an XBIN's own font bitmap is what its art is drawn in", embedded && emb.height === 8 && emb.asset && emb.picker === false, JSON.stringify(emb));
check("the font picker gives way to it, since the file carries the font", emb.label.includes("embedded"), emb.label);

// aspect ratio: art drawn for a 4:3 screen is stretched to look as it did
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
const flatAr = await artSize();
await aspectTo("stretch");
await settle();
const tallAr = await artSize();
check("4:3 aspect stretches the drawing by 1.2 at 8-pixel cells",
  Math.abs(parseFloat(tallAr.cssH) / parseFloat(flatAr.cssH) - 1.2) < 0.02, `${flatAr.cssH} -> ${tallAr.cssH}`);
check("stretching changes how it is drawn, not the grid: same rows, same backing raster",
  tallAr.rows === flatAr.rows && tallAr.h === flatAr.h, `${JSON.stringify(flatAr)} -> ${JSON.stringify(tallAr)}`);
const arHit = await kd(() => {
  // the cell under a point has to follow the stretch, or the brush lands in the wrong row
  const view = window.kd.view ?? null;
  const a = document.querySelector("canvas.art").getBoundingClientRect();
  const z = window.kd.ed.zoom;
  return { cell: window.kd.ed.doc.height, y: a.height / (16 * z) };
});
check("a stretched canvas still holds exactly the document's rows", Math.abs(arHit.y * 1 - arHit.cell * 1.2) < 0.5, JSON.stringify(arHit));
await aspectTo("square");
await settle();
check("SAUCE records the choice", await kd(() => window.kd.ed.doc.aspectRatio) === "square");
await shot("21-fonts-aspect");

// ===================================================== keys, aligned with Moebius
await page.goto("http://127.0.0.1:5183/", { waitUntil: "networkidle0" });
await page.waitForFunction(() => window.kd?.ed);
const colours = () => kd(() => ({ fg: window.kd.ed.fg, bg: window.kd.ed.bg }));
/** press with real modifiers held */
const chord = async (mods, key) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};

await kd(() => window.kd.ed.setBrush({ fg: 7, bg: 0 }));
await chord(["Control"], "1");
check("Ctrl+1 sets the foreground", (await colours()).fg === 1);
await chord(["Control"], "1");
check("Ctrl+1 again goes to its bright twin, as in Moebius", (await colours()).fg === 9);
await chord(["Control"], "1");
check("and back again", (await colours()).fg === 1);
await chord(["Control"], "1");
await chord(["Control"], "4");
check("changing hue while bright stays bright", (await colours()).fg === 12, JSON.stringify(await colours()));
await chord(["Alt"], "2");
check("Alt+2 sets the background", (await colours()).bg === 2);
await chord(["Alt"], "2");
check("Alt+2 again goes bright", (await colours()).bg === 10);

await kd(() => window.kd.ed.setBrush({ fg: 7, bg: 0 }));
await chord(["Control"], "ArrowDown");
check("Ctrl+Down steps the foreground on", (await colours()).fg === 8);
await chord(["Control"], "ArrowUp");
check("Ctrl+Up steps it back", (await colours()).fg === 7);
await chord(["Control"], "ArrowRight");
check("Ctrl+Right steps the background on", (await colours()).bg === 1);
await chord(["Control"], "ArrowLeft");
check("Ctrl+Left steps it back", (await colours()).bg === 0);

await kd(() => window.kd.ed.setBrush({ fg: 3, bg: 5 }));
await chord(["Meta", "Shift"], "x");
check("Cmd+Shift+X swaps foreground and background", JSON.stringify(await colours()) === JSON.stringify({ fg: 5, bg: 3 }));
await chord(["Meta"], "d");
check("Cmd+D is Moebius's Default Colour, not deselect", JSON.stringify(await colours()) === JSON.stringify({ fg: 7, bg: 0 }));
await kd(() => window.kd.ed.setSelection(window.kd.ed.selection));
await page.keyboard.press("m");
await drag([2, 2], [6, 4]);
check("a selection is still made", await kd(() => (window.kd.ed.selection?.count() ?? 0) > 0));
await page.keyboard.press("Escape");
check("Escape is what deselects now", await kd(() => window.kd.ed.selection === null));

const setBefore = await kd(() => window.kd.ed.charset);
await chord(["Alt"], "F3");
check("Alt+F3 jumps straight to character set 3, the way Moebius does", await kd(() => window.kd.ed.charset) === 2, `${setBefore} -> ${await kd(() => window.kd.ed.charset)}`);
await chord(["Alt", "Shift"], "F1");
check("Alt+Shift+F1 reaches the second ten sets", await kd(() => window.kd.ed.charset) === 10);
await chord(["Control"], "/");
check("Ctrl+/ goes back to the first set", await kd(() => window.kd.ed.charset) === 0);
await chord(["Control"], ".");
check("Ctrl+. still steps to the next set", await kd(() => window.kd.ed.charset) === 1);

await kd(() => { window.kd.ed.brushSize = 1; window.kd.ed.chooseTool("brush"); });
await chord(["Alt"], "=");
check("Alt+= grows the brush", await kd(() => window.kd.ed.brushSize) === 2);
await chord(["Alt"], "-");
check("Alt+- shrinks it", await kd(() => window.kd.ed.brushSize) === 1);

const iceBefore = await kd(() => window.kd.ed.doc.iceColors);
await chord(["Meta"], "e");
check("Cmd+E toggles iCE colours", await kd(() => window.kd.ed.doc.iceColors) === !iceBefore);
await chord(["Meta"], "e");
await chord(["Meta"], "f");
check("Cmd+F toggles 9px letter spacing", await kd(() => window.kd.ed.doc.letterSpacing9px) === true);
await chord(["Meta"], "f");
await chord(["Meta", "Alt"], "m");
check("Cmd+Alt+M is mirror mode", await kd(() => window.kd.ed.mirrorX) === true);
await chord(["Meta", "Alt"], "m");

// the sheet is generated from the same table the handler uses
await page.keyboard.press("?");
await page.waitForSelector(".sheet", { timeout: 5000 });
const sheet = await kd(() => ({
  groups: [...document.querySelectorAll(".sheet h4")].map((x) => x.textContent),
  rows: document.querySelectorAll(".sheet-row").length,
  moeb: document.querySelectorAll(".sheet .tag").length,
  hasColour: [...document.querySelectorAll(".sheet-row")].some((r) => /Foreground colour/.test(r.textContent)),
}));
check("? shows a shortcut sheet built from the keymap, with the Moebius keys marked",
  sheet.rows > 30 && sheet.moeb > 15 && sheet.hasColour && sheet.groups.includes("Colour"), JSON.stringify(sheet));
await page.keyboard.press("Escape");
check("Escape closes the sheet", await kd(() => !document.querySelector(".sheet")));

// typing into a field must not fire drawing keys
await kd(() => { const i = document.querySelector(".topbar input[type=number]"); i.focus(); });
const fgBefore = await kd(() => window.kd.ed.fg);
await chord(["Control"], "5");
check("a focused field keeps the colour keys out of the way", await kd(() => window.kd.ed.fg) === fgBefore);
await kd(() => document.activeElement.blur());

check("no console errors or page errors", problems.length === 0, problems.slice(0, 3).join(" ; "));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
