/**
 * The joint client: one WebSocket to a Moebius collaboration server.
 *
 * The server holds a flat 16-colour canvas and relays single-cell DRAWs, last
 * writer wins, never echoed to the sender. `JointSync.shared` (S) mirrors it.
 * Incoming DRAWs land in a Remote layer pinned on top of the document, so other
 * people's work shows exactly as the server has it whatever our layers do
 * underneath; outgoing DRAWs come from diffing L — the composite of everything
 * *except* Remote — against S after every local change.
 *
 * The Editor holds no socket code: this subscribes to its "pixels" (a change
 * was composited) and "doc" (settings changed) events, and the canvas view asks
 * `ed.joint` for other people's cursors.
 */
import {
  CellGrid, type CellsLayer, type Composite, type JointCanvasSizeData, type JointChatData, type JointChatLine,
  type JointConnectResponse, type JointDoc, type JointDrawData, type JointFlagData, type JointFontData, type JointJoinData,
  type JointMessage, type JointPosData, type JointSauceData, type JointStatus, type JointStatusData, type JointSyncDiff,
  type JointUser, type Rect, JOINT_ACTION, JOINT_STATUS, JointSync, commentsFromWire, commentsToWire, composite,
  createCellsLayer, createDocument, encodeJointMessage, findLayer, gridFromJointDoc, isConnectResponse, parseJointMessage,
  sharedFromBlocks, unpackJointDoc,
} from "@killerdraw/core";
import type { Editor } from "./editor.js";

const {
  CONNECTED, REFUSED, JOIN, LEAVE, CURSOR, HIDE_CURSOR, DRAW, CHAT, STATUS, SAUCE, ICE_COLORS, USE_9PX_FONT,
  CHANGE_FONT, SET_CANVAS_SIZE,
} = JOINT_ACTION;

/** Moebius's own idle steps: a minute of silence is idle, four more is away (doc.js start_away_timers). */
const IDLE_MS = 60_000, AWAY_MS = 4 * 60_000;
/** one CURSOR at most this often: a pointer crosses dozens of cells a second */
const CURSOR_MS = 50;
/** a joint bigger than this is not a joint we can open — the guard is against a malicious RLE, not a big canvas */
const MAX_CELLS = 1_000_000;

export const JOINT_STATUS_NAMES: Record<JointStatus, string> = { 0: "active", 1: "idle", 2: "away", 3: "web" };

export interface JointUserState extends JointUser {
  /** where their cursor is, or null when they have hidden it (pointer off the canvas) */
  cursor: { x: number; y: number } | null;
}

/** One line in the panel's log: someone's chat, or a note the client wrote itself. */
export interface JointLine {
  kind: "chat" | "note";
  text: string;
  nick?: string;
  group?: string;
  id?: number;
  time: number;
}

export interface JointConnectOptions {
  url: string;
  nick: string;
  group?: string;
  pass?: string;
  /** "open" replaces the document with the joint's canvas; "push" overwrites the joint with ours */
  mode?: "open" | "push";
}

/** What the client needs from the canvas view — declared here so neither file imports the other. */
export interface JointView {
  readonly hoverCell: { x: number; y: number } | null;
  drawOverlay(): void;
}

/**
 * Moebius users type a server and a path ("ansi.example.org:8000/piece.ans"),
 * not a URL. Anything without a scheme gets ws://; http(s) becomes ws(s).
 */
/** Is this page served over https? Then the browser only allows wss:// sockets. */
export function pageIsSecure(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

/** `host:8000/name` as a socket URL: plain ws:// as Moebius speaks it, or wss:// where the page itself is https. */
export function normalizeJointUrl(text: string, secure = pageIsSecure()): string {
  const t = text.trim().replace(/\s+/g, "");
  if (!t) return "";
  if (/^wss?:\/\//i.test(t)) return t;
  if (/^https?:\/\//i.test(t)) return t.replace(/^http/i, "ws");
  return `${secure ? "wss" : "ws"}://${t}`;
}

/**
 * Why an address cannot work before a socket is even tried: the browser's own
 * error for this one is buried in the console. A stock Moebius server lives at
 * the root (`host:8000`); `--path=name` puts it at `host:8000/name`.
 */
export function jointAddressProblem(url: string, secure = pageIsSecure()): string | null {
  if (secure && /^ws:\/\//i.test(url)) {
    return "This page is served over https, so the browser refuses a plain ws:// connection. Put the Moebius server behind a TLS proxy and connect to wss://… (the desktop app can use ws:// directly).";
  }
  return null;
}

/** The joint's path, as the server keys it: lower-cased, always with a leading "/". */
export function jointPathOf(url: string): string {
  const m = /^[a-z]+:\/\/[^/]*(\/.*)?$/i.exec(url);
  const path = (m?.[1] ?? "/").toLowerCase();
  return path.replace(/[?#].*$/, "") || "/";
}

/** A stable colour per user id. Multiplicative hash, so 1 and 2 are not neighbouring hues. */
export function cursorColor(id: number): string {
  const hue = Math.abs(Math.imul(id + 1, 2654435761)) % 360;
  return `hsl(${hue} 95% 62%)`;
}

/**
 * libtextmode reads the SAUCE fields as the fixed-width record has them, spaces
 * and all, so the server's title/author/group arrive padded. killerdraw's own
 * reader trims them (formats/sauce.ts), and so does this.
 */
const unpad = (s: string): string => s.replace(/[ \0]+$/, "");

/** Runs are [value, extra repeats]; how many cells they expand to (see protocol.ts's unpackRuns). */
function runsLength(runs: readonly [number, number][] | undefined): number {
  if (!Array.isArray(runs)) return 0;
  let n = 0;
  for (const run of runs) if (Array.isArray(run)) n += (run[1] | 0) + 1;
  return n;
}

/**
 * The CONNECTED reply's document, unpacked — but only if its RLE really is the
 * canvas it claims to be. Unpacking first and checking after would already have
 * allocated whatever the runs asked for.
 */
export function unpackJointDocCapped(doc: JointDoc): JointDoc {
  const columns = Math.max(0, doc.columns | 0), rows = Math.max(0, doc.rows | 0);
  const cells = columns * rows;
  if (!cells || cells > MAX_CELLS) throw new Error(`the joint's canvas is ${columns}×${rows}`);
  const packed = doc.compressed_data;
  if (packed) {
    for (const channel of ["code", "fg", "bg"] as const) {
      if (runsLength(packed[channel]) > cells) throw new Error(`the joint sent more ${channel} cells than its ${columns}×${rows} canvas holds`);
    }
  }
  if (doc.data && doc.data.length > cells) throw new Error(`the joint sent more cells than its ${columns}×${rows} canvas holds`);
  return unpackJointDoc(doc);
}

/** Document settings that have their own message on the wire. */
interface Settings {
  columns: number;
  rows: number;
  iceColors: boolean;
  ninePx: boolean;
  fontName: string;
  title: string;
  author: string;
  group: string;
  comments: string;
}

type Change = "state" | "users" | "chat" | "cursors";

export class JointClient {
  private ws: WebSocket | null = null;
  private sync: JointSync | null = null;
  private remote: CellsLayer | null = null;
  /** L, the composite without the Remote layer; kept so a one-cell change is a one-cell recomposite */
  private cachedL: Composite | null = null;
  /** true while we are applying something that came in: the outgoing diff must not run */
  private applying = false;
  private myId = -1;
  private last: Settings | null = null;
  private listeners = new Set<(what: Change) => void>();
  private timers = { idle: 0, away: 0, cursor: 0, flush: 0 };
  /** cells of the Remote layer that changed and are not composited yet */
  private dirty: Rect | null = null;
  private lastSentCursor: { x: number; y: number } | null = null;
  private pendingCursor: { x: number; y: number } | null = null;
  private cursorSentAt = 0;

  /** everyone else in the joint, by id — monotonic on the server and never reused, so a map, not an array */
  private readonly people = new Map<number, JointUserState>();
  lines: JointLine[] = [];
  url = "";
  path = "";
  nick = "";
  group = "";
  connecting = false;
  myStatus: JointStatus = JOINT_STATUS.ACTIVE;
  /** what went wrong last, for the connect dialog */
  error = "";
  sentDraws = 0;
  receivedDraws = 0;
  sent = 0;
  received = 0;

  constructor(private ed: Editor, private view: JointView) {
    ed.on("pixels", (rect) => this.afterLocalChange(rect as Rect | undefined));
    ed.on("doc", () => this.afterDocChange());
    // "status" is emitted on every pointer move over the canvas (and on messages, which change no cell)
    ed.on("status", () => this.hovered());
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && this.myId >= 0;
  }

  /** everyone else in the joint (we are not in the server's own users list) */
  get users(): JointUserState[] {
    return [...this.people.values()];
  }

  get id(): number {
    return this.myId;
  }

  onChange(fn: (what: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(what: Change): void {
    this.listeners.forEach((fn) => fn(what));
  }

  // ---------------------------------------------------------------- connecting

  /** Resolves once the server has answered CONNECTED; rejects with what to show the user. */
  connect(opts: JointConnectOptions): Promise<void> {
    this.disconnect("Left for another joint.");   // one joint at a time; the old Remote layer stays as a layer
    const url = normalizeJointUrl(opts.url);
    if (!url) return Promise.reject(new Error("no server address"));
    const problem = jointAddressProblem(url);
    if (problem) return Promise.reject(new Error(problem));
    this.url = url;
    this.path = jointPathOf(url);
    this.nick = opts.nick.trim() || "anon";
    this.group = opts.group?.trim() ?? "";
    this.error = "";
    this.connecting = true;
    this.changed("state");

    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (err) { this.fail((err as Error).message); reject(err); return; }
      this.ws = ws;
      let opened = false, done = false;
      const settle = (err?: Error): void => {
        if (done) return;
        done = true;
        this.connecting = false;
        if (err) { this.fail(err.message); reject(err); } else { this.changed("state"); resolve(); }
      };
      ws.onopen = () => {
        opened = true;
        // the one message with no `id`: we do not have one yet
        ws.send(encodeJointMessage({ type: CONNECTED, data: { nick: this.nick, group: this.group, pass: opts.pass ?? "" } }));
      };
      ws.onmessage = (e) => {
        const msg = parseJointMessage(typeof e.data === "string" ? e.data : "");
        if (!msg) return;                       // bad input is ignored, never thrown on: this reads the network
        this.received++;
        if (done) { this.handle(msg); return; }
        if (msg.type === REFUSED) {
          ws.close();                           // the server leaves the socket open after REFUSED
          settle(new Error("refused — wrong password, or the joint is not taking anyone else"));
          return;
        }
        if (msg.type !== CONNECTED || !isConnectResponse(msg.data)) return;
        try { this.join(msg.data, opts.mode ?? "open"); } catch (err) { ws.close(); settle(err as Error); return; }
        settle();
      };
      ws.onerror = () => {
        if (opened) return;
        settle(new Error(/^wss:/i.test(url)
          ? `could not connect to ${url} — no server there, no such joint on it, or nothing speaking TLS on that port (the Moebius server itself only speaks ws://; wss:// needs a proxy in front of it)`
          : `could not connect to ${url} — no server there, or no such joint on it`));
      };
      ws.onclose = () => {
        if (!done) settle(new Error(opened ? "the server closed the connection" : `could not connect to ${url} — no server there, or no such joint on it`));
        else if (this.myId >= 0) this.dropped("The joint closed the connection.");
      };
    });
  }

  private fail(message: string): void {
    this.error = message;
    this.connecting = false;
    this.note(message);
    this.changed("state");
    this.close();
  }

  /** Take the joint's document (or push ours over it) and start mirroring. */
  private join(reply: JointConnectResponse, mode: "open" | "push"): void {
    const doc = unpackJointDocCapped(reply.doc);
    const columns = Math.max(1, doc.columns | 0), rows = Math.max(1, doc.rows | 0);
    this.myId = reply.id;
    this.myStatus = reply.status ?? JOINT_STATUS.ACTIVE;
    this.people.clear();
    for (const u of reply.users ?? []) this.people.set(u.id, { ...u, cursor: null });   // we are not in this list
    this.lines = (reply.chat_history ?? []).map((c: JointChatLine) => ({ kind: "chat", id: c.id, nick: c.nick, group: c.group, text: c.text, time: c.time }));
    this.sentDraws = this.receivedDraws = 0;
    this.cachedL = null;
    this.prevL = null;
    this.dirty = null;
    this.lastSentCursor = null;

    const settings = gridFromJointDoc(doc);
    this.sync = new JointSync(sharedFromBlocks(columns, rows, doc.data), settings.palette);
    this.applying = true;
    try {
      if (mode === "open") {
        const next = createDocument(columns, rows);
        const base = next.layers[0] as CellsLayer;
        base.name = "joint canvas";
        base.grid = settings.grid;
        next.iceColors = settings.iceColors;
        next.letterSpacing9px = settings.letterSpacing9px;
        next.fontName = unpad(settings.fontName);
        next.palette = settings.palette;
        next.sauce = {
          title: unpad(settings.title), author: unpad(settings.author), group: unpad(settings.group),
          date: unpad(settings.date), comments: settings.comments.map(unpad),
        };
        next.layers.push(this.newRemoteLayer(columns, rows));
        this.ed.setDocument(next, `joint: ${this.path}`);
        this.ed.setActive(base.id);   // setDocument selects the topmost layer, which is Remote
      } else {
        this.ed.doc.layers.push(this.newRemoteLayer(this.ed.doc.width, this.ed.doc.height));
        this.ed.recomposite();
      }
    } finally { this.applying = false; }
    this.snapshot();
    this.snapshotL();   // nothing is pending: in open mode L is the joint's own canvas
    this.note(mode === "open" ? `joined ${this.path} as ${this.nick} — ${columns}×${rows}` : `joined ${this.path} as ${this.nick}, pushing this document`);
    this.touch();
    // before the "doc" event: it is the settings watcher, and in push mode the sizes differ on purpose
    if (mode === "push") this.pushDocument(columns, rows);
    this.ed.emit("doc");
    this.changed("users");
  }

  /** Overwrite the joint with the document we already have. */
  private pushDocument(columns: number, rows: number): void {
    const doc = this.ed.doc, sync = this.sync;
    if (!sync) return;
    if (doc.width !== columns || doc.height !== rows) {
      this.send({ type: SET_CANVAS_SIZE, data: { id: this.myId, columns: doc.width, rows: doc.height } });
      sync.resize(doc.width, doc.height);
      this.snapshot();
    }
    const L = this.buildL();
    this.sendDraws(sync.pushAll(L));   // the one place every cell is asserted on purpose
    this.prevL = L.clone();
    this.note(`pushed ${this.sentDraws} cell${this.sentDraws === 1 ? "" : "s"} into the joint`);
  }

  private newRemoteLayer(columns: number, rows: number): CellsLayer {
    // a project saved while in a joint keeps the marker: those cells are this document's now,
    // not this joint's, so the layer goes back to being an ordinary one and is pushed like any other
    for (const l of this.ed.doc.layers) if (l.type !== "group" && l.joint) delete l.joint;
    const layer = createCellsLayer("joint: others", columns, rows);
    layer.joint = "remote";
    this.remote = layer;
    return layer;
  }

  /** Close the socket and the timers without touching the document. */
  private close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; try { ws.close(); } catch { /* already gone */ } }
    for (const key of ["idle", "away", "cursor", "flush"] as const) { clearTimeout(this.timers[key]); this.timers[key] = 0; }
    this.myId = -1;
    this.sync = null;
    this.cachedL = null;
    this.prevL = null;
    this.people.clear();
  }

  /** The document stays as it is; the Remote layer becomes an ordinary layer. */
  disconnect(reason = "Left the joint."): void {
    if (!this.ws && this.myId < 0 && !this.remote) return;
    const path = this.path;
    this.close();
    this.connecting = false;
    if (this.remote) { delete this.remote.joint; this.remote = null; }
    this.note(reason);
    this.ed.setStatus(`${reason} “joint: others” is an ordinary layer now — keep it, edit it or delete it.`);
    this.ed.emit("doc");
    this.view.drawOverlay();
    this.changed("state");
    if (path) this.changed("users");
  }

  /** The socket went away on its own. */
  private dropped(reason: string): void {
    this.error = reason;
    this.disconnect(reason);
  }

  // ---------------------------------------------------------------- sending

  private sendRaw(msg: JointMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeJointMessage(msg));
    this.sent++;
  }

  /** Every message but STATUS itself also says "I am here": Moebius restarts its away timers in send(). */
  private send(msg: JointMessage): void {
    this.sendRaw(msg);
    this.touch();
  }

  private touch(): void {
    if (this.myStatus !== JOINT_STATUS.ACTIVE) this.setStatus(JOINT_STATUS.ACTIVE);
    clearTimeout(this.timers.idle);
    clearTimeout(this.timers.away);
    this.timers.idle = window.setTimeout(() => {
      this.setStatus(JOINT_STATUS.IDLE);
      this.timers.away = window.setTimeout(() => this.setStatus(JOINT_STATUS.AWAY), AWAY_MS);
    }, IDLE_MS);
  }

  private setStatus(status: JointStatus): void {
    if (!this.connected || this.myStatus === status) return;
    this.myStatus = status;
    this.sendRaw({ type: STATUS, data: { id: this.myId, status } });   // sendRaw: it must not restart the timers
    this.changed("users");
  }

  chat(text: string): void {
    const line = text.trim();
    if (!line || !this.connected) return;
    this.send({ type: CHAT, data: { id: this.myId, nick: this.nick, group: this.group, text: line } });
    this.push({ kind: "chat", id: this.myId, nick: this.nick, group: this.group, text: line, time: Date.now() });
  }

  private note(text: string): void {
    this.push({ kind: "note", text, time: Date.now() });
  }

  private push(line: JointLine): void {
    this.lines.push(line);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    this.changed("chat");
  }

  // ---------------------------------------------------------------- outgoing cells

  /**
   * L: the document composited with the Remote layer left out. `ed.comp` is the
   * view's, so this keeps its own cache and never disturbs it.
   */
  private buildL(rect?: Rect): Composite["grid"] {
    const ed = this.ed, remote = this.remote;
    const was = remote?.visible;
    if (remote) remote.visible = false;
    try {
      const into = this.cachedL;
      const fresh = !into || into.grid.width !== ed.doc.width || into.grid.height !== ed.doc.height;
      this.cachedL = composite(ed.doc, { glyphs: ed.glyphs }, fresh ? undefined : rect, fresh ? undefined : into);
      return this.cachedL.grid;
    } finally { if (remote && was !== undefined) remote.visible = was; }
  }

  /** L as it was after the last change we looked at, so we can tell what *we* changed. */
  private prevL: CellGrid | null = null;

  private snapshotL(): void {
    this.prevL = this.buildL().clone();
  }

  /**
   * After any local change: send the cells we changed, and clear Remote where we
   * superseded it.
   *
   * What goes on the wire is driven by what changed in L since the last
   * composite — not by every cell where L differs from S. A cell nobody here has
   * touched belongs to whoever last drew it, and L (which leaves Remote out) has
   * our own older content there: asserting that is how two clients end up
   * fighting, and `recomposite()` hands us the whole canvas on every undo, layer
   * move and resize. So the pixels rect only says where to look.
   */
  private afterLocalChange(rect?: Rect): void {
    const sync = this.sync;
    if (!sync || this.applying || !this.connected) return;
    this.ensureRemote();   // a replaced document: L must leave the new layer out, and the clears must land in it
    // the canvas size goes first: the server drops a DRAW outside its own canvas
    const resized = this.syncCanvasSize();
    const area = resized ? undefined : rect;
    const L = this.buildL(area);
    // after a resize the old L is reframed, so cells the canvas just grew into are compared too
    if (!this.prevL || this.prevL.width !== L.width || this.prevL.height !== L.height) {
      this.prevL = this.prevL ? this.prevL.reframed({ x: 0, y: 0, width: L.width, height: L.height }) : new CellGrid(L.width, L.height);
    }
    const P = this.prevL;
    const x0 = area ? Math.max(0, area.x) : 0, y0 = area ? Math.max(0, area.y) : 0;
    const x1 = area ? Math.min(L.width, area.x + area.width) : L.width;
    const y1 = area ? Math.min(L.height, area.y + area.height) : L.height;
    for (let y = y0; y < y1; y++) {
      let run = -1;
      // runs of changed cells, so the diff never reaches a cell we left alone
      for (let x = x0; x <= x1; x++) {
        const i = y * L.width + x;
        const changed = x < x1 && (L.glyph[i] !== P.glyph[i] || L.fg[i] !== P.fg[i] || L.bg[i] !== P.bg[i] || L.present[i] !== P.present[i]);
        if (changed) { if (run < 0) run = x; continue; }
        if (run < 0) continue;
        const from = y * L.width + run, width = x - run;
        this.sendDraws(sync.diff(L, { x: run, y, width, height: 1 }));
        P.glyph.set(L.glyph.subarray(from, from + width), from);
        P.fg.set(L.fg.subarray(from, from + width), from);
        P.bg.set(L.bg.subarray(from, from + width), from);
        P.present.set(L.present.subarray(from, from + width), from);
        run = -1;
      }
    }
  }

  /** Tell the joint about a local resize (and follow it in S and Remote). True if anything changed. */
  private syncCanvasSize(): boolean {
    const sync = this.sync, doc = this.ed.doc;
    if (!sync || (sync.width === doc.width && sync.height === doc.height)) return false;
    this.send({ type: SET_CANVAS_SIZE, data: { id: this.myId, columns: doc.width, rows: doc.height } });
    sync.resize(doc.width, doc.height);
    this.resizeRemote();
    this.snapshot();
    this.note(`you changed the canvas size to ${doc.width}×${doc.height}`);
    return true;
  }

  private resizeRemote(): void {
    const remote = this.remote, doc = this.ed.doc;
    if (!remote || (remote.grid.width === doc.width && remote.grid.height === doc.height)) return;
    remote.grid = remote.grid.reframed({ x: 0, y: 0, width: doc.width, height: doc.height });
  }

  private sendDraws(diff: JointSyncDiff): void {
    for (const d of diff.draws) {
      if (d.x < 0 || d.y < 0) continue;   // the server indexes its array with these: never send them
      this.send({ type: DRAW, data: { id: this.myId, x: d.x, y: d.y, block: d.block } });
      this.sentDraws++;
    }
    // our edit supersedes the older remote cell; without this it would stay on top of it
    const remote = this.remote;
    if (!remote) return;
    let dirty: Rect | null = null;
    for (const [x, y] of diff.clear) {
      if (!remote.grid.inBounds(x, y)) continue;
      const i = remote.grid.index(x, y);
      if (!remote.grid.present[i]) continue;
      remote.grid.present[i] = 0;
      dirty = grow(dirty, x, y);
    }
    if (dirty) this.recompositeQuietly(dirty);
    if (diff.draws.length) this.changed("state");
  }

  /** Recomposite a change that is already in S, so the diff does not run again for it. */
  private recompositeQuietly(rect: Rect): void {
    this.applying = true;
    try { this.ed.recomposite(rect); } finally { this.applying = false; }
  }

  // ---------------------------------------------------------------- settings both ways

  private snapshot(): void {
    const doc = this.ed.doc, s = doc.sauce;
    this.last = {
      columns: doc.width, rows: doc.height, iceColors: doc.iceColors, ninePx: doc.letterSpacing9px,
      fontName: doc.fontName, title: s.title, author: s.author, group: s.group, comments: commentsToWire(s.comments),
    };
  }

  /** Local setting changes become their own messages; comparing against the last values catches every path. */
  private afterDocChange(): void {
    if (!this.connected || this.applying) return;
    const doc = this.ed.doc, s = doc.sauce, last = this.last;
    if (!last) { this.snapshot(); return; }
    if (doc.iceColors !== last.iceColors) this.send({ type: ICE_COLORS, data: { id: this.myId, value: doc.iceColors } });
    if (doc.letterSpacing9px !== last.ninePx) this.send({ type: USE_9PX_FONT, data: { id: this.myId, value: doc.letterSpacing9px } });
    if (doc.fontName !== last.fontName) this.send({ type: CHANGE_FONT, data: { id: this.myId, font_name: doc.fontName } });
    const comments = commentsToWire(s.comments);
    if (s.title !== last.title || s.author !== last.author || s.group !== last.group || comments !== last.comments) {
      this.send({ type: SAUCE, data: { id: this.myId, title: s.title, author: s.author, group: s.group, comments } });
    }
    this.syncCanvasSize();   // normally already done in afterLocalChange; here for a path that changed no cell
    this.snapshot();
  }

  /**
   * An incoming setting. Applied outside the undo history on purpose: it is not
   * this user's edit, and undoing it would send it straight back.
   */
  private applyRemote(fn: () => void, recomposite: "quiet" | "diff"): void {
    this.applying = true;
    try { fn(); this.snapshot(); if (recomposite === "quiet") this.ed.recomposite(); } finally { this.applying = false; }
    if (recomposite === "diff") this.ed.recomposite();
    this.ed.emit("doc");
  }

  // ---------------------------------------------------------------- incoming

  private handle(msg: JointMessage): void {
    switch (msg.type) {
      case DRAW: return this.onDraw(msg.data);
      case JOIN: return this.onJoin(msg.data);
      case LEAVE: return this.onLeave(msg.data.id);
      case CURSOR: return this.onCursor(msg.data);
      case HIDE_CURSOR: return this.onCursor({ ...msg.data, x: -1, y: -1 });   // -1: "no cursor", as onCursor reads it
      case CHAT: return this.onChat(msg.data);
      case STATUS: return this.onStatus(msg.data);
      case SAUCE: return this.onSauce(msg.data);
      case ICE_COLORS: return this.onFlag("iceColors", msg.data);
      case USE_9PX_FONT: return this.onFlag("letterSpacing9px", msg.data);
      case CHANGE_FONT: return this.onFont(msg.data);
      case SET_CANVAS_SIZE: return this.onCanvasSize(msg.data);
      default: return;   // SELECTION, OPERATION, PASTE_AS_SELECTION, ROTATE, FLIP_*, SET_BG: not in this version
    }
  }

  private who(id: number): string {
    const u = this.people.get(id);
    return u?.nick || (id === this.myId ? this.nick : `user ${id}`);
  }

  /**
   * The layer the others' cells go into, in the document as it is *now*. The
   * document can be replaced under a live joint (New, Open — to bring a piece
   * into the room), or the layer deleted; then a fresh one goes on top, and the
   * document's own cells flow out through the diff like a push.
   */
  private ensureRemote(): CellsLayer | null {
    if (!this.sync) return null;
    const doc = this.ed.doc;
    if (this.remote && findLayer(doc.layers, this.remote.id)) return this.remote;
    const layer = this.newRemoteLayer(doc.width, doc.height);
    doc.layers.push(layer);
    this.note("the document changed under the joint: its cells go into the room, and the others' cells into a new “joint: others” layer");
    return layer;
  }

  private onDraw(d: JointDrawData): void {
    const sync = this.sync, remote = this.ensureRemote();
    if (!sync || !remote) return;
    const hit = sync.receive(d.x, d.y, d.block);
    if (!hit) return;
    this.receivedDraws++;
    if (remote.grid.inBounds(hit.x, hit.y)) remote.grid.set(hit.x, hit.y, hit.cell);
    this.dirty = grow(this.dirty, hit.x, hit.y);
    // a burst of DRAWs (someone pushing a document) becomes one recomposite
    if (!this.timers.flush) this.timers.flush = window.setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.timers.flush = 0;
    const rect = this.dirty;
    this.dirty = null;
    if (!rect) return;
    this.recompositeQuietly(rect);
    this.changed("state");
  }

  private onJoin(d: JointJoinData): void {
    if (d.id === this.myId) return;
    this.people.set(d.id, { id: d.id, nick: d.nick, group: d.group, status: d.status, cursor: null });
    this.note(`${d.nick ?? `user ${d.id}`}${d.group ? ` (${d.group})` : ""} joined`);
    this.changed("users");
  }

  private onLeave(id: number): void {
    const gone = this.people.get(id);
    this.people.delete(id);
    this.note(`${gone?.nick ?? `user ${id}`} left`);
    this.changed("users");
  }

  private onCursor(d: JointPosData): void {
    if (d.id === this.myId) return;
    const u = this.people.get(d.id);
    if (!u) return;
    u.cursor = d.x < 0 || d.y < 0 ? null : { x: d.x, y: d.y };
    this.view.drawOverlay();
    this.changed("cursors");
  }

  private onChat(d: JointChatData): void {
    const u = this.people.get(d.id);
    if (u) { u.nick = d.nick; u.group = d.group; }   // CHAT is also how a rename reaches us
    this.push({ kind: "chat", id: d.id, nick: d.nick, group: d.group, text: d.text, time: d.time ?? Date.now() });
    if (u) this.changed("users");
  }

  private onStatus(d: JointStatusData): void {
    if (d.id === this.myId) { this.myStatus = d.status; this.changed("users"); return; }   // STATUS is the one thing echoed to its sender
    const u = this.people.get(d.id);
    if (!u) return;
    u.status = d.status;
    this.changed("users");
  }

  private onSauce(d: JointSauceData): void {
    const doc = this.ed.doc;
    this.applyRemote(() => {
      doc.sauce = {
        ...doc.sauce, title: unpad(d.title), author: unpad(d.author), group: unpad(d.group),
        comments: commentsFromWire(d.comments).map(unpad),
      };
    }, "quiet");
    this.note(`${this.who(d.id)} changed the SAUCE`);
  }

  private onFlag(key: "iceColors" | "letterSpacing9px", d: JointFlagData): void {
    const doc = this.ed.doc;
    this.applyRemote(() => { doc[key] = d.value; }, "quiet");
    this.note(`${this.who(d.id)} turned ${key === "iceColors" ? "iCE colours" : "9px letter spacing"} ${d.value ? "on" : "off"}`);
  }

  private onFont(d: JointFontData): void {
    const doc = this.ed.doc;
    this.applyRemote(() => { doc.fontName = unpad(d.font_name); }, "quiet");
    this.note(`${this.who(d.id)} changed the font to ${d.font_name}`);
  }

  /**
   * libtextmode's resize_canvas keeps the top-left and drops the rest, which is
   * what JointSync.resize does. Our layers keep their cells outside the canvas,
   * so growing again brings them back — and anything of ours the joint has never
   * seen is sent by the diff the recomposite triggers.
   */
  private onCanvasSize(d: JointCanvasSizeData): void {
    const columns = Math.max(1, d.columns | 0), rows = Math.max(1, d.rows | 0);
    const doc = this.ed.doc;
    this.sync?.resize(columns, rows);
    this.applyRemote(() => { doc.width = columns; doc.height = rows; this.resizeRemote(); }, "diff");
    this.note(`${this.who(d.id)} changed the canvas size to ${columns}×${rows}`);
    this.ed.setStatus(`${this.who(d.id)} resized the joint canvas to ${columns}×${rows}.`);
  }

  // ---------------------------------------------------------------- presence

  /** The hovered cell changed (or the pointer left the canvas). */
  private hovered(): void {
    if (!this.connected) return;
    const p = this.view.hoverCell;
    if (!p) {
      if (!this.lastSentCursor) return;
      this.lastSentCursor = null;
      this.pendingCursor = null;
      this.send({ type: HIDE_CURSOR, data: { id: this.myId } });
      return;
    }
    if (this.lastSentCursor && this.lastSentCursor.x === p.x && this.lastSentCursor.y === p.y) return;
    this.pendingCursor = { x: p.x, y: p.y };
    const wait = CURSOR_MS - (Date.now() - this.cursorSentAt);
    if (wait <= 0) this.flushCursor();
    else if (!this.timers.cursor) this.timers.cursor = window.setTimeout(() => this.flushCursor(), wait);
  }

  private flushCursor(): void {
    clearTimeout(this.timers.cursor);
    this.timers.cursor = 0;
    const p = this.pendingCursor;
    this.pendingCursor = null;
    if (!p || !this.connected || p.x < 0 || p.y < 0) return;
    this.lastSentCursor = p;
    this.cursorSentAt = Date.now();
    this.send({ type: CURSOR, data: { id: this.myId, x: p.x, y: p.y } });   // moving the pointer is activity, as in Moebius
  }

  /** What the canvas view draws: everyone else's cursor, with a colour of their own. */
  cursors(): { id: number; nick: string; x: number; y: number; color: string }[] {
    if (!this.connected) return [];
    const out: { id: number; nick: string; x: number; y: number; color: string }[] = [];
    for (const u of this.people.values()) {
      if (!u.cursor) continue;
      out.push({ id: u.id, nick: u.nick ?? `user ${u.id}`, x: u.cursor.x, y: u.cursor.y, color: cursorColor(u.id) });
    }
    return out;
  }
}

/** The rect grown to hold one more cell. */
function grow(rect: Rect | null, x: number, y: number): Rect {
  if (!rect) return { x, y, width: 1, height: 1 };
  const x0 = Math.min(rect.x, x), y0 = Math.min(rect.y, y);
  const x1 = Math.max(rect.x + rect.width, x + 1), y1 = Math.max(rect.y + rect.height, y + 1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
