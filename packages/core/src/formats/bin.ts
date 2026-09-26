import { type Rgb, VGA_PALETTE, nearestIndex } from "../color.js";
import { CH_ALL, CellGrid } from "../grid.js";
import type { ImportedArt } from "./ansi.js";
import {
  SAUCE_DATATYPE_BINARYTEXT, SAUCE_FLAG_8PX, SAUCE_FLAG_9PX, SAUCE_FLAG_ICE, SAUCE_MASK_SPACING,
  type AspectRatio, aspectFromFlags, aspectToFlags,
  type Sauce, encodeSauce, parseSauce,
} from "./sauce.js";

/** Read character/attribute pairs into a fully-present grid. */
export function cellsFromPairs(data: Uint8Array, width: number, height: number): CellGrid {
  const grid = new CellGrid(width, height);
  const n = Math.min(width * height, data.length >> 1);
  for (let i = 0; i < n; i++) {
    grid.glyph[i] = data[i * 2];
    grid.fg[i] = data[i * 2 + 1] & 15;
    grid.bg[i] = data[i * 2 + 1] >> 4;
  }
  grid.glyph.fill(32, n);
  grid.fg.fill(7, n);
  grid.present.fill(CH_ALL);
  return grid;
}

/** Character/attribute pairs; 24-bit colours fall to the nearest palette entry. */
export function pairsFromCells(grid: CellGrid, palette: readonly Rgb[] = VGA_PALETTE): Uint8Array {
  const out = new Uint8Array(grid.width * grid.height * 2);
  for (let i = 0; i < grid.width * grid.height; i++) {
    const p = grid.present[i];
    out[i * 2] = p & 1 ? grid.glyph[i] : 32;
    const fg = p & 2 ? nearestIndex(grid.fg[i], palette) : 7;
    const bg = p & 4 ? nearestIndex(grid.bg[i], palette) : 0;
    out[i * 2 + 1] = (bg << 4) | fg;
  }
  return out;
}

/** Binary Text (.BIN). Width is SAUCE FileType * 2, else 160. */
export function parseBin(bytes: Uint8Array, opts: { width?: number } = {}): ImportedArt {
  const found = parseSauce(bytes);
  const sauce = found?.sauce ?? null;
  const end = found ? found.dataLength : bytes.length;
  const isBin = sauce?.dataType === SAUCE_DATATYPE_BINARYTEXT;
  const width = opts.width ?? (isBin && sauce!.fileType > 0 ? sauce!.fileType * 2 : 160);
  const height = Math.max(1, Math.ceil(end / 2 / width));
  const flags = sauce?.flags ?? 0;
  return {
    grid: cellsFromPairs(bytes.subarray(0, end), width, height),
    sauce,
    iceColors: (flags & SAUCE_FLAG_ICE) !== 0,
    letterSpacing9px: (flags & SAUCE_MASK_SPACING) === SAUCE_FLAG_9PX,
    aspectRatio: aspectFromFlags(flags),
    fontName: sauce?.fontName || "IBM VGA",
  };
}

export interface BinExportOptions {
  iceColors: boolean;
  palette?: readonly Rgb[];
  sauce?: Sauce | false;
  fontName?: string;
  letterSpacing9px?: boolean;
  aspectRatio?: AspectRatio;
}

export function encodeBin(grid: CellGrid, opts: BinExportOptions): Uint8Array {
  if (grid.width % 2 || grid.width > 510) throw new Error(".BIN needs an even width of at most 510 columns");
  const data = pairsFromCells(grid, opts.palette);
  if (opts.sauce === false) return data;
  const tail = encodeSauce({
    ...(opts.sauce ?? { title: "", author: "", group: "", date: "", comments: [] }),
    fileSize: data.length,
    dataType: SAUCE_DATATYPE_BINARYTEXT,
    fileType: grid.width / 2,
    tinfo1: 0, tinfo2: 0, tinfo3: 0, tinfo4: 0,
    flags: (opts.iceColors ? SAUCE_FLAG_ICE : 0) | (opts.letterSpacing9px ? SAUCE_FLAG_9PX : SAUCE_FLAG_8PX)
      | aspectToFlags(opts.aspectRatio ?? "none"),
    fontName: opts.fontName ?? "IBM VGA",
  });
  const file = new Uint8Array(data.length + tail.length);
  file.set(data);
  file.set(tail, data.length);
  return file;
}
