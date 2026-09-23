import { zlibSync } from "fflate";
import type { Raster } from "../render.js";

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number): Uint8Array {
  const head = new Uint8Array(13);
  const v = new DataView(head.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  head[8] = 8; head[9] = 2;   // 8-bit RGB
  return head;
}

/** The raster's pixels as filtered (filter 0) RGB scanlines, deflated: an IDAT body. */
function compressed(raster: Raster): Uint8Array {
  const { width, height, data } = raster;
  const raw = new Uint8Array(height * (1 + width * 3));
  let o = 0, s = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) { raw[o++] = data[s++]; raw[o++] = data[s++]; raw[o++] = data[s++]; s++; }
  }
  return zlibSync(raw, { level: 6 });
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 8-bit RGB PNG (the raster is always opaque). */
export function encodePng(raster: Raster): Uint8Array {
  return join([SIGNATURE, chunk("IHDR", ihdr(raster.width, raster.height)), chunk("IDAT", compressed(raster)), chunk("IEND", new Uint8Array(0))]);
}

/**
 * Animated PNG: every frame a full, opaque picture of the same size, shown for
 * `delayMs` each, looping `plays` times (0 = forever). The first frame is the
 * ordinary image, so a viewer that doesn't animate shows it.
 */
export function encodeApng(frames: readonly Raster[], delayMs: number, plays = 0): Uint8Array {
  if (!frames.length) throw new Error("an animation needs at least one frame");
  const { width, height } = frames[0];
  if (frames.some((f) => f.width !== width || f.height !== height)) throw new Error("animation frames must all be the same size");
  const u32 = (...values: number[]): Uint8Array => {
    const out = new Uint8Array(values.length * 4), v = new DataView(out.buffer);
    values.forEach((n, i) => v.setUint32(i * 4, n));
    return out;
  };
  const delay = Math.max(1, Math.round(delayMs));
  let seq = 0;
  const parts = [SIGNATURE, chunk("IHDR", ihdr(width, height)), chunk("acTL", u32(frames.length, plays))];
  frames.forEach((f, i) => {
    // fcTL: sequence, size, offset, delay as a fraction (ms / 1000), dispose none, blend source
    const ctl = new Uint8Array(26);
    ctl.set(u32(seq++, width, height, 0, 0));
    new DataView(ctl.buffer).setUint16(20, delay);
    new DataView(ctl.buffer).setUint16(22, 1000);
    parts.push(chunk("fcTL", ctl));
    const body = compressed(f);
    if (i === 0) parts.push(chunk("IDAT", body));
    else parts.push(chunk("fdAT", join([u32(seq++), body])));
  });
  parts.push(chunk("IEND", new Uint8Array(0)));
  return join(parts);
}
