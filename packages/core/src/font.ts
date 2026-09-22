/** Raw 8-pixel-wide bitmap font, 256 glyphs, one byte per row (the .f16/.f08 layout). */
export interface BitmapFont {
  readonly width: 8;
  readonly height: number;
  readonly glyphs: Uint8Array;
}

export function parseRawFont(bytes: Uint8Array): BitmapFont {
  if (bytes.length === 0 || bytes.length % 256 !== 0) {
    throw new Error(`raw font must be a multiple of 256 bytes, got ${bytes.length}`);
  }
  return { width: 8, height: bytes.length / 256, glyphs: bytes };
}

export function glyphRow(font: BitmapFont, code: number, y: number): number {
  return font.glyphs[code * font.height + y];
}

export function pixelIsFg(font: BitmapFont, code: number, x: number, y: number): boolean {
  return ((glyphRow(font, code, y) >> (7 - x)) & 1) === 1;
}
