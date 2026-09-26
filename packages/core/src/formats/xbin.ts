import type { Rgb } from "../color.js";
import type { CellGrid } from "../grid.js";
import type { ImportedArt } from "./ansi.js";
import { cellsFromPairs, pairsFromCells } from "./bin.js";
import { SAUCE_DATATYPE_XBIN, type Sauce, aspectFromFlags, encodeSauce, parseSauce } from "./sauce.js";

const FLAG_PALETTE = 1, FLAG_FONT = 2, FLAG_COMPRESS = 4, FLAG_NONBLINK = 8, FLAG_512 = 16;

/** XBIN: BIN plus its own size, and optionally a palette, a font and RLE. */
export function parseXbin(bytes: Uint8Array): ImportedArt {
  if (bytes.length < 11 || String.fromCharCode(...bytes.subarray(0, 4)) !== "XBIN" || bytes[4] !== 0x1a) {
    throw new Error("not an XBIN file");
  }
  const found = parseSauce(bytes);
  const end = found ? found.dataLength : bytes.length;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint16(5, true), height = v.getUint16(7, true);
  const fontHeight = bytes[9] || 16, flags = bytes[10];
  if (flags & FLAG_512) throw new Error("XBIN 512-character fonts are not supported");
  let at = 11;

  let palette: Rgb[] | undefined;
  if (flags & FLAG_PALETTE) {
    palette = [];
    for (let i = 0; i < 16; i++) {
      const c = [0, 1, 2].map((k) => { const s = bytes[at + i * 3 + k] & 63; return (s << 2) | (s >> 4); });
      palette.push([c[0], c[1], c[2]]);
    }
    at += 48;
  }
  let fontBytes: Uint8Array | undefined;
  if (flags & FLAG_FONT) {
    fontBytes = bytes.slice(at, at + fontHeight * 256);
    at += fontHeight * 256;
  }

  let pairs: Uint8Array;
  if (flags & FLAG_COMPRESS) {
    pairs = new Uint8Array(width * height * 2);
    let o = 0;
    while (at < end && o < pairs.length) {
      const head = bytes[at++];
      const type = head >> 6, count = (head & 63) + 1;
      if (type === 0) {
        pairs.set(bytes.subarray(at, at + count * 2), o);
        at += count * 2; o += count * 2;
      } else if (type === 1) {
        const ch = bytes[at++];
        for (let k = 0; k < count; k++) { pairs[o++] = ch; pairs[o++] = bytes[at++]; }
      } else if (type === 2) {
        const attr = bytes[at++];
        for (let k = 0; k < count; k++) { pairs[o++] = bytes[at++]; pairs[o++] = attr; }
      } else {
        const ch = bytes[at++], attr = bytes[at++];
        for (let k = 0; k < count; k++) { pairs[o++] = ch; pairs[o++] = attr; }
      }
    }
  } else {
    pairs = bytes.subarray(at, Math.min(end, at + width * height * 2));
  }

  return {
    grid: cellsFromPairs(pairs, width, height),
    sauce: found?.sauce ?? null,
    iceColors: (flags & FLAG_NONBLINK) !== 0,
    letterSpacing9px: false,
    aspectRatio: aspectFromFlags(found?.sauce.flags ?? 0),
    fontName: found?.sauce.fontName || "IBM VGA",
    palette, fontBytes,
  };
}

export interface XbinExportOptions {
  iceColors: boolean;
  /** written into the file when given */
  palette?: readonly Rgb[];
  /** raw 8-wide font, height = length / 256, written into the file when given */
  fontBytes?: Uint8Array;
  compress?: boolean;
  sauce?: Sauce | false;
}

/** Runs of identical cells become one repeat packet; everything else is literal. Runs stay within a row. */
function compressRow(row: Uint8Array, out: number[]): void {
  const n = row.length >> 1;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 64 && row[(i + run) * 2] === row[i * 2] && row[(i + run) * 2 + 1] === row[i * 2 + 1]) run++;
    if (run >= 2) {
      out.push(0xc0 | (run - 1), row[i * 2], row[i * 2 + 1]);
      i += run;
      continue;
    }
    const start = i;
    while (i < n && i - start < 64) {
      const next = i + 1 < n && row[(i + 1) * 2] === row[i * 2] && row[(i + 1) * 2 + 1] === row[i * 2 + 1];
      if (next) break;
      i++;
    }
    if (i === start) i++;
    out.push(i - start - 1);
    for (let k = start * 2; k < i * 2; k++) out.push(row[k]);
  }
}

export function encodeXbin(grid: CellGrid, opts: XbinExportOptions): Uint8Array {
  const fontHeight = opts.fontBytes ? opts.fontBytes.length / 256 : 16;
  if (!Number.isInteger(fontHeight) || fontHeight < 1 || fontHeight > 32) throw new Error("bad XBIN font size");
  const compress = opts.compress ?? true;
  const out: number[] = [0x58, 0x42, 0x49, 0x4e, 0x1a,
    grid.width & 255, grid.width >> 8, grid.height & 255, grid.height >> 8, fontHeight,
    (opts.palette ? FLAG_PALETTE : 0) | (opts.fontBytes ? FLAG_FONT : 0)
      | (compress ? FLAG_COMPRESS : 0) | (opts.iceColors ? FLAG_NONBLINK : 0)];
  if (opts.palette) for (let i = 0; i < 16; i++) for (let k = 0; k < 3; k++) out.push(opts.palette[i][k] >> 2);
  if (opts.fontBytes) for (const b of opts.fontBytes) out.push(b);
  const pairs = pairsFromCells(grid, opts.palette);
  if (compress) {
    const stride = grid.width * 2;
    for (let y = 0; y < grid.height; y++) compressRow(pairs.subarray(y * stride, (y + 1) * stride), out);
  } else {
    for (const b of pairs) out.push(b);
  }
  const data = Uint8Array.from(out);
  if (opts.sauce === false) return data;
  const tail = encodeSauce({
    ...(opts.sauce ?? { title: "", author: "", group: "", date: "", comments: [] }),
    fileSize: data.length,
    dataType: SAUCE_DATATYPE_XBIN, fileType: 0,
    tinfo1: grid.width, tinfo2: grid.height, tinfo3: 0, tinfo4: 0,
    flags: 0, fontName: "",
  });
  const file = new Uint8Array(data.length + tail.length);
  file.set(data);
  file.set(tail, data.length);
  return file;
}
