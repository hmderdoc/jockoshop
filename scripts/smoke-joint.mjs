#!/usr/bin/env node
// Protocol-level smoke test for the Moebius "joint" collaboration protocol, run against the REAL
// Moebius server (the vendored copy in scripts/joint-server — see its NOTICE.md) with plain `ws`
// clients. No browser, no killerdraw app: this pins down what the genuine server actually does,
// so the editor's implementation can be checked against it.
//
//   npm run smoke:joint            (node scripts/smoke-joint.mjs)
//
// Exits non-zero on the first failing assertion's account, after running the whole script.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startJointServer, libtextmode } from "./joint-server/rig.mjs";

// `ws` lives in scripts/joint-server/node_modules (see that directory's NOTICE.md), not in the
// repo root, so resolve it from there.
const WebSocket = createRequire(new URL("./joint-server/rig.mjs", import.meta.url))("ws");

// ---------------------------------------------------------------- reporting

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const skip = (name, why) => console.log(`SKIP  ${name}  (${why})`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** blocks compare by value: libtextmode writes {fg,bg,code} in one place and {code,fg,bg} in another */
const sameBlock = (a, b) => !!a && !!b && a.code === b.code && a.fg === b.fg && a.bg === b.bg;
const BLANK = { code: 32, fg: 7, bg: 0 };

// ---------------------------------------------------------------- protocol

// app/server.js's own `action` map. SET_BG (21) is accepted and deliberately ignored upstream.
const action = {
  CONNECTED: 0, REFUSED: 1, JOIN: 2, LEAVE: 3, CURSOR: 4, SELECTION: 5, RESIZE_SELECTION: 6,
  OPERATION: 7, HIDE_CURSOR: 8, DRAW: 9, CHAT: 10, STATUS: 11, SAUCE: 12, ICE_COLORS: 13,
  USE_9PX_FONT: 14, CHANGE_FONT: 15, SET_CANVAS_SIZE: 16, SET_BG: 21,
};
const status = { ACTIVE: 0, IDLE: 1, AWAY: 2, WEB: 3 };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A test client: records every frame it is sent and lets the test await the next one of a type. */
class Client {
  constructor(name, url) {
    this.name = name;
    this.inbox = [];
    this.id = undefined;
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => this.inbox.push(JSON.parse(raw)));
  }

  static async open(name, url) {
    const c = new Client(name, url);
    await new Promise((res, rej) => {
      c.ws.once("open", res);
      c.ws.once("error", rej);
    });
    return c;
  }

  send(type, data = {}) {
    // The real Moebius client stamps its own id onto every frame but CONNECTED (doc.js send()).
    // The server reads data.id for CHAT and STATUS and relays it verbatim to everyone else.
    this.ws.send(JSON.stringify({ type, data: this.id === undefined ? data : { id: this.id, ...data } }));
  }

  /** first unconsumed frame of `type`, waiting up to `ms`; frames of other types stay queued */
  async next(type, ms = 1500) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`${this.name}: no ${nameOf(type)} within ${ms}ms (saw ${this.inbox.map((m) => nameOf(m.type)).join(",") || "nothing"})`);
      await delay(10);
    }
  }

  /** everything received so far, as action names — for "nothing was echoed" assertions */
  seen() {
    return this.inbox.map((m) => nameOf(m.type));
  }

  async join(nick, group = "", pass = "") {
    this.send(action.CONNECTED, { nick, group, pass });
    const msg = await this.next(action.CONNECTED);
    this.id = msg.data.id;
    return msg.data;
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((r) => this.ws.once("close", r));
    this.ws.close();
    await closed;
  }
}

const nameOf = (type) => Object.keys(action).find((k) => action[k] === type) ?? `#${type}`;

// ---------------------------------------------------------------- the run

const dir = mkdtempSync(join(tmpdir(), "kd-joint-"));
const file = join(dir, "smoke.ans");
const drawn = { code: 219, fg: 12, bg: 1 }; // full block, bright red on blue
const at = { x: 3, y: 4 };
const resized = { columns: 40, rows: 12 };  // keeps (3,4): resize_canvas anchors top-left
let joint, locked;

try {
  joint = await startJointServer({ file, port: 0, path: "smoke", pass: "", quiet: true, columns: 80, rows: 25 });
  check("the rig starts a joint on a free port", joint.port > 0 && joint.path === "/smoke", joint.url);

  // --- A joins ------------------------------------------------------------
  const a = await Client.open("A", joint.url);
  const hello = await a.join("alpha", "killerdraw");
  check("CONNECTED gives the first client id 0", hello.id === 0, `id=${hello.id}`);
  check("CONNECTED carries status ACTIVE", hello.status === status.ACTIVE, `status=${hello.status}`);
  check("CONNECTED carries an empty users list for the first joiner", Array.isArray(hello.users) && hello.users.length === 0, JSON.stringify(hello.users));
  check("CONNECTED carries an empty chat history", Array.isArray(hello.chat_history) && hello.chat_history.length === 0);
  check("CONNECTED doc is compressed, not a flat array", !!hello.doc?.compressed_data && hello.doc.data === undefined, Object.keys(hello.doc ?? {}).join(","));
  check("CONNECTED doc metadata is the document's", hello.doc.columns === 80 && hello.doc.rows === 25 && hello.doc.font_name === "IBM VGA" && hello.doc.ice_colors === false && Array.isArray(hello.doc.palette), `${hello.doc.columns}x${hello.doc.rows} ${hello.doc.font_name}`);
  const unpacked = libtextmode.uncompress(structuredClone(hello.doc));
  check("compressed_data unpacks to 80x25 = 2000 blank cells", unpacked.data.length === 2000 && sameBlock(unpacked.data[0], BLANK), `${unpacked.data.length} cells, [0]=${JSON.stringify(unpacked.data[0])}`);

  // --- B joins, A sees the JOIN -------------------------------------------
  const b = await Client.open("B", joint.url);
  const hello_b = await b.join("beta");
  check("the second client gets id 1", hello_b.id === 1, `id=${hello_b.id}`);
  check("the second client's users list holds the first", hello_b.users.length === 1 && hello_b.users[0].nick === "alpha" && hello_b.users[0].id === 0 && hello_b.users[0].group === "killerdraw", JSON.stringify(hello_b.users));
  const joined = await a.next(action.JOIN);
  check("A is told about B with JOIN", joined.data.id === 1 && joined.data.nick === "beta" && joined.data.status === status.ACTIVE, JSON.stringify(joined.data));

  // --- DRAW ---------------------------------------------------------------
  a.send(action.DRAW, { ...at, block: drawn });
  const draw_b = await b.next(action.DRAW);
  check("B receives A's DRAW verbatim", draw_b.data.x === at.x && draw_b.data.y === at.y && sameBlock(draw_b.data.block, drawn), JSON.stringify(draw_b.data));
  await delay(120);
  check("the sender gets no DRAW echo", !a.seen().includes("DRAW"), a.seen().join(",") || "nothing");

  // an out-of-bounds DRAW is dropped, not relayed and not stored
  a.send(action.DRAW, { x: 999, y: 999, block: { code: 1, fg: 1, bg: 1 } });
  await delay(120);
  check("a DRAW outside the canvas is dropped", !b.seen().includes("DRAW"), b.seen().join(",") || "nothing");

  // --- SET_CANVAS_SIZE ----------------------------------------------------
  a.send(action.SET_CANVAS_SIZE, resized);
  const sized = await b.next(action.SET_CANVAS_SIZE);
  check("B receives A's SET_CANVAS_SIZE", sized.data.columns === resized.columns && sized.data.rows === resized.rows && sized.data.id === 0, JSON.stringify(sized.data));

  // --- CHAT ---------------------------------------------------------------
  a.send(action.CHAT, { nick: "alpha", group: "killerdraw", text: "hello joint" });
  const chat_b = await b.next(action.CHAT);
  check("B receives A's CHAT", chat_b.data.text === "hello joint" && chat_b.data.nick === "alpha" && chat_b.data.id === 0, JSON.stringify(chat_b.data));
  await delay(120);
  check("the sender gets no CHAT echo", !a.seen().includes("CHAT"), a.seen().join(",") || "nothing");

  const c = await Client.open("C", joint.url);
  const hello_c = await c.join("gamma");
  check("a later joiner is handed the chat history", hello_c.chat_history.length === 1 && hello_c.chat_history[0].text === "hello joint" && hello_c.chat_history[0].id === 0 && typeof hello_c.chat_history[0].time === "number", JSON.stringify(hello_c.chat_history));
  check("a later joiner sees the resized canvas", hello_c.doc.columns === resized.columns && hello_c.doc.rows === resized.rows, `${hello_c.doc.columns}x${hello_c.doc.rows}`);
  const c_unpacked = libtextmode.uncompress(structuredClone(hello_c.doc));
  check("the joint's live document holds the drawn cell", sameBlock(c_unpacked.data[at.y * resized.columns + at.x], drawn), JSON.stringify(c_unpacked.data[at.y * resized.columns + at.x]));
  await a.next(action.JOIN); // C's JOIN, so it does not confuse the LEAVE assertions

  // --- LEAVE --------------------------------------------------------------
  await c.close();
  const left_c = await a.next(action.LEAVE);
  check("A sees LEAVE when C disconnects", left_c.data.id === 2, JSON.stringify(left_c.data));
  await b.close();
  const left_b = await a.next(action.LEAVE);
  check("A sees LEAVE when B disconnects", left_b.data.id === 1, JSON.stringify(left_b.data));

  await a.close();

  // --- a password-protected joint, on the same port, a second path ---------
  locked = await startJointServer({ file: join(dir, "locked.ans"), port: joint.port, path: "locked", pass: "sekrit", quiet: true });
  check("a second joint shares the port on its own path", locked.port === joint.port && locked.path === "/locked", locked.url);
  const wrong = await Client.open("wrong", locked.url);
  wrong.send(action.CONNECTED, { nick: "nope", group: "", pass: "guess" });
  const refused = await wrong.next(action.REFUSED);
  check("a bad password gets REFUSED, not CONNECTED", same(refused.data, {}) && wrong.ws.readyState === WebSocket.OPEN, `data=${JSON.stringify(refused.data)} socket=${wrong.ws.readyState}`);
  await wrong.close();
  const right = await Client.open("right", locked.url);
  const hello_locked = await right.join("delta", "", "sekrit");
  check("the right password gets in", hello_locked.id === 0 && hello_locked.doc.columns === 80, `id=${hello_locked.id}`);
  await right.close();
  await locked.stop();

  // --- the file the server saved -----------------------------------------
  await joint.stop();
  const saved = statSync(file);
  check("stop() leaves a saved .ans behind", saved.size > 128, `${saved.size} bytes`);

  const reread = await libtextmode.read_file(file);
  check("libtextmode reads back the resized canvas", reread.columns === resized.columns && reread.rows === resized.rows, `${reread.columns}x${reread.rows}`);
  check("libtextmode reads back the drawn cell", sameBlock(reread.data[at.y * reread.columns + at.x], drawn), JSON.stringify(reread.data[at.y * reread.columns + at.x]));
  check("libtextmode reads back a neighbouring cell as blank", sameBlock(reread.data[at.y * reread.columns + at.x + 1], BLANK), JSON.stringify(reread.data[at.y * reread.columns + at.x + 1]));

  // --- second opinion: killerdraw's own ANSI parser ----------------------
  const dist = new URL("../packages/core/dist/index.js", import.meta.url);
  let haveDist = existsSync(dist);
  if (!haveDist) {
    try {
      execFileSync("npm", ["run", "build", "-w", "@killerdraw/core"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "ignore" });
      haveDist = existsSync(dist);
    } catch { /* reported as a SKIP below */ }
  }
  if (!haveDist) {
    skip("killerdraw's parseAnsi agrees with libtextmode", "packages/core/dist is absent and `npm run build -w @killerdraw/core` did not produce it");
  } else {
    const { parseAnsi } = await import(dist.href);
    const art = parseAnsi(new Uint8Array(readFileSync(file)));
    // width comes from SAUCE tinfo1; height is however many rows the encoder actually wrote, so
    // a canvas whose last rows are blank comes back shorter (the encoder emits nothing for them).
    check("killerdraw's parseAnsi reads the same canvas width", art.grid.width === resized.columns, `${art.grid.width}x${art.grid.height}`);
    check("killerdraw's parseAnsi reads at least the written rows", art.grid.height > at.y && art.grid.height <= resized.rows, `${art.grid.height} rows of ${resized.rows}`);
    const cell = art.grid.get(at.x, at.y);
    check("killerdraw's parseAnsi reads the same drawn cell", cell.glyph === drawn.code && cell.fg === drawn.fg && cell.bg === drawn.bg, JSON.stringify(cell));
    const nb = art.grid.get(at.x + 1, at.y);
    check("killerdraw's parseAnsi reads the neighbour as blank", nb.glyph === 32, JSON.stringify(nb));
  }
} catch (err) {
  failures++;
  console.log(`FAIL  smoke-joint threw  (${err?.stack ?? err})`);
} finally {
  try { await locked?.stop(); } catch { /* already stopped */ }
  try { await joint?.stop(); } catch { /* already stopped */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failure${failures === 1 ? "" : "s"}` : "\nall joint checks passed");
process.exit(failures ? 1 : 0);
