/**
 * Joint sync: the shared-canvas mirror and the composite diff.
 *
 * S (`shared`) is what we believe the server's canvas holds: a grid the size of
 * the joint, every cell present, glyph = CP437 code, fg/bg = palette index.
 * The server has no sequence numbers and never echoes our own DRAWs, so S is
 * simply "last thing written here, by us or by them".
 *
 * Incoming: `receive` puts the cell into S and hands it back for the Remote
 * layer the app pins on top of the stack, so other people's work shows exactly
 * as the server has it, whatever our own layers do underneath.
 *
 * Outgoing: after a local change the app composites everything *except* Remote
 * into L and calls `diff`. Every cell where L differs from S becomes a DRAW and
 * a Remote cell to clear -- our edit supersedes the older remote one, and
 * without the clear it would stay hidden under Remote.
 */
import { type Color, type Rgb, VGA_PALETTE } from "../color.js";
import { CH_ALL, type Cell, CellGrid, type Rect } from "../grid.js";
import { CLEAR_BLOCK, type JointBlock, blockToCell, cellToBlock } from "./types.js";

/** One outgoing DRAW. */
export interface JointSyncDraw {
  x: number;
  y: number;
  block: JointBlock;
}

export interface JointSyncDiff {
  /** row-major, in the order they should go on the wire */
  draws: JointSyncDraw[];
  /** cells the app must clear in the Remote layer: every cell that produced a DRAW */
  clear: [number, number][];
}

/** An incoming DRAW turned into a Remote-layer write. */
export interface JointSyncCell {
  x: number;
  y: number;
  cell: { glyph: number; fg: Color; bg: Color };
}

/** A shared canvas of `blocks` (row-major, from the server's doc), or all clear. */
export function sharedFromBlocks(columns: number, rows: number, blocks?: readonly JointBlock[]): CellGrid {
  const g = CellGrid.filled(columns, rows, CLEAR_BLOCK.code, CLEAR_BLOCK.fg, CLEAR_BLOCK.bg);
  if (!blocks) return g;
  for (let i = 0; i < g.glyph.length && i < blocks.length; i++) {
    const b = blocks[i];
    g.glyph[i] = b.code & 0xff;
    g.fg[i] = b.fg & 0xf;
    g.bg[i] = b.bg & 0xf;
  }
  return g;
}

export class JointSync {
  private cells: CellGrid;
  /** scratch, so a full-canvas diff does not allocate a Cell per cell */
  private readonly scratch: Cell = { glyph: 0, fg: 0, bg: 0, present: 0 };

  /**
   * `shared` is taken over, not copied: its cells are normalised to wire values
   * (every channel present, colours as palette indices) in place.
   */
  constructor(shared: CellGrid, readonly palette: readonly Rgb[] = VGA_PALETTE) {
    this.cells = shared;
    for (let i = 0; i < shared.glyph.length; i++) {
      this.scratch.glyph = shared.glyph[i]; this.scratch.fg = shared.fg[i];
      this.scratch.bg = shared.bg[i]; this.scratch.present = shared.present[i];
      this.write(i, cellToBlock(this.scratch, this.palette));   // an absent channel takes the clear block's default
    }
    shared.present.fill(CH_ALL);
  }

  /**
   * The mirror of the server's canvas. Read-only to callers, and its *identity
   * changes* on `resize` -- never hold on to it across one.
   */
  get shared(): CellGrid {
    return this.cells;
  }

  get width(): number {
    return this.cells.width;
  }

  get height(): number {
    return this.cells.height;
  }

  /** Masked the way the wire has it, so comparisons never depend on the writer. */
  private write(i: number, block: JointBlock): void {
    const c = blockToCell(block);
    this.cells.glyph[i] = c.glyph;
    this.cells.fg[i] = c.fg;
    this.cells.bg[i] = c.bg;
  }

  /** Apply an incoming DRAW; returns the cell to write into Remote, or null if it is off-canvas. */
  receive(x: number, y: number, block: JointBlock): JointSyncCell | null {
    if (!this.cells.inBounds(x, y)) return null;
    this.write(this.cells.index(x, y), block);
    return { x, y, cell: blockToCell(block) };
  }

  /**
   * Compare L (the composite minus Remote) to S over `rect` (default: all of
   * S, clipped to it either way), update S, and return what to send and what to
   * clear in Remote. L need not be S's size: cells outside it count as absent,
   * which is the clear block.
   */
  diff(local: CellGrid, rect?: Rect): JointSyncDiff {
    const S = this.cells;
    const x0 = rect ? Math.max(0, rect.x) : 0, y0 = rect ? Math.max(0, rect.y) : 0;
    const x1 = rect ? Math.min(S.width, rect.x + rect.width) : S.width;
    const y1 = rect ? Math.min(S.height, rect.y + rect.height) : S.height;
    const draws: JointSyncDraw[] = [], clear: [number, number][] = [];
    const c = this.scratch;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let block: JointBlock;
        if (x < local.width && y < local.height) {
          const j = y * local.width + x;
          c.glyph = local.glyph[j]; c.fg = local.fg[j]; c.bg = local.bg[j]; c.present = local.present[j];
          block = cellToBlock(c, this.palette);
        } else block = { ...CLEAR_BLOCK };
        const code = block.code & 0xff, fg = block.fg & 0xf, bg = block.bg & 0xf;
        const i = y * S.width + x;
        if (S.glyph[i] === code && S.fg[i] === fg && S.bg[i] === bg) continue;
        S.glyph[i] = code; S.fg[i] = fg; S.bg[i] = bg;
        draws.push({ x, y, block: { code, fg, bg } });
        clear.push([x, y]);
      }
    }
    return { draws, clear };
  }

  /** Diff the whole canvas -- "push my document into the joint" on a fresh S. */
  pushAll(local: CellGrid): JointSyncDiff {
    return this.diff(local);
  }

  /**
   * Keep the top-left overlap, fill the rest with the clear block: exactly what
   * libtextmode's resize_canvas does to the server's own copy.
   */
  resize(columns: number, rows: number): void {
    const old = this.cells;
    if (columns === old.width && rows === old.height) return;
    const next = CellGrid.filled(columns, rows, CLEAR_BLOCK.code, CLEAR_BLOCK.fg, CLEAR_BLOCK.bg);
    const w = Math.min(columns, old.width), h = Math.min(rows, old.height);
    for (let y = 0; y < h; y++) {
      const src = y * old.width, dst = y * columns;
      next.glyph.set(old.glyph.subarray(src, src + w), dst);
      next.fg.set(old.fg.subarray(src, src + w), dst);
      next.bg.set(old.bg.subarray(src, src + w), dst);
    }
    this.cells = next;
  }

  /** S row-major, as the server's `data` would have it. */
  snapshot(): JointBlock[] {
    const S = this.cells, out: JointBlock[] = new Array(S.glyph.length);
    for (let i = 0; i < out.length; i++) out[i] = { code: S.glyph[i], fg: S.fg[i], bg: S.bg[i] };
    return out;
  }
}
