/**
 * The ASCII converters side by side, on real pictures.
 *
 * Not assertions — `contour.test.ts` and `ascii-match.test.ts` do that. This is
 * for looking at the result, which is the only way to judge a converter: the
 * contour mode was wrong twice in ways no error metric would have caught (it
 * traced every speck of photograph grain, then it broke the lines into dashes)
 * and both were obvious in a render.
 *
 * Off unless PROTO_RENDER names a directory holding `images.png`, `images-1.png`
 * and `shopping.png`. It writes a PNG and a .txt per source per converter:
 *   PROTO_RENDER=/some/dir npx vitest run packages/core/test/ascii-contour.proto.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { it } from "vitest";
import {
  VGA_PALETTE, adjustSource, contourAscii, createRaster, encodePng, isLowAscii, matchImageToFont, parseRawFont, renderGrid,
} from "../src/index.js";
import type { CellGrid } from "../src/grid.js";

const font = parseRawFont(new Uint8Array(readFileSync("packages/core/assets/ibmstd.f16")));

/** Minimal PNG reader: 8-bit grey, RGB or RGBA, no interlace — enough for `sips` output. */
function readPng(path: string): { rgba: Uint8ClampedArray; width: number; height: number } {
  const d = readFileSync(path);
  let p = 8, width = 0, height = 0, channels = 4;
  const idat: Buffer[] = [];
  while (p < d.length) {
    const len = d.readUInt32BE(p), type = d.toString("latin1", p + 4, p + 8);
    const body = d.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const colour = body[9];
      channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : 0;
      if (!channels || body[8] !== 8 || body[12] !== 0) throw new Error(`unsupported PNG: colour ${colour} depth ${body[8]}`);
    } else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8ClampedArray(width * height * 4);
  const line = new Uint8Array(stride), prev = new Uint8Array(stride);
  let q = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[q++];
    for (let i = 0; i < stride; i++) {
      const x = raw[q + i], a = i >= channels ? line[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      line[i] = v & 255;
    }
    q += stride;
    for (let x = 0; x < width; x++) {
      const s = x * channels, o = (y * width + x) * 4;
      out[o] = line[s]; out[o + 1] = line[s + (channels > 1 ? 1 : 0)]; out[o + 2] = line[s + (channels > 1 ? 2 : 0)];
      out[o + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev.set(line);
  }
  return { rgba: out, width, height };
}

function save(dir: string, name: string, grid: CellGrid): void {
  const raster = createRaster(grid.width, grid.height, font);
  renderGrid(grid, font, raster, { palette: VGA_PALETTE, iceColors: true });
  writeFileSync(`${dir}/${name}.png`, encodePng(raster));
  // and as characters, so the style can be read as text too
  let text = "";
  for (let y = 0; y < grid.height; y++) {
    let line = "";
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      const c = grid.glyph[i];
      line += grid.present[i] && c >= 32 && c <= 126 ? String.fromCharCode(c) : " ";
    }
    text += `${line.replace(/\s+$/, "")}\n`;
  }
  writeFileSync(`${dir}/${name}.txt`, text);
}

const dir = process.env.PROTO_RENDER;
it.skipIf(!dir)("renders the ASCII converters side by side", () => {
  for (const name of ["images", "images-1", "shopping"]) {
    const { rgba, width, height } = readPng(`${dir}/${name}.png`);
    const cols = 80;
    const rows = Math.max(1, Math.round((height / width) * cols * 8 / font.height));

    const adjusted = new Uint8ClampedArray(rgba);
    adjustSource(adjusted, width, height, { autoLevels: true, contrast: 1, saturation: 1 });

    const ascii = matchImageToFont(adjusted, width, height, cols, rows, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0 });
    save(dir!, `${name}-1-wholefont`, matchImageToFont(adjusted, width, height, cols, rows, font, VGA_PALETTE, {}));
    save(dir!, `${name}-2-ascii-black`, ascii);
    save(dir!, `${name}-2b-ascii-white`, matchImageToFont(adjusted, width, height, cols, rows, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 15 }));
    save(dir!, `${name}-3-contour`, contourAscii(adjusted, width, height, cols, rows, font));
    // monochrome: one ink, so only the characters carry it
    save(dir!, `${name}-4-mono`, matchImageToFont(adjusted, width, height, cols, rows, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 0, fixedFg: 7 }));
    save(dir!, `${name}-4b-mono-paper`, matchImageToFont(adjusted, width, height, cols, rows, font, VGA_PALETTE, { allow: isLowAscii, fixedBg: 15, fixedFg: 0 }));
    save(dir!, `${name}-5-mono-contour`, contourAscii(adjusted, width, height, cols, rows, font, VGA_PALETTE, { ink: 7 }));

    const counts = [0.04, 0.16, 0.4]
      .map((keep) => `${keep}:${[...contourAscii(adjusted, width, height, cols, rows, font, VGA_PALETTE, { keep }).present].filter(Boolean).length}`)
      .join(" ");
    console.log(`${name} ${cols}x${rows} (${cols * rows} cells)  contour cells at keep ${counts}`);
  }
});
