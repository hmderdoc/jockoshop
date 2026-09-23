#!/usr/bin/env node
// Two browsers in one joint. Starts the REAL Moebius collaboration server through the rig
// (scripts/joint-server/rig.mjs), opens the editor twice in headless Chrome, joins both, and checks
// that what one draws reaches the other's Remote layer, that undo travels, that chat and presence
// work, that a canvas resize follows, and that the server's saved .ans holds the cells at the end.
//
//   npm run smoke:joint-app          (node scripts/smoke-joint-app.mjs [outDir])
//
// Needs `npm run dev` on http://127.0.0.1:5183. CHROME_PATH overrides the browser.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { startJointServer, libtextmode } from "./joint-server/rig.mjs";

const WebSocket = createRequire(new URL("./joint-server/rig.mjs", import.meta.url))("ws");
const APP = "http://127.0.0.1:5183/";
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

let failures = 0;
const problems = [];
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failures++; };
const BLANK = { code: 32, fg: 7, bg: 0 };
const sameBlock = (a, b) => !!a && !!b && a.code === b.code && a.fg === b.fg && a.bg === b.bg;
const drawn = { glyph: 219, fg: 12, bg: 1 };   // full block, bright red on blue
const row = { y: 5, from: 10, to: 20 };
const smaller = 40;                            // columns after the resize; keeps the drawn row

const dir = mkdtempSync(join(tmpdir(), "kd-joint-app-"));
let browser, joint, push;

/** A raw protocol client, to look at a joint from outside the app (see scripts/smoke-joint.mjs). */
async function peek(url, nick) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const hello = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no CONNECTED reply")), 3000);
    ws.on("message", (raw) => { const m = JSON.parse(raw); if (m.type === 0) { clearTimeout(timer); res(m.data); } });
    ws.send(JSON.stringify({ type: 0, data: { nick, group: "", pass: "" } }));
  });
  ws.close();
  return { ...hello, doc: libtextmode.uncompress(structuredClone(hello.doc)) };
}

try {
  joint = await startJointServer({ file: join(dir, "app.ans"), path: "app", columns: 80, rows: 25 });
  check("the rig is up", joint.port > 0 && joint.path === "/app", joint.url);

  browser = await puppeteer.launch({ executablePath: findChrome(), args: ["--no-sandbox"] });
  const pages = [];
  for (const name of ["alpha", "beta"]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1680, height: 1000 });
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem("jockoshop.welcomed", "1"); } catch { /* */ } });
    page.on("dialog", (d) => void d.accept());   // "discard unsaved changes?" on the reload below
    page.on("console", (m) => { if (m.type() === "error") problems.push(`${name} console: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`${name} pageerror: ${e.message}`));
    await page.goto(APP, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => !!window.kd?.joint);
    await page.evaluate(() => { const e = window.kd.ed; e.zoomFit = false; e.zoom = 2; window.kd.view.paint(); e.emit("ui"); });
    pages.push(Object.assign(page, { nick: name }));
  }
  const [a, b] = pages;

  // --- both join -----------------------------------------------------------
  for (const page of pages) {
    await page.evaluate((url, nick) => window.kd.joint.connect({ url, nick, group: "killerdraw", mode: "open" }), joint.url, page.nick);
  }
  const state = await a.evaluate(() => {
    const { ed, joint } = window.kd;
    return {
      connected: joint.connected, path: joint.path, id: joint.id, users: joint.users.length,
      fileName: ed.fileName, size: `${ed.doc.width}x${ed.doc.height}`,
      layers: ed.doc.layers.map((l) => `${l.name}${l.joint ? `[${l.joint}]` : ""}`),
      active: ed.active.name, panel: !!document.querySelector(".joint-panel:not([hidden])"),
    };
  });
  check("connecting replaces the document with the joint's canvas", state.connected && state.fileName === "joint: /app" && state.size === "80x25", JSON.stringify(state));
  check("the joint's cells are a layer, with the Remote layer pinned on top", state.layers.join(" | ") === "joint canvas | joint: others[remote]", state.layers.join(" | "));
  check("the base layer is selected, not the Remote one", state.active === "joint canvas", state.active);
  check("the panel shows itself on joining", state.panel);
  const bState = await b.evaluate(() => ({ users: window.kd.joint.users.map((u) => u.nick), id: window.kd.joint.id }));
  check("the second client sees the first in its users list", bState.users.length === 1 && bState.users[0] === "alpha", JSON.stringify(bState));
  await a.waitForFunction(() => window.kd.joint.users.length === 1);
  check("the first client is told about the second", (await a.evaluate(() => window.kd.joint.users[0].nick)) === "beta");

  // --- alpha draws, beta sees it ------------------------------------------
  await a.keyboard.press("b");
  await a.evaluate((d) => { const e = window.kd.ed; e.glyph = d.glyph; e.fg = d.fg; e.bg = d.bg; e.emit("ui"); }, drawn);
  const cellXY = async (page, x, y) => page.evaluate((x, y) => {
    const r = document.querySelector("canvas.overlay").getBoundingClientRect(), z = window.kd.ed.zoom;
    return { x: r.left + (x + 0.5) * 8 * z, y: r.top + (y + 0.5) * 16 * z };
  }, x, y);
  const p0 = await cellXY(a, row.from, row.y), p1 = await cellXY(a, row.to, row.y);
  await a.mouse.move(p0.x, p0.y);
  await a.mouse.down();
  await a.mouse.move(p1.x, p1.y, { steps: 12 });
  await a.mouse.up();
  const painted = await a.evaluate((r, d) => {
    const g = window.kd.ed.comp.grid, c = g.get(r.from + 2, r.y);
    return c.glyph === d.glyph && c.fg === d.fg && c.bg === d.bg;
  }, row, drawn);
  check("alpha painted the row", painted);

  const seen = await b.waitForFunction((r, d) => {
    const c = window.kd.ed.comp.grid.get(r.from + 2, r.y);
    return c.glyph === d.glyph && c.fg === d.fg && c.bg === d.bg ? true : null;
  }, { timeout: 5000 }, row, drawn).then(() => true).catch(() => false);
  check("beta's composite shows what alpha drew", seen, await b.evaluate((r) => JSON.stringify(window.kd.ed.comp.grid.get(r.from + 2, r.y)), row));
  const landed = await b.evaluate((r, d) => {
    const layer = window.kd.ed.doc.layers.find((l) => l.joint === "remote");
    const g = layer.grid, i = g.index(r.from + 2, r.y);
    return { present: g.present[i], glyph: g.glyph[i], fg: g.fg[i], bg: g.bg[i], cells: [...g.present].filter(Boolean).length };
  }, row, drawn);
  check("…in beta's Remote layer, not in its own cells", landed.present === 7 && landed.glyph === drawn.glyph && landed.fg === drawn.fg && landed.bg === drawn.bg, JSON.stringify(landed));
  check("beta received one cell per drawn cell", landed.cells === row.to - row.from + 1, `${landed.cells} cells of ${row.to - row.from + 1}`);
  const echo = await a.evaluate(() => {
    const layer = window.kd.ed.doc.layers.find((l) => l.joint === "remote");
    return { cells: [...layer.grid.present].filter(Boolean).length, sent: window.kd.joint.sentDraws, got: window.kd.joint.receivedDraws };
  });
  check("alpha's own Remote layer stayed empty — nothing is echoed to the sender", echo.cells === 0 && echo.got === 0, JSON.stringify(echo));
  check("alpha sent one DRAW per cell", echo.sent === row.to - row.from + 1, `${echo.sent} draws`);
  await a.screenshot({ path: join(out, "joint-01-alpha.png") });
  await b.screenshot({ path: join(out, "joint-02-beta.png") });

  // --- undo travels -------------------------------------------------------
  await a.evaluate(() => window.kd.ed.undo());
  const reverted = await b.waitForFunction((r) => window.kd.ed.comp.grid.get(r.from + 2, r.y).glyph === 32 ? true : null, { timeout: 5000 }, row)
    .then(() => true).catch(() => false);
  check("undo in alpha blanks the cells in beta", reverted, await b.evaluate((r) => JSON.stringify(window.kd.ed.comp.grid.get(r.from + 2, r.y)), row));
  await a.evaluate(() => window.kd.ed.redo());
  await b.waitForFunction((r, d) => window.kd.ed.comp.grid.get(r.from + 2, r.y).glyph === d.glyph ? true : null, { timeout: 5000 }, row, drawn);
  check("redo brings them back in beta", true);

  // --- beta draws under alpha's remote cell: the Remote layer gives way ---
  await b.evaluate((r) => {
    const { ed } = window.kd, layer = ed.doc.layers[0];
    layer.grid.set(r.from + 2, r.y, { glyph: 177, fg: 14, bg: 0 });
    ed.recomposite({ x: r.from + 2, y: r.y, width: 1, height: 1 });
  }, row);
  const superseded = await b.evaluate((r) => {
    const { ed } = window.kd, remote = ed.doc.layers.find((l) => l.joint === "remote");
    return { cleared: remote.grid.present[remote.grid.index(r.from + 2, r.y)], shown: ed.comp.grid.get(r.from + 2, r.y).glyph };
  }, row);
  check("drawing over a remote cell clears it from the Remote layer", superseded.cleared === 0 && superseded.shown === 177, JSON.stringify(superseded));
  await a.waitForFunction((r) => window.kd.ed.comp.grid.get(r.from + 2, r.y).glyph === 177 ? true : null, { timeout: 5000 }, row);
  check("…and alpha sees beta's cell", true);

  // --- chat ---------------------------------------------------------------
  await b.evaluate(() => window.kd.joint.chat("hello from beta"));
  const heard = await a.waitForFunction(() => document.querySelector(".joint-panel .joint-log")?.textContent?.includes("hello from beta") ? true : null, { timeout: 5000 })
    .then(() => true).catch(() => false);
  check("beta's chat shows in alpha's panel", heard, await a.evaluate(() => JSON.stringify(window.kd.joint.lines.slice(-3))));
  const named = await a.evaluate(() => window.kd.joint.lines.some((l) => l.kind === "chat" && l.nick === "beta" && l.text === "hello from beta"));
  check("…with the sender's nick", named);

  // --- presence: alpha's cursor reaches beta -------------------------------
  const hover = await cellXY(a, 30, 8);
  await a.mouse.move(hover.x, hover.y);
  await a.mouse.move(hover.x + 1, hover.y + 1);
  const cursor = await b.waitForFunction(() => {
    const c = window.kd.joint.cursors();
    return c.length && c[0].nick === "alpha" ? c[0] : null;
  }, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null);
  check("beta knows where alpha's cursor is", !!cursor && cursor.x === 30 && cursor.y === 8, JSON.stringify(cursor));

  // --- document settings, both ways ---------------------------------------
  await a.evaluate(() => window.kd.ed.setProps("iCE colours", window.kd.ed.doc, { iceColors: true }));
  const ice = await b.waitForFunction(() => window.kd.ed.doc.iceColors ? true : null, { timeout: 5000 }).then(() => true).catch(() => false);
  check("alpha turning iCE colours on reaches beta", ice);
  const undoBefore = await a.evaluate(() => window.kd.ed.history.position);
  await b.evaluate(() => {
    const { ed } = window.kd;
    ed.setProps("SAUCE", ed.doc, { sauce: { ...ed.doc.sauce, title: "joint piece", author: "beta" }, fontName: "IBM VGA50", letterSpacing9px: true });
  });
  const meta = await a.waitForFunction(() => {
    const d = window.kd.ed.doc;
    return d.sauce.title === "joint piece" && d.sauce.author === "beta" && d.fontName === "IBM VGA50" && d.letterSpacing9px ? true : null;
  }, { timeout: 5000 }).then(() => true).catch(() => false);
  check("beta's SAUCE, font and 9px change reach alpha", meta, await a.evaluate(() => JSON.stringify({ ...window.kd.ed.doc.sauce, font: window.kd.ed.doc.fontName, ninePx: window.kd.ed.doc.letterSpacing9px })));
  const undoAfter = await a.evaluate(() => window.kd.ed.history.position);
  check("…without landing in alpha's undo history — it is not alpha's edit", undoBefore === undoAfter, `${undoBefore} → ${undoAfter}`);

  // --- the canvas size, both ways -----------------------------------------
  await a.evaluate((w) => window.kd.ed.setProps("Canvas width", window.kd.ed.doc, { width: w }), smaller);
  const resized = await b.waitForFunction((w) => window.kd.ed.doc.width === w ? true : null, { timeout: 5000 }, smaller)
    .then(() => true).catch(() => false);
  check("alpha's canvas resize resizes beta's document", resized, await b.evaluate(() => `${window.kd.ed.doc.width}x${window.kd.ed.doc.height}`));
  const after = await b.evaluate((r, d) => {
    const { ed } = window.kd, remote = ed.doc.layers.find((l) => l.joint === "remote");
    return { remote: `${remote.grid.width}x${remote.grid.height}`, comp: `${ed.comp.grid.width}x${ed.comp.grid.height}`, kept: ed.comp.grid.get(r.from + 4, r.y).glyph === d.glyph };
  }, row, drawn);
  check("…and the Remote layer with it, keeping the top-left cells", after.remote === `${smaller}x25` && after.comp === `${smaller}x25` && after.kept, JSON.stringify(after));

  // --- leaving ------------------------------------------------------------
  await b.evaluate(() => window.kd.joint.disconnect());
  const left = await a.waitForFunction(() => window.kd.joint.users.length === 0 ? true : null, { timeout: 5000 }).then(() => true).catch(() => false);
  check("alpha's users list shrinks when beta leaves", left, await a.evaluate(() => JSON.stringify(window.kd.joint.users)));
  const ordinary = await b.evaluate(() => {
    const layer = window.kd.ed.doc.layers.find((l) => l.name === "joint: others");
    return { connected: window.kd.joint.connected, marker: layer?.joint ?? null, kept: !!layer, panel: !!document.querySelector(".joint-panel:not([hidden])") };
  });
  check("beta keeps the document; the Remote layer becomes an ordinary layer", !ordinary.connected && ordinary.kept && ordinary.marker === null && !ordinary.panel, JSON.stringify(ordinary));

  // --- push mode: our document overwrites a joint's canvas ------------------
  push = await startJointServer({ file: join(dir, "push.ans"), port: joint.port, path: "push", columns: 40, rows: 12 });
  await b.goto(APP, { waitUntil: "domcontentloaded" });   // the app announces itself below; the dev server keeps its HMR socket open
  await b.waitForFunction(() => !!window.kd?.joint, { timeout: 15000 });
  await b.evaluate(() => {
    const { ed } = window.kd;
    ed.doc.layers[0].grid.set(3, 4, { glyph: 4, fg: 11, bg: 5 });
    ed.recomposite();
  });
  await b.evaluate((url) => window.kd.joint.connect({ url, nick: "pusher", group: "", mode: "push" }), push.url);
  const pushed = await b.evaluate(() => ({ sent: window.kd.joint.sentDraws, size: `${window.kd.ed.doc.width}x${window.kd.ed.doc.height}`, name: window.kd.ed.fileName }));
  check("push keeps the document it was given", pushed.size === "80x25" && pushed.name === "untitled", JSON.stringify(pushed));
  const room = await peek(push.url, "onlooker");
  check("push resized the joint to our canvas", room.doc.columns === 80 && room.doc.rows === 25, `${room.doc.columns}x${room.doc.rows}`);
  check("push put our cell in the joint", sameBlock(room.doc.data[4 * 80 + 3], { code: 4, fg: 11, bg: 5 }), JSON.stringify(room.doc.data[4 * 80 + 3]));
  check("push sent only the cells that differ", pushed.sent === 1, `${pushed.sent} draws`);

  // --- the document replaced under a live joint (File > New) ----------------
  // the others' layer must come back on top of the new document, or their cells vanish into a detached layer
  const moe = new WebSocket(push.url);
  const moeId = await new Promise((resolve, reject) => {
    moe.on("error", reject);
    moe.on("open", () => moe.send(JSON.stringify({ type: 0, data: { nick: "moe", group: "", pass: "" } })));
    moe.on("message", (m) => { const f = JSON.parse(m.toString()); if (f.type === 0) resolve(f.data.id); });
  });
  await b.keyboard.down("Meta"); await b.keyboard.press("n"); await b.keyboard.up("Meta");
  await b.waitForFunction(() => window.kd.ed.doc.layers.length === 1 || window.kd.ed.doc.layers.some((l) => l.name === "Layer 1"), { timeout: 5000 }).catch(() => {});
  check("beta made a new document while connected and stayed in the joint", await b.evaluate(() => window.kd.joint.connected && window.kd.ed.doc.layers[0].name === "Layer 1"));
  moe.send(JSON.stringify({ type: 9, data: { id: moeId, x: 5, y: 20, block: { code: 35, fg: 10, bg: 0 } } }));
  const repinned = await b.waitForFunction(() => window.kd.ed.comp.grid.get(5, 20).glyph === 35 ? true : null, { timeout: 5000 }).then(() => true).catch(() => false);
  const repinState = await b.evaluate(() => ({ layers: window.kd.ed.doc.layers.map((l) => `${l.name}${l.joint ? "[remote]" : ""}`), cell: window.kd.ed.comp.grid.get(5, 20).glyph }));
  check("another user's cells still reach beta's canvas: the others' layer re-pinned itself into the new document", repinned && repinState.layers.length === 2 && repinState.layers[1].endsWith("[remote]"), JSON.stringify(repinState));
  moe.close();
  await b.evaluate(() => window.kd.joint.disconnect());

  // --- what the server saved ----------------------------------------------
  await a.evaluate(() => window.kd.joint.disconnect());
  await joint.stop();
  joint = undefined;
  const saved = await libtextmode.read_file(join(dir, "app.ans"));
  check("the saved .ans has the resized canvas", saved.columns === smaller, `${saved.columns}x${saved.rows}`);
  check("the saved .ans holds the cells alpha drew", sameBlock(saved.data[row.y * saved.columns + row.from + 4], { code: drawn.glyph, fg: drawn.fg, bg: drawn.bg }), JSON.stringify(saved.data[row.y * saved.columns + row.from + 4]));
  check("the saved .ans holds the cell beta drew over it", sameBlock(saved.data[row.y * saved.columns + row.from + 2], { code: 177, fg: 14, bg: 0 }), JSON.stringify(saved.data[row.y * saved.columns + row.from + 2]));
  check("the saved .ans leaves untouched cells blank", sameBlock(saved.data[0], BLANK), JSON.stringify(saved.data[0]));
} catch (err) {
  failures++;
  console.log(`FAIL  smoke-joint-app threw  (${err?.stack ?? err})`);
} finally {
  try { await browser?.close(); } catch { /* */ }
  try { await push?.stop(); } catch { /* */ }
  try { await joint?.stop(); } catch { /* */ }
  rmSync(dir, { recursive: true, force: true });
}

for (const p of problems) { console.log(`FAIL  ${p}`); failures++; }
console.log(failures ? `\n${failures} failure${failures === 1 ? "" : "s"}` : "\nall joint app checks passed");
process.exit(failures ? 1 : 0);
