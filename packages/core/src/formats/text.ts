/** Plain text: the characters only. CP437 bytes, or UTF-8 with the CP437 glyphs mapped to Unicode. */
import { CP437_UNICODE } from "../cp437.js";
import type { CellGrid } from "../grid.js";

export function encodeText(grid: CellGrid, encoding: "cp437" | "utf8"): Uint8Array {
  const lines: string[] = [];
  for (let y = 0; y < grid.height; y++) {
    let line = "";
    for (let x = 0; x < grid.width; x++) {
      const i = grid.index(x, y), g = grid.present[i] & 1 ? grid.glyph[i] : 32;
      line += encoding === "utf8" ? String.fromCodePoint(CP437_UNICODE[g === 0 ? 32 : g]) : String.fromCharCode(g === 0 ? 32 : g);
    }
    lines.push(line.replace(/[  ]+$/, ""));
  }
  const text = lines.join("\r\n") + "\r\n";
  if (encoding !== "utf8") return Uint8Array.from(text, (c) => c.charCodeAt(0) & 255);
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}
