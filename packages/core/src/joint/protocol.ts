/** Joint protocol: messages, and the document as the server packs it. */
import { type Rgb, VGA_PALETTE } from "../color.js";
import { CellGrid } from "../grid.js";
import { sauceDate } from "../formats/sauce.js";
import {
  CLEAR_BLOCK, JOINT_ACTION, type JointAction, type JointBlock, type JointChatLine, type JointCompressed,
  type JointDoc, type JointRgb, type JointStatus, type JointUser, blockToCell, cellToBlock,
} from "./types.js";

// ---------------------------------------------------------------- RLE

type Run = [number, number];

/**
 * libtextmode.compress's run encoding, channel by channel (libtextmode.js:577):
 * `[value, extra repeats]`, so a lone cell is `[v, 0]`. Deliberately the same
 * loop shape — the server hands this straight to its clients, so a byte we
 * spell differently is a byte Moebius decodes differently.
 */
function packRuns(values: ArrayLike<number>, n: number): Run[] {
  const runs: Run[] = [];
  for (let i = 0, repeat = 0; i < n; i++) {
    if (i + 1 === n) runs.push([values[i], repeat]);
    else if (values[i] !== values[i + 1]) { runs.push([values[i], repeat]); repeat = 0; }
    else repeat += 1;
  }
  return runs;
}

function unpackRuns(runs: readonly Run[] | undefined, out: number[]): void {
  if (!Array.isArray(runs)) return;
  for (const run of runs) {
    if (!Array.isArray(run)) continue;
    for (let i = 0, extra = run[1] | 0; i <= extra; i++) out.push(run[0]);
  }
}

/** doc with `data` replaced by `compressed_data`, in libtextmode.compress's key order. */
export function packJointDoc(doc: JointDoc): JointDoc {
  const { data, compressed_data, ...rest } = doc;
  if (!data) return { ...rest, ...(rest.palette ? { palette: clonePalette(rest.palette) } : {}), compressed_data };
  const n = data.length;
  const code = new Array<number>(n), fg = new Array<number>(n), bg = new Array<number>(n);
  for (let i = 0; i < n; i++) { const b = data[i]; code[i] = b.code; fg[i] = b.fg; bg[i] = b.bg; }
  const packed: JointCompressed = { code: packRuns(code, n), fg: packRuns(fg, n), bg: packRuns(bg, n) };
  return { ...rest, ...(rest.palette ? { palette: clonePalette(rest.palette) } : {}), compressed_data: packed };
}

/**
 * doc with `compressed_data` expanded into `data` (libtextmode.js:610). Pure,
 * unlike libtextmode's uncompress, which mutates and `delete`s the packed field.
 * Length follows the code channel; where fg or bg runs short — only malformed
 * input — the clear block's defaults fill in, where libtextmode leaves undefined.
 */
export function unpackJointDoc(doc: JointDoc): JointDoc {
  const { compressed_data, data, ...rest } = doc;
  const palette = rest.palette ? { palette: clonePalette(rest.palette) } : {};
  if (!compressed_data) return { ...rest, ...palette, data: data ? data.map((b) => ({ ...b })) : undefined };
  const code: number[] = [], fg: number[] = [], bg: number[] = [];
  unpackRuns(compressed_data.code, code);
  unpackRuns(compressed_data.fg, fg);
  unpackRuns(compressed_data.bg, bg);
  const out = new Array<JointBlock>(code.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = { code: code[i], fg: fg[i] ?? CLEAR_BLOCK.fg, bg: bg[i] ?? CLEAR_BLOCK.bg };
  }
  return { ...rest, ...palette, data: out };
}

// ---------------------------------------------------------------- palette

function clonePalette(palette: readonly JointRgb[]): JointRgb[] {
  return palette.map((c) => ({ r: c.r, g: c.g, b: c.b }));
}

/** libtextmode's convert_6bits_to_8bits (palette.js), so 63 lands on 255 and 42 on 170. */
function sixToEight(v: number): number {
  const x = v & 0x3f;
  return (x << 2) | ((x & 0x30) >> 4);
}

export function rgbToJoint(c: Rgb): JointRgb {
  return { r: c[0] >> 2, g: c[1] >> 2, b: c[2] >> 2 };
}

export function jointToRgb(c: JointRgb): Rgb {
  return [sixToEight(c.r), sixToEight(c.g), sixToEight(c.b)];
}

/** SAUCE comment lines as the wire wants them: one string (see JointDoc.comments). */
export function commentsToWire(comments: readonly string[] | string): string {
  return typeof comments === "string" ? comments : comments.join("\n");
}

export function commentsFromWire(comments: string | undefined): string[] {
  return comments ? comments.split("\n") : [];
}

// ---------------------------------------------------------------- doc <-> grid

/** killerdraw's document settings, in killerdraw's names. */
export interface JointDocSettings {
  title: string;
  author: string;
  group: string;
  /** CCYYMMDD; "" is stamped with today, as libtextmode's new_document does (libtextmode.js:559) */
  date: string;
  comments: readonly string[] | string;
  fontName: string;
  letterSpacing9px: boolean;
  iceColors: boolean;
  /** 16 sRGB entries; the VGA palette when absent */
  palette?: readonly Rgb[];
}

export interface JointGridResult extends JointDocSettings {
  grid: CellGrid;
  comments: string[];
  palette: Rgb[];
}

/** An unpacked JointDoc from one composited grid: every cell becomes a block. */
export function jointDocFromGrid(grid: CellGrid, settings: JointDocSettings): JointDoc {
  const palette = settings.palette ?? VGA_PALETTE;
  const n = grid.width * grid.height;
  const data = new Array<JointBlock>(n);
  for (let i = 0; i < n; i++) data[i] = cellToBlock(grid.getAt(i), palette);
  return {
    columns: grid.width,
    rows: grid.height,
    title: settings.title,
    author: settings.author,
    group: settings.group,
    date: settings.date || sauceDate(),
    palette: palette.map(rgbToJoint),
    font_name: settings.fontName,
    ice_colors: settings.iceColors,
    use_9px_font: settings.letterSpacing9px,
    comments: commentsToWire(settings.comments),
    data,
  };
}

/**
 * The document back out, packed or not. Every cell is fully present: the joint
 * has no transparency, so a missing block is Moebius's clear block, not a hole.
 */
export function gridFromJointDoc(doc: JointDoc): JointGridResult {
  const d = doc.data ? doc : unpackJointDoc(doc);
  const columns = Math.max(0, d.columns | 0), rows = Math.max(0, d.rows | 0);
  const grid = new CellGrid(columns, rows);
  const data = d.data ?? [];
  for (let i = 0; i < columns * rows; i++) grid.setAt(i, blockToCell(data[i] ?? CLEAR_BLOCK));
  return {
    grid,
    title: d.title ?? "",
    author: d.author ?? "",
    group: d.group ?? "",
    date: d.date ?? "",
    comments: commentsFromWire(d.comments),
    fontName: d.font_name ?? "IBM VGA",
    letterSpacing9px: !!d.use_9px_font,
    iceColors: !!d.ice_colors,
    palette: (d.palette ?? []).length === 16 ? d.palette!.map(jointToRgb) : VGA_PALETTE.map((c) => [c[0], c[1], c[2]] as Rgb),
  };
}

// ---------------------------------------------------------------- messages

/**
 * CONNECTED is two different messages under one number: the client's request,
 * which is the one message that carries no `id` (doc.js's Connection.open
 * bypasses `send`, which stamps `data.id` on everything else), and the server's
 * reply (server.js:90/93). A web guest — `nick` undefined — gets only `{id, doc}`.
 */
export interface JointConnectRequest {
  nick?: string;
  group?: string;
  pass?: string;
}

export interface JointConnectResponse {
  id: number;
  /** packed: `compressed_data`, not `data` (server.js:93 sends libtextmode.compress) */
  doc: JointDoc;
  users?: JointUser[];
  chat_history?: JointChatLine[];
  status?: JointStatus;
}

export type JointConnectData = JointConnectRequest | JointConnectResponse;

export function isConnectResponse(data: JointConnectData): data is JointConnectResponse {
  return (data as JointConnectResponse).doc !== undefined;
}

/** ROTATE, FLIP_X, FLIP_Y and HIDE_CURSOR carry nothing but the sender. */
export interface JointIdData { id: number }
export interface JointJoinData { id: number; nick?: string; group?: string; status: JointStatus }
export interface JointPosData { id: number; x: number; y: number }
export interface JointDrawData { id: number; x: number; y: number; block: JointBlock }
/** `time` only on chat_history entries: the server stamps its copy but relays `msg.data` untouched (server.js:112-114). */
export interface JointChatData { id: number; nick: string; group: string; text: string; time?: number }
export interface JointStatusData { id: number; status: JointStatus }
/** no `date`, no font/colour flags: those are their own actions */
export interface JointSauceData { id: number; title: string; author: string; group: string; comments: string }
export interface JointFlagData { id: number; value: boolean }
export interface JointFontData { id: number; font_name: string }
export interface JointCanvasSizeData { id: number; columns: number; rows: number }
/** libtextmode.get_blocks's shape (libtextmode.js:631) plus whatever the cursor tacked on */
export interface JointBlocks { columns: number; rows: number; data: JointBlock[]; transparent?: boolean; is_move_operation?: boolean }
export interface JointPasteData { id: number; blocks: JointBlocks }
/** C64 background index */
export interface JointBgData { id: number; value: number }

type Msg<T extends JointAction, D> = { type: T; data: D };

export type JointMessage =
  | Msg<typeof JOINT_ACTION.CONNECTED, JointConnectData>
  | Msg<typeof JOINT_ACTION.REFUSED, Record<string, never>>
  | Msg<typeof JOINT_ACTION.JOIN, JointJoinData>
  | Msg<typeof JOINT_ACTION.LEAVE, JointIdData>
  | Msg<typeof JOINT_ACTION.CURSOR, JointPosData>
  | Msg<typeof JOINT_ACTION.SELECTION, JointPosData>
  | Msg<typeof JOINT_ACTION.RESIZE_SELECTION, JointPosData>
  | Msg<typeof JOINT_ACTION.OPERATION, JointPosData>
  | Msg<typeof JOINT_ACTION.HIDE_CURSOR, JointIdData>
  | Msg<typeof JOINT_ACTION.DRAW, JointDrawData>
  | Msg<typeof JOINT_ACTION.CHAT, JointChatData>
  | Msg<typeof JOINT_ACTION.STATUS, JointStatusData>
  | Msg<typeof JOINT_ACTION.SAUCE, JointSauceData>
  | Msg<typeof JOINT_ACTION.ICE_COLORS, JointFlagData>
  | Msg<typeof JOINT_ACTION.USE_9PX_FONT, JointFlagData>
  | Msg<typeof JOINT_ACTION.CHANGE_FONT, JointFontData>
  | Msg<typeof JOINT_ACTION.SET_CANVAS_SIZE, JointCanvasSizeData>
  | Msg<typeof JOINT_ACTION.PASTE_AS_SELECTION, JointPasteData>
  | Msg<typeof JOINT_ACTION.ROTATE, JointIdData>
  | Msg<typeof JOINT_ACTION.FLIP_X, JointIdData>
  | Msg<typeof JOINT_ACTION.FLIP_Y, JointIdData>
  | Msg<typeof JOINT_ACTION.SET_BG, JointBgData>;

/** One frame: `{type, data}` and nothing else, as server.js's `send` writes it. */
export function encodeJointMessage(msg: JointMessage): string {
  return JSON.stringify({ type: msg.type, data: msg.data });
}

type Fields = Record<string, unknown>;

const isObj = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): boolean => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const pos = (d: Fields): boolean => num(d.id) && num(d.x) && num(d.y);
const flag = (d: Fields): boolean => num(d.id) && typeof d.value === "boolean";
const isBlock = (v: unknown): boolean => isObj(v) && num(v.code) && num(v.fg) && num(v.bg);

/** Per action, the fields the shipped clients and server actually rely on. */
const CHECK: Record<JointAction, (d: Fields) => boolean> = {
  [JOINT_ACTION.CONNECTED]: (d) => (d.doc !== undefined || d.id !== undefined
    ? num(d.id) && isObj(d.doc)
    : optStr(d.nick) && optStr(d.group) && optStr(d.pass)),
  [JOINT_ACTION.REFUSED]: () => true,
  [JOINT_ACTION.JOIN]: (d) => num(d.id) && num(d.status) && optStr(d.nick) && optStr(d.group),
  [JOINT_ACTION.LEAVE]: (d) => num(d.id),
  [JOINT_ACTION.CURSOR]: pos,
  [JOINT_ACTION.SELECTION]: pos,
  [JOINT_ACTION.RESIZE_SELECTION]: pos,
  [JOINT_ACTION.OPERATION]: pos,
  [JOINT_ACTION.HIDE_CURSOR]: (d) => num(d.id),
  [JOINT_ACTION.DRAW]: (d) => pos(d) && isBlock(d.block),
  [JOINT_ACTION.CHAT]: (d) => num(d.id) && str(d.nick) && str(d.group) && str(d.text) && (d.time === undefined || num(d.time)),
  [JOINT_ACTION.STATUS]: (d) => num(d.id) && num(d.status),
  [JOINT_ACTION.SAUCE]: (d) => num(d.id) && str(d.title) && str(d.author) && str(d.group) && str(d.comments),
  [JOINT_ACTION.ICE_COLORS]: flag,
  [JOINT_ACTION.USE_9PX_FONT]: flag,
  [JOINT_ACTION.CHANGE_FONT]: (d) => num(d.id) && str(d.font_name),
  [JOINT_ACTION.SET_CANVAS_SIZE]: (d) => num(d.id) && num(d.columns) && num(d.rows),
  [JOINT_ACTION.PASTE_AS_SELECTION]: (d) => num(d.id) && isObj(d.blocks) && num(d.blocks.columns) && num(d.blocks.rows)
    && Array.isArray(d.blocks.data) && d.blocks.data.every(isBlock),
  [JOINT_ACTION.ROTATE]: (d) => num(d.id),
  [JOINT_ACTION.FLIP_X]: (d) => num(d.id),
  [JOINT_ACTION.FLIP_Y]: (d) => num(d.id),
  [JOINT_ACTION.SET_BG]: (d) => num(d.id) && num(d.value),
};

/** null for anything that is not a frame we understand — never throws, this reads the network. */
export function parseJointMessage(text: string): JointMessage | null {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(frame) || typeof frame.type !== "number") return null;
  const check = CHECK[frame.type as JointAction];
  // `data` is always sent, but default it: server.js's `send` omits nothing else
  const data = frame.data === undefined ? {} : frame.data;
  if (!check || !isObj(data) || !check(data)) return null;
  return { type: frame.type, data } as JointMessage;
}
