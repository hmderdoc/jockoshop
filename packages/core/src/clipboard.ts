/**
 * A copied block of cells in each clipboard format that matters:
 *
 * - ours (`KD_CLIP_TYPE`): every channel, absent ones included, 24-bit colour, and where it was
 *   copied from, so a paste lands in place — between our own windows nothing is lost;
 * - Moebius: `electron.clipboard.write({text, html: JSON.stringify(blocks)})`, where blocks is
 *   `{columns, rows, data: [{code, fg, bg}]}` with palette indices (app/document/tools/clipboard.js);
 * - PabloDraw: a "pablo" type holding width and height (little-endian int32) and then the cells
 *   as a TundraDraw body, colours as RGB (Actions/Block/CopyToClipboard.cs);
 * - text: the glyphs as Unicode, lines joined by CRLF, which is what both of them write too.
 *
 * Reading prefers them in that order. Nothing here touches a clipboard: the
 * app moves the bytes, these only encode and decode them.
 */
import { type Color, type Rgb, VGA_PALETTE, isRgb, nearestIndex, rgb, toRgb } from "./color.js";
import { CP437_UNICODE, cp437Encode } from "./cp437.js";
import { CH_ALL, CH_FG, CH_GLYPH, CellGrid } from "./grid.js";
import { encodeTundra, parseTundra } from "./formats/tundra.js";

export const KD_CLIP_TYPE = "org.hmderdoc.jockoshop.cells";
export const PABLO_CLIP_TYPE = "pablo";

/** Cells and the document position they were copied from (absent for clips from other programs). */
export interface ClipCells {
  grid: CellGrid;
  x?: number;
  y?: number;
}

/** What the system clipboard is given, and what it hands back. */
export interface ClipPayload {
  text?: string;
  html?: string;
  custom?: Record<string, Uint8Array>;
}

const MAGIC = [0x4b, 0x44, 0x43, 0x4c];   // "KDCL"
const VERSION = 1;
const HEAD = 4 + 1 + 16;

/** Every representation of `clip`, for one clipboard write. */
export function encodeClip(clip: ClipCells, palette: readonly Rgb[] = VGA_PALETTE): ClipPayload {
  return {
    text: clipText(clip.grid),
    html: encodeMoebiusHtml(clip.grid, palette),
    custom: { [KD_CLIP_TYPE]: encodeKdClip(clip), [PABLO_CLIP_TYPE]: encodePabloClip(clip.grid, palette) },
  };
}

/**
 * The best of what is on the clipboard, or null when none of it is art or text.
 * `fg` colours pasted plain text.
 */
export function decodeClip(p: ClipPayload, palette: readonly Rgb[] = VGA_PALETTE, fg: Color = 7): ClipCells | null {
  const ours = p.custom?.[KD_CLIP_TYPE];
  if (ours) { const c = decodeKdClip(ours); if (c) return c; }
  const pablo = p.custom?.[PABLO_CLIP_TYPE];
  if (pablo) { const g = decodePabloClip(pablo, palette); if (g) return { grid: g }; }
  if (p.html) { const g = decodeMoebiusHtml(p.html); if (g) return { grid: g }; }
  if (p.text) { const g = decodeClipText(p.text, fg); if (g) return { grid: g }; }
  return null;
}

// ---- ours ----

/** "KDCL", version, x, y (int32), width, height (uint32), then glyph, present, fg, bg arrays; little-endian. */
export function encodeKdClip(clip: ClipCells): Uint8Array {
  const g = clip.grid, n = g.width * g.height;
  const out = new Uint8Array(HEAD + n * 10);
  const v = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  v.setInt32(5, clip.x ?? 0, true);
  v.setInt32(9, clip.y ?? 0, true);
  v.setUint32(13, g.width, true);
  v.setUint32(17, g.height, true);
  out.set(g.glyph, HEAD);
  out.set(g.present, HEAD + n);
  for (let i = 0; i < n; i++) {
    v.setUint32(HEAD + 2 * n + i * 4, g.fg[i], true);
    v.setUint32(HEAD + 6 * n + i * 4, g.bg[i], true);
  }
  return out;
}

export function decodeKdClip(bytes: Uint8Array): ClipCells | null {
  if (bytes.length < HEAD || MAGIC.some((b, i) => bytes[i] !== b) || bytes[4] !== VERSION) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = v.getUint32(13, true), h = v.getUint32(17, true), n = w * h;
  if (bytes.length !== HEAD + n * 10) return null;
  const g = new CellGrid(w, h);
  g.glyph.set(bytes.subarray(HEAD, HEAD + n));
  g.present.set(bytes.subarray(HEAD + n, HEAD + 2 * n));
  for (let i = 0; i < n; i++) {
    g.fg[i] = v.getUint32(HEAD + 2 * n + i * 4, true);
    g.bg[i] = v.getUint32(HEAD + 6 * n + i * 4, true);
  }
  return { grid: g, x: v.getInt32(5, true), y: v.getInt32(9, true) };
}

// ---- Moebius ----

interface MoebiusBlock { code: number; fg: number; bg: number; fg_rgb?: { r: number; g: number; b: number }; bg_rgb?: { r: number; g: number; b: number } }

/**
 * Moebius's blocks. Its paste keeps only the palette indices (`doc.place` → `change_data(code, fg, bg)`),
 * so 24-bit colours go as the nearest of the sixteen; the exact colour rides along as `fg_rgb` /
 * `bg_rgb`, the fields its own cells use for it. An absent cell is a black space, as in Moebius.
 *
 * The leading tag is what Electron writes on a Mac, and Moebius's reader strips one.
 */
export function encodeMoebiusHtml(grid: CellGrid, palette: readonly Rgb[] = VGA_PALETTE): string {
  const data: MoebiusBlock[] = [];
  const exact = (c: Color) => { const [r, g, b] = toRgb(c, palette); return { r, g, b }; };
  for (let i = 0; i < grid.width * grid.height; i++) {
    const p = grid.present[i];
    const fg = p & 2 ? grid.fg[i] : 7, bg = p & 4 ? grid.bg[i] : 0;
    const block: MoebiusBlock = { code: p & 1 ? grid.glyph[i] : 32, fg: nearestIndex(fg, palette), bg: nearestIndex(bg, palette) };
    if (isRgb(fg)) block.fg_rgb = exact(fg);
    if (isRgb(bg)) block.bg_rgb = exact(bg);
    data.push(block);
  }
  return `<meta charset='utf-8'>${JSON.stringify({ columns: grid.width, rows: grid.height, data })}`;
}

/** Moebius's blocks out of the HTML slot, or null if that is not what it holds. */
export function decodeMoebiusHtml(html: string): CellGrid | null {
  const start = html.indexOf("{"), end = html.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let blocks: { columns?: unknown; rows?: unknown; data?: unknown };
  try { blocks = JSON.parse(html.slice(start, end + 1)); } catch { return null; }
  const { columns: w, rows: h, data } = blocks;
  if (typeof w !== "number" || typeof h !== "number" || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return null;
  if (!Array.isArray(data) || data.length !== w * h) return null;
  const g = new CellGrid(w, h);
  const colour = (index: unknown, exact: unknown): Color => {
    const e = exact as { r?: unknown; g?: unknown; b?: unknown } | undefined;
    if (e && typeof e.r === "number" && typeof e.g === "number" && typeof e.b === "number") return rgb(e.r, e.g, e.b);
    return typeof index === "number" ? index & 15 : 0;
  };
  for (let i = 0; i < data.length; i++) {
    const b = (data[i] ?? {}) as Record<string, unknown>;
    g.glyph[i] = typeof b.code === "number" ? b.code & 255 : 32;
    g.fg[i] = colour(b.fg, b.fg_rgb);
    g.bg[i] = colour(b.bg, b.bg_rgb);
    g.present[i] = CH_ALL;
  }
  return g;
}

// ---- PabloDraw ----

/**
 * PabloDraw's clipboard: its TundraDraw writer without the file header. Glyphs 1-6
 * are commands in that format and go as spaces; black spaces are left out, which
 * PabloDraw reads back as its default cell — a black space.
 */
export function encodePabloClip(grid: CellGrid, palette: readonly Rgb[] = VGA_PALETTE): Uint8Array {
  const body = encodeTundra(grid, palette).subarray(9);
  const out = new Uint8Array(8 + body.length);
  const v = new DataView(out.buffer);
  v.setInt32(0, grid.width, true);
  v.setInt32(4, grid.height, true);
  out.set(body, 8);
  return out;
}

/** Colours equal to one of the document's sixteen come back as that palette entry, so palette tools still apply. */
export function decodePabloClip(bytes: Uint8Array, palette: readonly Rgb[] = VGA_PALETTE): CellGrid | null {
  if (bytes.length < 8) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = v.getInt32(0, true), h = v.getInt32(4, true);
  if (w < 1 || h < 1 || w > 4096 || h > 65536) return null;
  const file = new Uint8Array(9 + bytes.length - 8);
  file.set([24, ...Array.from("TUNDRA24", (c) => c.charCodeAt(0))]);
  file.set(bytes.subarray(8), 9);
  const art = parseTundra(file, { width: w });
  const g = CellGrid.filled(w, h, 32, 7, 0);
  const index = (c: Color): Color => {
    const [r, gr, b] = toRgb(c);
    for (let i = 0; i < 16; i++) { const p = palette[i]; if (p[0] === r && p[1] === gr && p[2] === b) return i; }
    return c;
  };
  for (let y = 0; y < Math.min(h, art.grid.height); y++) {
    for (let x = 0; x < w; x++) {
      const s = art.grid.index(x, y), d = g.index(x, y);
      g.glyph[d] = art.grid.glyph[s]; g.fg[d] = index(art.grid.fg[s]); g.bg[d] = index(art.grid.bg[s]);
    }
  }
  return g;
}

// ---- text ----

/** The glyphs as Unicode, CRLF between lines and none after the last, as Moebius writes it. */
export function clipText(grid: CellGrid): string {
  const lines: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    let line = "";
    for (let x = 0; x < grid.width; x++) {
      const i = grid.index(x, y), c = grid.present[i] & 1 ? grid.glyph[i] : 32;
      line += String.fromCodePoint(CP437_UNICODE[c === 0 ? 32 : c]);
    }
    lines.push(line);
  }
  return lines.join("\r\n");
}

/**
 * Text as cells: each character in `fg` with no background of its own, and
 * spaces left absent, so typed-out text lies over whatever is below it.
 */
export function decodeClipText(text: string, fg: Color = 7): CellGrid | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => cp437Encode(l.replace(/\t/g, "    ")));
  const w = Math.max(0, ...lines.map((l) => l.length));
  if (!w) return null;
  const g = new CellGrid(w, lines.length);
  lines.forEach((l, y) => l.forEach((c, x) => {
    if (c === 32) return;
    const i = g.index(x, y);
    g.glyph[i] = c; g.fg[i] = fg; g.present[i] = CH_GLYPH | CH_FG;
  }));
  return g;
}
