/**
 * The Moebius collaboration ("joint") protocol, as its server speaks it
 * (moebius/app/server.js): JSON `{type, data}` over one WebSocket, a flat
 * 16-colour canvas edited one cell at a time, last writer wins.
 */
import { type Color, type Rgb, VGA_PALETTE, isRgb, nearestIndex } from "../color.js";
import { CH_BG, CH_FG, CH_GLYPH, type Cell } from "../grid.js";

export const JOINT_ACTION = {
  CONNECTED: 0, REFUSED: 1, JOIN: 2, LEAVE: 3, CURSOR: 4, SELECTION: 5, RESIZE_SELECTION: 6, OPERATION: 7, HIDE_CURSOR: 8,
  DRAW: 9, CHAT: 10, STATUS: 11, SAUCE: 12, ICE_COLORS: 13, USE_9PX_FONT: 14, CHANGE_FONT: 15, SET_CANVAS_SIZE: 16,
  PASTE_AS_SELECTION: 17, ROTATE: 18, FLIP_X: 19, FLIP_Y: 20, SET_BG: 21,
} as const;
export type JointAction = (typeof JOINT_ACTION)[keyof typeof JOINT_ACTION];

export const JOINT_STATUS = { ACTIVE: 0, IDLE: 1, AWAY: 2, WEB: 3 } as const;
export type JointStatus = (typeof JOINT_STATUS)[keyof typeof JOINT_STATUS];

/** One cell on the wire: a CP437 code and palette indices (0-15; 8-15 for the background means bright with iCE, blink without). */
export interface JointBlock {
  code: number;
  fg: number;
  bg: number;
}

/** what Moebius writes when it erases a cell */
export const CLEAR_BLOCK: Readonly<JointBlock> = { code: 32, fg: 7, bg: 0 };

/**
 * A palette entry on the wire: 6-bit EGA DAC components (0-63), not sRGB —
 * libtextmode's `ega` is `{r: 42, g: 21, b: 0}` for brown (palette.js) and
 * scales up with `convert_6bits_to_8bits` only to draw.
 */
export interface JointRgb {
  r: number;
  g: number;
  b: number;
}

/** RLE as libtextmode.compress writes it: runs of [value, extra repeats]. */
export interface JointCompressed {
  code: [number, number][];
  fg: [number, number][];
  bg: [number, number][];
}

/**
 * A libtextmode document, as the server keeps and sends it. On the wire
 * (CONNECTED) the cells arrive as `compressed_data`; unpacked they are `data`.
 */
export interface JointDoc {
  columns: number;
  rows: number;
  title: string;
  author: string;
  group: string;
  date: string;
  /**
   * One string, lines joined by "\n" — not an array: libtextmode's
   * `new_document` defaults `comments = ""` (libtextmode.js:558) and its SAUCE
   * reader concatenates the 64-byte comment lines with "\n" (textmode.js:176-182).
   * The server assigns it straight from the SAUCE message (server.js:128).
   */
  comments: string;
  font_name: string;
  use_9px_font: boolean;
  ice_colors: boolean;
  /** 16 entries; libtextmode's default palette when absent */
  palette?: JointRgb[];
  /** C64 mode's single background index; `compress` carries it (libtextmode.js:607), undefined for ANSI */
  c64_background?: number;
  data?: JointBlock[];
  compressed_data?: JointCompressed;
}

export interface JointUser {
  id: number;
  nick: string | undefined;
  group: string | undefined;
  status: JointStatus;
}

export interface JointChatLine {
  id: number;
  nick: string;
  group: string;
  text: string;
  time: number;
}

/**
 * A cell as the joint sees it. Absent cells are Moebius's clear block;
 * missing channels take its defaults (light grey on black); 24-bit colours
 * become the nearest palette entry, since the wire has only 16.
 */
export function cellToBlock(cell: Cell, palette: readonly Rgb[] = VGA_PALETTE): JointBlock {
  if (!cell.present) return { ...CLEAR_BLOCK };
  const idx = (c: Color, fallback: number, has: boolean): number => (!has ? fallback : isRgb(c) ? nearestIndex(c, palette) : c);
  return {
    code: cell.present & CH_GLYPH ? cell.glyph : 32,
    fg: idx(cell.fg, CLEAR_BLOCK.fg, !!(cell.present & CH_FG)),
    bg: idx(cell.bg, CLEAR_BLOCK.bg, !!(cell.present & CH_BG)),
  };
}

/** The wire cell as layer cells: every channel present. */
export function blockToCell(block: JointBlock): { glyph: number; fg: Color; bg: Color } {
  return { glyph: block.code & 0xff, fg: block.fg & 0xf, bg: block.bg & 0xf };
}

export function blocksEqual(a: JointBlock, b: JointBlock): boolean {
  return a.code === b.code && a.fg === b.fg && a.bg === b.bg;
}
