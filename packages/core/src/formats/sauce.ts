import { cp437Decode, cp437Encode } from "../cp437.js";

/** The descriptive SAUCE fields a document carries around. */
export interface Sauce {
  title: string;
  author: string;
  group: string;
  /** CCYYMMDD, or "" to stamp the export date */
  date: string;
  comments: string[];
}

/** Everything in a SAUCE record, as read from a file. */
export interface SauceRecord extends Sauce {
  fileSize: number;
  dataType: number;
  fileType: number;
  tinfo1: number;
  tinfo2: number;
  tinfo3: number;
  tinfo4: number;
  flags: number;
  fontName: string;
}

export const SAUCE_DATATYPE_CHARACTER = 1, SAUCE_DATATYPE_BINARYTEXT = 5, SAUCE_DATATYPE_XBIN = 6;
export const SAUCE_FILETYPE_ANSI = 1;
/**
 * The ANSiFlags byte (offset 105). Bit 0 is non-blink (iCE); bits 1-2 are the
 * letter spacing the art wants; bits 3-4 are the shape its pixels were meant
 * to be. 00 in a pair means "no preference", 11 is not valid.
 */
export const SAUCE_FLAG_ICE = 1, SAUCE_FLAG_8PX = 2, SAUCE_FLAG_9PX = 4;
export const SAUCE_MASK_SPACING = 6;
export const SAUCE_FLAG_AR_STRETCH = 8, SAUCE_FLAG_AR_SQUARE = 16, SAUCE_MASK_AR = 24;

/** How the art's pixels were meant to be shaped. */
export type AspectRatio = "none" | "stretch" | "square";

export function aspectFromFlags(flags: number): AspectRatio {
  const ar = flags & SAUCE_MASK_AR;
  return ar === SAUCE_FLAG_AR_STRETCH ? "stretch" : ar === SAUCE_FLAG_AR_SQUARE ? "square" : "none";
}

export function aspectToFlags(aspect: AspectRatio): number {
  return aspect === "stretch" ? SAUCE_FLAG_AR_STRETCH : aspect === "square" ? SAUCE_FLAG_AR_SQUARE : 0;
}

/**
 * How much taller than wide a pixel has to be drawn for art meant for a 4:3
 * screen. VGA text mode puts 80x25 cells on a 4:3 display: with 8-pixel cells
 * that is 640x400, which has to become 640x480 to fill 4:3, so 1.2; with
 * 9-pixel cells it is 720x400 becoming 720x540, so 1.35.
 */
export function aspectStretch(ninePx: boolean): number {
  return ninePx ? 1.35 : 1.2;
}

const RECORD = 128, COMMENT_LINE = 64;

function text(bytes: Uint8Array, at: number, len: number): string {
  let end = at + len;
  while (end > at && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0)) end--;
  return cp437Decode(bytes.subarray(at, end));
}

/**
 * Read the SAUCE record at the end of a file. `dataLength` is how many leading
 * bytes are actual content (before the EOF marker, comments and record).
 */
export function parseSauce(bytes: Uint8Array): { sauce: SauceRecord; dataLength: number } | null {
  if (bytes.length < RECORD) return null;
  const at = bytes.length - RECORD;
  if (cp437Decode(bytes.subarray(at, at + 7)) !== "SAUCE00") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset + at, RECORD);
  const nComments = v.getUint8(104);
  const comments: string[] = [];
  let dataLength = at;
  const commentAt = at - nComments * COMMENT_LINE - 5;
  if (nComments && commentAt >= 0 && cp437Decode(bytes.subarray(commentAt, commentAt + 5)) === "COMNT") {
    for (let i = 0; i < nComments; i++) comments.push(text(bytes, commentAt + 5 + i * COMMENT_LINE, COMMENT_LINE));
    dataLength = commentAt;
  }
  if (dataLength > 0 && bytes[dataLength - 1] === 0x1a) dataLength--;
  const sauce: SauceRecord = {
    title: text(bytes, at + 7, 35),
    author: text(bytes, at + 42, 20),
    group: text(bytes, at + 62, 20),
    date: text(bytes, at + 82, 8),
    fileSize: v.getUint32(90, true),
    dataType: v.getUint8(94),
    fileType: v.getUint8(95),
    tinfo1: v.getUint16(96, true),
    tinfo2: v.getUint16(98, true),
    tinfo3: v.getUint16(100, true),
    tinfo4: v.getUint16(102, true),
    flags: v.getUint8(105),
    fontName: text(bytes, at + 106, 22),
    comments,
  };
  // trust the recorded size when it is plausible; some writers leave it 0
  if (sauce.fileSize > 0 && sauce.fileSize <= dataLength) dataLength = sauce.fileSize;
  return { sauce, dataLength };
}

function put(out: Uint8Array, at: number, len: number, value: string, pad: number): void {
  out.fill(pad, at, at + len);
  out.set(cp437Encode(value).subarray(0, len), at);
}

export function sauceDate(d: Date = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** EOF marker + optional comment block + 128-byte record, ready to append to the data. */
export function encodeSauce(r: Omit<SauceRecord, "date"> & { date?: string }): Uint8Array {
  const comments = r.comments.slice(0, 255);
  const commentBytes = comments.length ? 5 + comments.length * COMMENT_LINE : 0;
  const out = new Uint8Array(1 + commentBytes + RECORD);
  out[0] = 0x1a;
  let at = 1;
  if (comments.length) {
    out.set(cp437Encode("COMNT"), at);
    comments.forEach((c, i) => put(out, at + 5 + i * COMMENT_LINE, COMMENT_LINE, c, 0x20));
    at += commentBytes;
  }
  out.set(cp437Encode("SAUCE00"), at);
  put(out, at + 7, 35, r.title, 0x20);
  put(out, at + 42, 20, r.author, 0x20);
  put(out, at + 62, 20, r.group, 0x20);
  put(out, at + 82, 8, r.date || sauceDate(), 0x20);
  const v = new DataView(out.buffer, at, RECORD);
  v.setUint32(90, r.fileSize, true);
  v.setUint8(94, r.dataType);
  v.setUint8(95, r.fileType);
  v.setUint16(96, r.tinfo1, true);
  v.setUint16(98, r.tinfo2, true);
  v.setUint16(100, r.tinfo3, true);
  v.setUint16(102, r.tinfo4, true);
  v.setUint8(104, comments.length);
  v.setUint8(105, r.flags);
  put(out, at + 106, 22, r.fontName, 0);
  return out;
}
