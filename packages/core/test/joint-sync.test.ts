import { describe, expect, it } from "vitest";
import {
  BLUE, CH_ALL, CLEAR_BLOCK, CellGrid, type JointBlock, JointSync, LIGHT_RED, RED, WHITE,
  cellToBlock, rgb, sharedFromBlocks,
} from "../src/index.js";

const A = 65, B = 66, FULL = 219;

/** A clear shared canvas plus a matching all-clear local grid (what a peer sees on joining). */
function joined(w: number, h: number) {
  const sync = new JointSync(sharedFromBlocks(w, h));
  const local = CellGrid.filled(w, h, CLEAR_BLOCK.code, CLEAR_BLOCK.fg, CLEAR_BLOCK.bg);
  return { sync, local };
}

describe("JointSync.receive", () => {
  it("writes S and returns the cell for the Remote layer", () => {
    const { sync } = joined(4, 3);
    expect([sync.width, sync.height]).toEqual([4, 3]);
    expect(sync.receive(1, 2, { code: A, fg: LIGHT_RED, bg: BLUE }))
      .toEqual({ x: 1, y: 2, cell: { glyph: A, fg: LIGHT_RED, bg: BLUE } });
    expect(sync.shared.get(1, 2)).toEqual({ glyph: A, fg: LIGHT_RED, bg: BLUE, present: CH_ALL });
    expect(sync.snapshot()[2 * 4 + 1]).toEqual({ code: A, fg: LIGHT_RED, bg: BLUE });
  });

  it("ignores DRAWs off the canvas", () => {
    const { sync } = joined(4, 3);
    for (const [x, y] of [[4, 0], [0, 3], [-1, 0], [0, -1]]) {
      expect(sync.receive(x, y, { code: A, fg: WHITE, bg: BLUE })).toBeNull();
    }
    expect(sync.snapshot().every((b) => b.code === CLEAR_BLOCK.code)).toBe(true);
  });

  it("masks the wire values it is handed", () => {
    const { sync } = joined(2, 1);
    sync.receive(0, 0, { code: 0x141, fg: 0x1c, bg: 0x17 });
    expect(sync.shared.get(0, 0)).toMatchObject({ glyph: 0x41, fg: 0xc, bg: 0x7 });
  });
});

describe("JointSync.diff", () => {
  it("reports only what changed inside the rect, and clears the same cells", () => {
    const { sync, local } = joined(4, 3);
    local.set(1, 1, { glyph: A, fg: RED, bg: BLUE });
    local.set(3, 0, { glyph: B, fg: WHITE, bg: BLUE });   // outside the rect
    const out = sync.diff(local, { x: 0, y: 1, width: 3, height: 2 });
    expect(out.draws).toEqual([{ x: 1, y: 1, block: { code: A, fg: RED, bg: BLUE } }]);
    expect(out.clear).toEqual([[1, 1]]);
    expect(sync.shared.get(1, 1)).toMatchObject({ glyph: A, fg: RED, bg: BLUE });
    expect(sync.shared.get(3, 0)).toMatchObject({ glyph: CLEAR_BLOCK.code });   // untouched
    expect(sync.diff(local, { x: 0, y: 1, width: 3, height: 2 }).draws).toEqual([]);   // S caught up
  });

  it("clips the rect to S and defaults to the whole canvas", () => {
    const { sync, local } = joined(3, 2);
    local.set(2, 1, { glyph: A, fg: RED, bg: BLUE });
    expect(sync.diff(local, { x: -5, y: -5, width: 2, height: 2 }).draws).toEqual([]);
    const all = sync.diff(local);
    expect(all.draws).toEqual([{ x: 2, y: 1, block: { code: A, fg: RED, bg: BLUE } }]);
    expect(sync.pushAll(local).draws).toEqual([]);
  });

  it("ignores an L bigger than S", () => {
    const { sync } = joined(2, 1);
    const big = CellGrid.filled(4, 3, A, RED, BLUE);
    expect(sync.diff(big).draws.map((d) => [d.x, d.y])).toEqual([[0, 0], [1, 0]]);
  });

  it("row-major order over a rect", () => {
    const { sync, local } = joined(3, 3);
    for (const [x, y] of [[2, 2], [0, 1], [2, 1]]) local.set(x, y, { glyph: A, fg: RED, bg: BLUE });
    const out = sync.diff(local);
    expect(out.draws.map((d) => [d.x, d.y])).toEqual([[0, 1], [2, 1], [2, 2]]);
    expect(out.clear).toEqual(out.draws.map((d) => [d.x, d.y]));
  });

  it("an absent local cell is the clear block, so it erases a remote one", () => {
    const { sync } = joined(2, 2);
    sync.receive(1, 1, { code: FULL, fg: LIGHT_RED, bg: BLUE });
    const empty = new CellGrid(2, 2);   // nothing present: a document with no layers under Remote
    const out = sync.diff(empty);
    expect(out.draws).toEqual([{ x: 1, y: 1, block: { ...CLEAR_BLOCK } }]);
    expect(sync.shared.get(1, 1)).toMatchObject({ glyph: CLEAR_BLOCK.code, fg: CLEAR_BLOCK.fg, bg: CLEAR_BLOCK.bg });
  });

  it("treats cells past the end of a smaller L as absent", () => {
    const { sync } = joined(3, 2);
    sync.receive(2, 1, { code: FULL, fg: WHITE, bg: BLUE });
    const small = CellGrid.filled(1, 1, A, RED, BLUE);
    const out = sync.diff(small);
    expect(out.draws).toEqual([
      { x: 0, y: 0, block: { code: A, fg: RED, bg: BLUE } },
      { x: 2, y: 1, block: { ...CLEAR_BLOCK } },
    ]);
  });

  it("sends a 24-bit local colour as its nearest palette index, then sends nothing", () => {
    const { sync, local } = joined(2, 1);
    local.set(0, 0, { glyph: A, fg: rgb(250, 250, 250), bg: rgb(2, 2, 180) });
    const expected = cellToBlock(local.get(0, 0));
    expect(expected).toEqual({ code: A, fg: WHITE, bg: BLUE });
    expect(sync.diff(local).draws).toEqual([{ x: 0, y: 0, block: expected }]);
    expect(sync.diff(local).draws).toEqual([]);   // compared as the index we sent
  });

  it("normalises a shared grid it is handed: absent channels take the clear block's defaults", () => {
    const g = new CellGrid(2, 1);
    g.set(0, 0, { glyph: A });   // glyph only, no colours
    const sync = new JointSync(g);
    expect(sync.snapshot()).toEqual([{ code: A, fg: CLEAR_BLOCK.fg, bg: CLEAR_BLOCK.bg }, { ...CLEAR_BLOCK }]);
    const local = CellGrid.filled(2, 1, A, CLEAR_BLOCK.fg, CLEAR_BLOCK.bg);
    expect(sync.diff(local).draws).toEqual([{ x: 1, y: 0, block: { code: A, fg: 7, bg: 0 } }]);
  });
});

describe("JointSync.resize", () => {
  it("keeps the overlap and fills the rest with the clear block", () => {
    const { sync } = joined(4, 3);
    sync.receive(0, 0, { code: A, fg: RED, bg: BLUE });
    sync.receive(3, 2, { code: B, fg: WHITE, bg: BLUE });
    sync.resize(2, 2);
    expect([sync.width, sync.height]).toEqual([2, 2]);
    expect(sync.snapshot()).toEqual([
      { code: A, fg: RED, bg: BLUE }, { ...CLEAR_BLOCK }, { ...CLEAR_BLOCK }, { ...CLEAR_BLOCK },
    ]);
    sync.resize(3, 3);
    expect(sync.shared.get(0, 0)).toMatchObject({ glyph: A, fg: RED, bg: BLUE, present: CH_ALL });
    expect(sync.snapshot().slice(1).every((b) => b.code === CLEAR_BLOCK.code && b.fg === 7 && b.bg === 0)).toBe(true);
    expect(sync.receive(2, 2, { code: B, fg: WHITE, bg: BLUE })).not.toBeNull();
  });

  it("diffs against the new size afterwards", () => {
    const { sync, local: old } = joined(2, 2);
    sync.diff(old);
    sync.resize(3, 1);
    const local = CellGrid.filled(3, 1, A, RED, BLUE);
    expect(sync.diff(local).draws.map((d) => d.x)).toEqual([0, 1, 2]);
    expect(sync.diff(local).draws).toEqual([]);
  });
});

/** Deterministic LCG, so a failing seed can be replayed. */
function rand(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 8) / 0x1000000;
}

describe("two peers converge", () => {
  const W = 6, H = 4;

  /**
   * A and B each keep their own JointSync plus the local grid the app would
   * composite (minus Remote). Every round each peer paints one cell, diffs a
   * patch around it -- so it also re-asserts its own older cells over what the
   * other peer drew there -- and the other peer receives the DRAWs at once.
   * Both mirrors must then match a plain last-writer-wins replay of the log.
   */
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}`, () => {
      const rng = rand(seed);
      const peers = [joined(W, H), joined(W, H)];
      const log: { x: number; y: number; block: JointBlock }[] = [];
      for (let round = 0; round < 60; round++) {
        for (let p = 0; p < 2; p++) {
          const { sync, local } = peers[p];
          const x = Math.floor(rng() * W), y = Math.floor(rng() * H);
          const code = 32 + Math.floor(rng() * 4), fg = Math.floor(rng() * 16), bg = Math.floor(rng() * 8);
          local.set(x, y, { glyph: code, fg, bg });
          const { draws, clear } = sync.diff(local, { x: x - 1, y: y - 1, width: 3, height: 2 });
          expect(clear).toEqual(draws.map((d) => [d.x, d.y]));
          for (const d of draws) {
            log.push(d);
            expect(peers[1 - p].sync.receive(d.x, d.y, d.block)).not.toBeNull();
          }
        }
      }
      const replay = new JointSync(sharedFromBlocks(W, H));
      for (const d of log) replay.receive(d.x, d.y, d.block);
      expect(log.length).toBeGreaterThan(60);   // the runs really did interleave
      expect(peers[0].sync.shared.equals(replay.shared)).toBe(true);
      expect(peers[1].sync.shared.equals(replay.shared)).toBe(true);
    });
  }
});
