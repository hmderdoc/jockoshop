import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CH_BG, CH_FG, CH_GLYPH, CLEAR_BLOCK, CellGrid, JOINT_ACTION, JOINT_STATUS, type JointBlock, type JointDoc,
  type JointMessage, VGA_PALETTE, blockToCell, cellToBlock, commentsFromWire, encodeJointMessage, gridFromJointDoc,
  jointDocFromGrid, jointToRgb, packJointDoc, parseJointMessage, rgb, rgbToJoint, unpackJointDoc,
} from "../src/index.js";

// The oracle is the real vendored libtextmode: it requires ./canvas and upng-js
// but only touches `document` lazily, so it loads under plain Node.
const MOEBIUS = "/Volumes/Crucial2TB/Projects/vsCode_moebius/vendor/moebius/app/libtextmode/libtextmode";
interface Libtextmode {
  compress(doc: { columns: number; rows: number; data: JointBlock[] }): Record<string, unknown>;
  uncompress(doc: Record<string, unknown>): { data: JointBlock[] };
  new_document(opts?: Record<string, unknown>): Record<string, unknown>;
}
let lt: Libtextmode | undefined;
if (existsSync(`${MOEBIUS}.js`)) lt = createRequire(import.meta.url)(MOEBIUS) as Libtextmode;
else console.log(`skipping joint oracle assertions: ${MOEBIUS}.js not found`);
/** so a missing oracle shows up as a skipped test, never as a silent pass */
const oracle = it.skipIf(!lt);

/** A deterministic PRNG, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function randomBlocks(n: number, seed: number, runny = false): JointBlock[] {
  const r = rng(seed);
  const out: JointBlock[] = [];
  while (out.length < n) {
    const block = { code: Math.floor(r() * 256), fg: Math.floor(r() * 16), bg: Math.floor(r() * 16) };
    // long runs as well as single cells, so [value, extra] is exercised both ways
    for (let k = runny ? 1 + Math.floor(r() * 40) : 1; k > 0 && out.length < n; k--) out.push({ ...block });
  }
  return out;
}

function doc(data: JointBlock[], columns: number, rows: number): JointDoc {
  return {
    columns, rows, title: "t", author: "a", group: "g", date: "20260101",
    palette: VGA_PALETTE.map(rgbToJoint), font_name: "IBM VGA", ice_colors: false, use_9px_font: false,
    comments: "one\ntwo", data,
  };
}

describe("joint RLE", () => {
  oracle("packs byte-for-byte like libtextmode.compress", () => {
    for (const [seed, runny] of [[1, false], [2, true], [3, true]] as const) {
      const data = randomBlocks(80 * 25, seed, runny);
      const mine = packJointDoc(doc(data, 80, 25));
      const theirs = lt!.compress(doc(data.map((b) => ({ ...b })), 80, 25) as never);
      expect(mine.compressed_data).toEqual(theirs.compressed_data);
      expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs));
    }
  });

  it("packs a uniform grid as one run per channel, like the oracle", () => {
    const data = Array.from({ length: 500 }, (): JointBlock => ({ code: 219, fg: 9, bg: 1 }));
    const mine = packJointDoc(doc(data, 100, 5));
    expect(mine.compressed_data).toEqual({ code: [[219, 499]], fg: [[9, 499]], bg: [[1, 499]] });
    if (lt) expect(mine.compressed_data).toEqual(lt.compress(doc(data, 100, 5) as never).compressed_data);
  });

  oracle("unpacks exactly like libtextmode.uncompress", () => {
    const data = randomBlocks(40 * 7, 4, true);
    const packed = packJointDoc(doc(data, 40, 7));
    // uncompress mutates and deletes compressed_data, so hand it its own copy
    const theirs = lt!.uncompress(JSON.parse(JSON.stringify(packed)) as Record<string, unknown>);
    expect(unpackJointDoc(packed).data).toEqual(theirs.data);
  });

  it("round-trips, purely: the inputs keep their own fields", () => {
    const data = randomBlocks(37, 5, true);
    const d = doc(data, 37, 1);
    const packed = packJointDoc(d);
    expect(d.data).toBe(data);
    expect(packed.data).toBeUndefined();
    const back = unpackJointDoc(packed);
    expect(packed.compressed_data).toBeDefined();
    expect(back.compressed_data).toBeUndefined();
    expect(back.data).toEqual(data);
    expect(back.palette).not.toBe(packed.palette);
    expect(packJointDoc(back).compressed_data).toEqual(packed.compressed_data);
  });

  it("handles one cell and none at all", () => {
    expect(packJointDoc(doc([{ code: 65, fg: 1, bg: 2 }], 1, 1)).compressed_data)
      .toEqual({ code: [[65, 0]], fg: [[1, 0]], bg: [[2, 0]] });
    expect(packJointDoc(doc([], 0, 0)).compressed_data).toEqual({ code: [], fg: [], bg: [] });
    expect(unpackJointDoc({ ...doc([], 0, 0), data: undefined, compressed_data: { code: [], fg: [], bg: [] } }).data).toEqual([]);
  });

  it("fills the clear block's defaults where a channel runs short", () => {
    const d = { ...doc([], 2, 1), data: undefined, compressed_data: { code: [[65, 1]], fg: [], bg: [] } } as JointDoc;
    expect(unpackJointDoc(d).data).toEqual([{ code: 65, fg: 7, bg: 0 }, { code: 65, fg: 7, bg: 0 }]);
  });
});

describe("cellToBlock", () => {
  it("maps an absent cell to Moebius's clear block", () => {
    expect(cellToBlock({ glyph: 219, fg: 4, bg: 5, present: 0 })).toEqual(CLEAR_BLOCK);
  });

  it("takes the clear block's defaults for absent channels", () => {
    expect(cellToBlock({ glyph: 219, fg: 4, bg: 5, present: CH_GLYPH })).toEqual({ code: 219, fg: 7, bg: 0 });
    expect(cellToBlock({ glyph: 219, fg: 4, bg: 5, present: CH_FG | CH_BG })).toEqual({ code: 32, fg: 4, bg: 5 });
  });

  it("sends 24-bit colour to the nearest palette index", () => {
    const cell = { glyph: 65, fg: rgb(255, 250, 250), bg: rgb(2, 2, 120), present: CH_GLYPH | CH_FG | CH_BG };
    expect(cellToBlock(cell)).toEqual({ code: 65, fg: 15, bg: 1 });
  });

  it("round-trips through blockToCell with every channel present", () => {
    const block = { code: 176, fg: 11, bg: 6 };
    const cell = blockToCell(block);
    expect(cell).toEqual({ glyph: 176, fg: 11, bg: 6 });
    expect(cellToBlock({ ...cell, present: CH_GLYPH | CH_FG | CH_BG })).toEqual(block);
  });
});

describe("doc <-> grid", () => {
  const settings = {
    title: "T", author: "A", group: "G", date: "20260102", comments: ["hi", "there"],
    fontName: "IBM VGA 50", letterSpacing9px: true, iceColors: true,
  };

  it("builds an unpacked doc in killerdraw's names, with SAUCE comments as one string", () => {
    const grid = CellGrid.filled(4, 2, 219, 9, 1);
    grid.clear(3, 1);
    const d = jointDocFromGrid(grid, settings);
    expect(d).toMatchObject({
      columns: 4, rows: 2, title: "T", author: "A", group: "G", date: "20260102",
      font_name: "IBM VGA 50", use_9px_font: true, ice_colors: true, comments: "hi\nthere",
    });
    expect(d.data).toHaveLength(8);
    expect(d.data![0]).toEqual({ code: 219, fg: 9, bg: 1 });
    expect(d.data![7]).toEqual(CLEAR_BLOCK);
    expect(d.palette).toEqual(VGA_PALETTE.map(rgbToJoint));
    expect(d.compressed_data).toBeUndefined();
  });

  it("stamps today's date when there is none, as new_document does", () => {
    expect(jointDocFromGrid(new CellGrid(1, 1), { ...settings, date: "" }).date).toMatch(/^\d{8}$/);
  });

  it("reads back the settings and a fully present grid, packed or not", () => {
    const grid = CellGrid.filled(4, 2, 219, 9, 1);
    const d = jointDocFromGrid(grid, settings);
    for (const input of [d, packJointDoc(d)]) {
      const out = gridFromJointDoc(input);
      expect(out).toMatchObject({
        title: "T", author: "A", group: "G", date: "20260102", comments: ["hi", "there"],
        fontName: "IBM VGA 50", letterSpacing9px: true, iceColors: true,
      });
      expect(out.palette).toEqual(VGA_PALETTE.map((c) => [...c]));
      expect(out.grid.width).toBe(4);
      expect(out.grid.present.every((p) => p === (CH_GLYPH | CH_FG | CH_BG))).toBe(true);
      expect(out.grid.get(0, 0)).toMatchObject({ glyph: 219, fg: 9, bg: 1 });
    }
  });

  it("fills short data with the clear block rather than leaving holes", () => {
    const d = { ...jointDocFromGrid(new CellGrid(3, 1), settings), data: [{ code: 65, fg: 1, bg: 2 }] };
    const out = gridFromJointDoc(d);
    expect(out.grid.get(2, 0)).toMatchObject({ glyph: 32, fg: 7, bg: 0 });
    expect(out.grid.present[2]).toBe(CH_GLYPH | CH_FG | CH_BG);
  });

  it("scales the palette between 6-bit EGA and sRGB", () => {
    expect(rgbToJoint([170, 85, 0])).toEqual({ r: 42, g: 21, b: 0 });
    expect(jointToRgb({ r: 42, g: 21, b: 0 })).toEqual([170, 85, 0]);
    expect(jointToRgb({ r: 63, g: 63, b: 63 })).toEqual([255, 255, 255]);
    for (const c of VGA_PALETTE) expect(jointToRgb(rgbToJoint(c))).toEqual([...c]);
    if (lt) expect(VGA_PALETTE.map(rgbToJoint)).toEqual((lt.new_document() as { palette: unknown }).palette);
  });

  it("falls back to the VGA palette when the doc has none", () => {
    const d = jointDocFromGrid(new CellGrid(1, 1), settings);
    expect(gridFromJointDoc({ ...d, palette: undefined }).palette).toEqual(VGA_PALETTE.map((c) => [...c]));
  });

  it("comments: an empty string is no lines at all", () => {
    expect(commentsFromWire("")).toEqual([]);
    expect(commentsFromWire(undefined)).toEqual([]);
    expect(commentsFromWire("a\nb")).toEqual(["a", "b"]);
  });
});

describe("messages", () => {
  const round = (msg: JointMessage): JointMessage | null => parseJointMessage(encodeJointMessage(msg));

  it("round-trips every action", () => {
    const block = { code: 219, fg: 9, bg: 1 };
    const msgs: JointMessage[] = [
      { type: JOINT_ACTION.CONNECTED, data: { nick: "me", group: "us", pass: "" } },
      { type: JOINT_ACTION.CONNECTED, data: { id: 3, doc: packJointDoc(doc([block], 1, 1)), users: [], chat_history: [], status: JOINT_STATUS.ACTIVE } },
      { type: JOINT_ACTION.REFUSED, data: {} },
      { type: JOINT_ACTION.JOIN, data: { id: 1, nick: "n", group: "g", status: JOINT_STATUS.WEB } },
      { type: JOINT_ACTION.LEAVE, data: { id: 1 } },
      { type: JOINT_ACTION.CURSOR, data: { id: 1, x: 2, y: 3 } },
      { type: JOINT_ACTION.SELECTION, data: { id: 1, x: 2, y: 3 } },
      { type: JOINT_ACTION.RESIZE_SELECTION, data: { id: 1, x: 2, y: 3 } },
      { type: JOINT_ACTION.OPERATION, data: { id: 1, x: 2, y: 3 } },
      { type: JOINT_ACTION.HIDE_CURSOR, data: { id: 1 } },
      { type: JOINT_ACTION.DRAW, data: { id: 1, x: 2, y: 3, block } },
      { type: JOINT_ACTION.CHAT, data: { id: 1, nick: "n", group: "g", text: "yo" } },
      { type: JOINT_ACTION.CHAT, data: { id: 1, nick: "n", group: "g", text: "yo", time: 1700000000000 } },
      { type: JOINT_ACTION.STATUS, data: { id: 1, status: JOINT_STATUS.AWAY } },
      { type: JOINT_ACTION.SAUCE, data: { id: 1, title: "t", author: "a", group: "g", comments: "c\nd" } },
      { type: JOINT_ACTION.ICE_COLORS, data: { id: 1, value: true } },
      { type: JOINT_ACTION.USE_9PX_FONT, data: { id: 1, value: false } },
      { type: JOINT_ACTION.CHANGE_FONT, data: { id: 1, font_name: "IBM VGA" } },
      { type: JOINT_ACTION.SET_CANVAS_SIZE, data: { id: 1, columns: 80, rows: 25 } },
      { type: JOINT_ACTION.PASTE_AS_SELECTION, data: { id: 1, blocks: { columns: 1, rows: 1, data: [block] } } },
      { type: JOINT_ACTION.ROTATE, data: { id: 1 } },
      { type: JOINT_ACTION.FLIP_X, data: { id: 1 } },
      { type: JOINT_ACTION.FLIP_Y, data: { id: 1 } },
      { type: JOINT_ACTION.SET_BG, data: { id: 1, value: 6 } },
    ];
    expect(new Set(msgs.map((m) => m.type)).size).toBe(Object.keys(JOINT_ACTION).length);
    for (const msg of msgs) expect(round(msg)).toEqual(msg);
  });

  it("writes only type and data, as the server does", () => {
    expect(encodeJointMessage({ type: JOINT_ACTION.CURSOR, data: { id: 1, x: 2, y: 3 } }))
      .toBe('{"type":4,"data":{"id":1,"x":2,"y":3}}');
  });

  it("narrows on type", () => {
    const msg = parseJointMessage('{"type":9,"data":{"id":1,"x":4,"y":5,"block":{"code":1,"fg":2,"bg":3}}}');
    expect(msg?.type).toBe(JOINT_ACTION.DRAW);
    if (msg?.type === JOINT_ACTION.DRAW) expect(msg.data.block.code).toBe(1);
  });

  it("takes a guest's CONNECTED request and the server's short reply", () => {
    // the web client sends {nick: undefined, group: undefined, pass: ""}; JSON drops the undefineds
    expect(parseJointMessage('{"type":0,"data":{"pass":""}}')).toEqual({ type: 0, data: { pass: "" } });
    expect(parseJointMessage('{"type":0,"data":{"id":0,"doc":{"columns":1}}}')?.type).toBe(JOINT_ACTION.CONNECTED);
    expect(parseJointMessage('{"type":1}')).toEqual({ type: 1, data: {} });
  });

  it("returns null for garbage instead of throwing", () => {
    for (const bad of [
      "", "   ", "null", "[]", '"hi"', "42", "{", "{}", '{"data":{}}', '{"type":"9","data":{}}',
      '{"type":99,"data":{}}', '{"type":-1,"data":{}}', '{"type":9,"data":null}', '{"type":9,"data":[]}',
      '{"type":9,"data":{"id":1,"x":1}}', '{"type":9,"data":{"id":1,"x":1,"y":2}}',
      '{"type":9,"data":{"id":1,"x":1,"y":2,"block":{"code":1,"fg":2}}}',
      '{"type":4,"data":{"x":1,"y":2}}', '{"type":4,"data":{"id":1,"x":"1","y":2}}',
      '{"type":10,"data":{"id":1,"nick":"n","group":"g"}}', '{"type":13,"data":{"id":1,"value":1}}',
      '{"type":15,"data":{"id":1}}', '{"type":16,"data":{"id":1,"columns":80}}',
      '{"type":0,"data":{"id":1}}', '{"type":0,"data":{"nick":7}}',
      '{"type":17,"data":{"id":1,"blocks":{"columns":1,"rows":1,"data":[{"code":1}]}}}',
      '{"type":12,"data":{"id":1,"title":"t","author":"a","group":"g","comments":["c"]}}',
    ]) expect(parseJointMessage(bad), bad).toBeNull();
  });

  it("survives a truncated frame and a NaN", () => {
    expect(parseJointMessage('{"type":9,"data":{"id":1,"x":1,"y":2,"bl')).toBeNull();
    expect(parseJointMessage('{"type":4,"data":{"id":1,"x":1e999,"y":2}}')).toBeNull();
  });
});
