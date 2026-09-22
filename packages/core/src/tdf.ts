/**
 * TheDraw fonts (.tdf): parser, mixed-font word-wrapped layout, and rendering
 * into a CellGrid. Layout logic ported from HERMedIT's tdf.ts; differences:
 * works on bytes, reads every font in a multi-font file, and renders cells the
 * font never wrote as absent instead of as black spaces.
 */
import type { Color } from "./color.js";
import { CellGrid } from "./grid.js";

export const TDF_OUTLINE = 0, TDF_BLOCK = 1, TDF_COLOR = 2;

const NUM_CHARS = 94;   // '!' .. '~'
const MAGIC = "\x13TheDraw FONTS file\x1a";
const RECORD_HEADER = 213;

/** Outline-font placeholder letters -> CP437 line drawing (TheDraw's default outline style). */
const OUTLINE_SUB: Record<number, number> = {
  65: 205, 66: 196, 67: 179, 68: 186, 69: 213, 70: 187, 71: 214, 72: 191,
  73: 200, 74: 190, 75: 192, 76: 189, 77: 181, 78: 199, 79: 32, 64: 32,
};

export interface TdfGlyph {
  width: number;
  height: number;
  /** width * font.height entries, row-major; 0 = nothing written there */
  chars: Uint8Array;
  /** CGA attribute per cell (colour fonts only) */
  attrs: Uint8Array;
}

export interface TdfFont {
  name: string;
  type: number;
  spacing: number;
  height: number;
  glyphs: (TdfGlyph | null)[];
}

export function tdfTypeName(type: number): string {
  return type === TDF_OUTLINE ? "Outline" : type === TDF_BLOCK ? "Block" : type === TDF_COLOR ? "Color" : "Unknown";
}

/** Every font in the file, in order. Throws if the file is not a TheDraw font file. */
export function parseTdf(bytes: Uint8Array): TdfFont[] {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error("not a TheDraw font file");
  const fonts: TdfFont[] = [];
  let base = MAGIC.length;
  while (base + RECORD_HEADER <= bytes.length) {
    if (bytes[base] !== 0x55 || bytes[base + 1] !== 0xaa || bytes[base + 2] !== 0x00 || bytes[base + 3] !== 0xff) break;
    const nameLen = Math.min(12, bytes[base + 4]);
    let name = "";
    for (let i = 0; i < nameLen && bytes[base + 5 + i]; i++) name += String.fromCharCode(bytes[base + 5 + i]);
    const type = bytes[base + 21], spacing = bytes[base + 22];
    const blockSize = bytes[base + 23] | (bytes[base + 24] << 8);
    const dataAt = base + RECORD_HEADER;
    const data = bytes.subarray(dataAt, Math.min(bytes.length, dataAt + blockSize));
    const offsets: number[] = [];
    for (let c = 0; c < NUM_CHARS; c++) offsets.push(bytes[base + 25 + c * 2] | (bytes[base + 26 + c * 2] << 8));

    let height = 0;
    for (const off of offsets) if (off !== 0xffff && off + 1 < data.length) height = Math.max(height, data[off + 1]);
    const font: TdfFont = { name: name.trim(), type, spacing, height, glyphs: [] };
    for (const off of offsets) font.glyphs.push(off === 0xffff || off + 1 >= data.length ? null : parseGlyph(data, off, font));
    fonts.push(font);
    base = dataAt + blockSize;
  }
  if (!fonts.length) throw new Error("TheDraw font file contains no fonts");
  return fonts;
}

function parseGlyph(data: Uint8Array, off: number, font: TdfFont): TdfGlyph {
  const width = data[off];
  const glyph: TdfGlyph = {
    width, height: data[off + 1],
    chars: new Uint8Array(width * font.height), attrs: new Uint8Array(width * font.height),
  };
  let p = off + 2, row = 0, col = 0;
  while (p < data.length && data[p] !== 0) {
    let ch = data[p++];
    if (ch === 0x0d) { row++; col = 0; continue; }
    let attr = 7;
    if (font.type === TDF_COLOR) { if (p >= data.length) break; attr = data[p++]; }
    if (font.type === TDF_OUTLINE && OUTLINE_SUB[ch] !== undefined) ch = OUTLINE_SUB[ch];
    if (ch < 0x20) ch = 0x20;
    if (col < width && row < font.height) {
      glyph.chars[row * width + col] = ch;
      glyph.attrs[row * width + col] = attr;
    }
    col++;
  }
  return glyph;
}

function glyphFor(font: TdfFont, ch: string): TdfGlyph | null {
  const pick = (code: number): TdfGlyph | null => (code >= 33 && code <= 126 ? font.glyphs[code - 33] : null);
  return pick(ch.charCodeAt(0)) ?? pick(ch.toUpperCase().charCodeAt(0)) ?? pick(ch.toLowerCase().charCodeAt(0));
}

/** Characters this font can draw (after case fallback). */
export function tdfHasChar(font: TdfFont, ch: string): boolean {
  return ch === " " || glyphFor(font, ch) !== null;
}

/** One character of laid-out text: `font` styles `ch`. */
export interface StyledChar {
  ch: string;
  font: TdfFont;
}

export interface TdfLine {
  /** index into the styled text of this line's first character */
  start: number;
  /** one past its last character (a space consumed by wrapping is not included) */
  end: number;
  /** x of each character, relative to the block */
  xs: number[];
  width: number;
  height: number;
  y: number;
}

export interface TdfLayout {
  lines: TdfLine[];
  width: number;
  height: number;
}

export interface TdfMetrics {
  /** blank rows between lines */
  lineGap: number;
  /** added to each font's own letter spacing */
  extraSpacing: number;
  /** cells a space (or a character the font lacks) occupies; HERMedIT uses 1 */
  spaceWidth: number;
}

function advance(c: StyledChar, m: TdfMetrics): number {
  const g = c.ch === " " ? null : glyphFor(c.font, c.ch);
  return g ? g.width : m.spaceWidth;
}

function measure(text: StyledChar[], from: number, to: number, m: TdfMetrics): number {
  let w = 0;
  for (let i = from; i < to; i++) w += advance(text[i], m) + (i < to - 1 ? text[i].font.spacing + m.extraSpacing : 0);
  return w;
}

/**
 * Word-wrap styled text into lines no wider than `maxWidth` cells (Infinity =
 * never wrap). '\n' is a hard break. Lines are as tall as their tallest font,
 * with glyphs bottom-aligned so mixed sizes share a baseline. A word wider
 * than maxWidth is placed anyway.
 */
export function layoutTdf(text: StyledChar[], maxWidth: number, m: TdfMetrics, defaultFont: TdfFont): TdfLayout {
  const lines: TdfLine[] = [];
  const pushLine = (start: number, end: number): void => {
    const xs: number[] = [];
    let x = 0, height = 0;
    for (let i = start; i < end; i++) {
      xs.push(x);
      x += advance(text[i], m) + (i < end - 1 ? text[i].font.spacing + m.extraSpacing : 0);
      height = Math.max(height, text[i].font.height);
    }
    if (!height) height = (text[start] ?? text[start - 1])?.font.height ?? defaultFont.height;
    lines.push({ start, end, xs, width: x, height, y: 0 });
  };

  let paraStart = 0;
  for (;;) {
    let paraEnd = paraStart;
    while (paraEnd < text.length && text[paraEnd].ch !== "\n") paraEnd++;
    let lineStart = paraStart, lineEnd = paraStart, pos = paraStart;
    while (pos < paraEnd) {
      let wordEnd = pos;
      while (wordEnd < paraEnd && text[wordEnd].ch !== " ") wordEnd++;
      if (lineEnd > lineStart && measure(text, lineStart, wordEnd, m) > maxWidth) {
        pushLine(lineStart, lineEnd);
        lineStart = pos;
      }
      lineEnd = wordEnd;
      pos = wordEnd < paraEnd ? wordEnd + 1 : paraEnd;
    }
    pushLine(lineStart, lineEnd);
    if (paraEnd >= text.length) break;
    paraStart = paraEnd + 1;
  }

  let y = 0, width = 0;
  for (const ln of lines) { ln.y = y; y += ln.height + m.lineGap; width = Math.max(width, ln.width); }
  return { lines, width, height: Math.max(1, y - m.lineGap) };
}

export interface TdfRenderStyle {
  /** ink for outline and block fonts, which carry no colour of their own */
  fg: Color;
  /** background behind written cells; null leaves it absent so lower layers show through */
  bg: Color | null;
}

/**
 * Draw a layout into a new grid. Cells a glyph never wrote are absent. Colour
 * fonts keep their own colours; with `bg: null` their black backgrounds are
 * left absent too, and a space over black becomes no cell at all.
 */
export function renderTdf(text: StyledChar[], layout: TdfLayout, style: TdfRenderStyle): CellGrid {
  const grid = new CellGrid(Math.max(1, layout.width), layout.height);
  for (const ln of layout.lines) {
    for (let i = ln.start; i < ln.end; i++) {
      const c = text[i];
      const g = c.ch === " " ? null : glyphFor(c.font, c.ch);
      if (!g) continue;
      const x0 = ln.xs[i - ln.start], y0 = ln.y + ln.height - c.font.height;
      for (let gy = 0; gy < c.font.height; gy++) {
        for (let gx = 0; gx < g.width; gx++) {
          const ch = g.chars[gy * g.width + gx];
          if (!ch) continue;
          const x = x0 + gx, y = y0 + gy;
          if (!grid.inBounds(x, y)) continue;
          if (c.font.type === TDF_COLOR) {
            const attr = g.attrs[gy * g.width + gx], bg = attr >> 4;
            if (style.bg === null && bg === 0) {
              if (ch !== 0x20) grid.set(x, y, { glyph: ch, fg: attr & 15 });
            } else grid.set(x, y, { glyph: ch, fg: attr & 15, bg });
          } else if (style.bg === null) {
            if (ch !== 0x20) grid.set(x, y, { glyph: ch, fg: style.fg });
          } else grid.set(x, y, { glyph: ch, fg: style.fg, bg: style.bg });
        }
      }
    }
  }
  return grid;
}
