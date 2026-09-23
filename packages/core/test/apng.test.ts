import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Raster, createRaster, encodeApng, encodePng, parseRawFont } from "../src/index.js";

const font = parseRawFont(new Uint8Array(256 * 16));   // blank 8x16 font: pixels come from the fill below

function frame(shade: number): Raster {
  const r = createRaster(2, 1, font);
  for (let i = 0; i < r.data.length; i += 4) { r.data[i] = shade; r.data[i + 1] = 0; r.data[i + 2] = 255 - shade; r.data[i + 3] = 255; }
  return r;
}

/** The chunk types of a PNG in order (data left out). */
function chunkTypes(png: Uint8Array): string[] {
  const out: string[] = [];
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = 8; at < png.length;) {
    const len = v.getUint32(at);
    out.push(String.fromCharCode(...png.subarray(at + 4, at + 8)));
    at += 12 + len;
  }
  return out;
}

describe("animated PNG", () => {
  it("is a PNG whose first frame is the ordinary image, with the frames after it as fdAT", () => {
    const frames = [frame(0), frame(128), frame(255)];
    const apng = encodeApng(frames, 80);
    expect(Array.from(apng.subarray(0, 8))).toEqual(Array.from(encodePng(frames[0]).subarray(0, 8)));
    expect(chunkTypes(apng)).toEqual(["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
    const v = new DataView(apng.buffer);
    const actl = chunkTypes(apng).indexOf("acTL");   // acTL is the second chunk: after the 8-byte signature and the 25-byte IHDR
    expect(actl).toBe(1);
    expect(v.getUint32(8 + 25 + 8)).toBe(3);   // frame count
    expect(v.getUint32(8 + 25 + 8 + 4)).toBe(0);   // loop forever
  });

  it("refuses mismatched frames", () => {
    expect(() => encodeApng([frame(0), createRaster(3, 1, font)], 50)).toThrow(/same size/);
    expect(() => encodeApng([], 50)).toThrow();
  });

  // an independent decoder: Pillow reads APNG (n_frames, per-frame pixels). Skipped where python3 + PIL are missing.
  it("decodes in Pillow with every frame's pixels and delay intact", () => {
    let pil = false;
    try { execFileSync("python3", ["-c", "import PIL"], { stdio: "ignore" }); pil = true; } catch { /* no oracle here */ }
    if (!pil) return;
    const dir = mkdtempSync(join(tmpdir(), "kd-apng-")), file = join(dir, "a.png");
    writeFileSync(file, encodeApng([frame(0), frame(128), frame(255)], 70));
    const script = [
      "import sys, json", "from PIL import Image", `im = Image.open(${JSON.stringify(file)})`,
      "out = {'animated': im.is_animated, 'n': im.n_frames, 'frames': []}",
      "for i in range(im.n_frames):",
      "    im.seek(i); out['frames'].append({'px': im.convert('RGB').getpixel((0, 0)), 'delay': im.info.get('duration')})",
      "print(json.dumps(out))",
    ].join("\n");
    const got = JSON.parse(execFileSync("python3", ["-c", script]).toString()) as { animated: boolean; n: number; frames: { px: number[]; delay: number }[] };
    expect(got.animated).toBe(true);
    expect(got.n).toBe(3);
    expect(got.frames.map((f) => f.px)).toEqual([[0, 0, 255], [128, 0, 127], [255, 0, 0]]);
    expect(got.frames.every((f) => f.delay === 70)).toBe(true);
  });
});
