/**
 * Prose layers: word-processor text laid out in a frame of cells, flowing
 * around whatever other layers occupy inside it.
 *
 * Model (from HERMedIT): paragraphs are separated by "\n"; wrapping is greedy
 * at spaces; a wrap consumes the space it breaks at; a word wider than the
 * space it lands in is broken. Each character carries its own colours.
 *
 * Layout works on *spans*: for every row of the frame, the free runs of cells
 * (everything, or the gaps between obstacles at least `minGap` wide). Text
 * fills spans left to right, top to bottom; a paragraph break moves to the
 * next row's first span. `before[i]` is where the caret sits before character
 * i (and before[text.length] after the last), so the caret can be shown and
 * clicks and arrow keys can be mapped back to the text.
 */
import { composite } from "./composite.js";
import { type KdDocument, type ProseLayer, newLayerId } from "./document.js";
import type { GlyphInfo } from "./glyphs.js";
import { CellGrid } from "./grid.js";

export interface ProseLayout {
  /** cell index in the frame of each character, -1 if not shown (a consumed wrap space, a break, or overflow) */
  place: Int32Array;
  /** caret cell before each character; length text.length + 1 */
  before: Int32Array;
  /** characters that did not fit in the frame */
  overflow: number;
}

export function createProseLayer(name: string, width: number, height: number, text = ""): ProseLayer {
  return {
    type: "prose", id: newLayerId(), name, visible: true, locked: false, x: 0, y: 0, keys: [],
    text, fg: Array.from(text, () => 7), bg: Array.from(text, () => -1),
    width, height, flowAround: true, minGap: 3, align: "left",
  };
}

/** The free spans of one row: [start, end) pairs. */
function rowSpans(blocked: Uint8Array | undefined, width: number, y: number, minGap: number): [number, number][] {
  if (!blocked) return [[0, width]];
  const out: [number, number][] = [];
  let x = 0;
  while (x < width) {
    while (x < width && blocked[y * width + x]) x++;
    const start = x;
    while (x < width && !blocked[y * width + x]) x++;
    if (x - start >= Math.max(1, minGap)) out.push([start, x]);
  }
  return out;
}

export function layoutProse(layer: ProseLayer, blocked?: Uint8Array): ProseLayout {
  const { text, width, height, minGap, align } = layer;
  const n = text.length;
  const place = new Int32Array(n).fill(-1), before = new Int32Array(n + 1).fill(-1);
  const spans: [number, number][][] = [];
  for (let y = 0; y < height; y++) spans.push(rowSpans(blocked, width, y, minGap));

  let y = 0, si = 0;                     // current row and span within it
  let lineStart = 0, x = 0;              // the span's start column and the write column
  const lineChars: number[] = [];        // indices placed on the current span line, for alignment
  let overflow = 0;
  const curSpan = (): [number, number] | null => spans[y]?.[si] ?? null;
  /** to the next span that exists; false when the frame is full */
  const nextSpan = (newRow: boolean): boolean => {
    finishLine();
    if (!newRow && spans[y] && si + 1 < spans[y].length) si++;
    else { y++; si = 0; while (y < height && !spans[y].length) y++; }
    if (y >= height) return false;
    lineStart = x = spans[y][si][0];
    return true;
  };
  function finishLine(): void {
    const span = curSpan();
    if (span && align !== "left" && lineChars.length) {
      const used = x - lineStart, shift = align === "center" ? Math.floor((span[1] - span[0] - used) / 2) : span[1] - span[0] - used;
      if (shift > 0) for (const i of lineChars) { place[i] += shift; before[i] += shift; }
    }
    lineChars.length = 0;
  }
  const first = (): boolean => { y = -1; return nextSpan(true); };
  let ok = first();

  let i = 0;
  while (i < n) {
    if (!ok) { before[i] = -1; overflow++; i++; continue; }
    const ch = text[i];
    const span = curSpan()!;
    if (ch === "\n") {
      before[i] = y * width + x;
      i++;
      ok = nextSpan(true);
      continue;
    }
    if (ch === " ") {
      if (x >= span[1]) { before[i] = y * width + x; i++; ok = nextSpan(false); continue; }   // a space at the edge is consumed by the wrap
      before[i] = place[i] = y * width + x;
      lineChars.push(i);
      x++; i++;
      continue;
    }
    // a word: fit it whole if it can go on this or a later span, else break it
    let end = i;
    while (end < n && text[end] !== " " && text[end] !== "\n") end++;
    const len = end - i, room = span[1] - x;
    if (len > room) {
      if (x > lineStart || len > span[1] - span[0]) {
        if (x === lineStart) {   // a word wider than the whole span: break it here
          for (let k = 0; k < room && i < end; k++, i++) { before[i] = place[i] = y * width + x; lineChars.push(i); x++; }
          ok = nextSpan(false);
          continue;
        }
        ok = nextSpan(false);
        continue;
      }
    }
    for (; i < end; i++) { before[i] = place[i] = y * width + x; lineChars.push(i); x++; }
    if (x >= span[1] && i < n && text[i] !== "\n" && text[i] !== " ") ok = nextSpan(false);
  }
  if (ok) { finishLine(); before[n] = y * width + Math.min(x, width - 1) + (x >= width ? 0 : 0); }
  else before[n] = -1;
  // fix up: after a consumed edge space or a wrap the caret should sit at the start of the next line
  for (let k = 0; k < n; k++) if (before[k] < 0 && k < n - overflow) before[k] = before[k + 1] >= 0 ? before[k + 1] : before[k];
  return { place, before, overflow };
}

export function renderProse(layer: ProseLayer, layout: ProseLayout): CellGrid {
  const grid = new CellGrid(Math.max(1, layer.width), Math.max(1, layer.height));
  for (let i = 0; i < layer.text.length; i++) {
    const at = layout.place[i];
    if (at < 0) continue;
    const ch = layer.text.charCodeAt(i) & 255, bg = layer.bg[i];
    if (ch === 32 && bg < 0) continue;   // a see-through space is nothing
    grid.setAt(at, { glyph: ch, fg: layer.fg[i], ...(bg >= 0 ? { bg } : {}) });
  }
  return grid;
}

/**
 * Cells inside the frame that other visible layers already draw on — the
 * obstacles the text flows around. Computed by compositing without this layer.
 */
export function proseObstacles(doc: KdDocument, layer: ProseLayer, glyphs?: GlyphInfo): Uint8Array | undefined {
  if (!layer.flowAround) return undefined;
  const was = layer.visible;
  layer.visible = false;
  try {
    const comp = composite(doc, { glyphs });
    const out = new Uint8Array(layer.width * layer.height);
    for (let y = 0; y < layer.height; y++) {
      for (let x = 0; x < layer.width; x++) {
        const dx = x + layer.x, dy = y + layer.y;
        if (dx < 0 || dy < 0 || dx >= doc.width || dy >= doc.height) { out[y * layer.width + x] = 1; continue; }
        if (comp.owner[dy * doc.width + dx] >= 0) out[y * layer.width + x] = 1;
      }
    }
    return out;
  } finally { layer.visible = was; }
}

/** Regenerate the layer's cells; returns the layout for caret work. */
export function refreshProseLayer(doc: KdDocument, layer: ProseLayer, glyphs?: GlyphInfo): ProseLayout {
  const layout = layoutProse(layer, proseObstacles(doc, layer, glyphs));
  layer.cache = renderProse(layer, layout);
  return layout;
}

// ---------------------------------------------------------------- editing

export function insertText(layer: ProseLayer, at: number, str: string, fg: number, bg: number): number {
  const chars = [...str.replace(/\r\n?/g, "\n")].map((c) => (c.codePointAt(0)! > 255 ? "?" : c)).join("");
  layer.text = layer.text.slice(0, at) + chars + layer.text.slice(at);
  layer.fg.splice(at, 0, ...Array.from(chars, () => fg));
  layer.bg.splice(at, 0, ...Array.from(chars, () => bg));
  return at + chars.length;
}

export function deleteText(layer: ProseLayer, from: number, to: number): void {
  if (to <= from) return;
  layer.text = layer.text.slice(0, from) + layer.text.slice(to);
  layer.fg.splice(from, to - from);
  layer.bg.splice(from, to - from);
}

/** The character index whose caret position is nearest a frame cell (x, y); clicks and arrow keys use it. */
export function proseIndexAt(layer: ProseLayer, layout: ProseLayout, x: number, y: number): number {
  let best = layer.text.length, bestD = Infinity;
  for (let i = 0; i <= layer.text.length; i++) {
    const at = layout.before[i];
    if (at < 0) continue;
    const cx = at % layer.width, cy = Math.floor(at / layer.width);
    const d = Math.abs(cy - y) * 1000 + Math.abs(cx - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Frame cell of the caret before character `index`, or null when that text did not fit. */
export function proseCaretCell(layer: ProseLayer, layout: ProseLayout, index: number): { x: number; y: number } | null {
  const at = layout.before[Math.max(0, Math.min(layer.text.length, index))];
  return at < 0 ? null : { x: at % layer.width, y: Math.floor(at / layer.width) };
}
