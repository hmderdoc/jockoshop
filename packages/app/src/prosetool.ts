/**
 * Word-processor editing of a prose layer on the canvas: caret, typing,
 * deleting, arrows, paste. Edits reflow the layer at once; a burst of typing
 * is one undo step (it ends on a pause, a click, or leaving the tool).
 */
import { type ProseLayer, deleteText, insertText, layoutProse, proseCaretCell, proseIndexAt, proseObstacles, refreshProseLayer } from "@killerdraw/core";
import type { Editor } from "./editor.js";

interface Snapshot { text: string; fg: number[]; bg: number[] }

export class ProseEditing {
  layer: ProseLayer | null = null;
  caret = 0;
  /** the other end of the selection; null = nothing selected */
  anchor: number | null = null;
  /** the column arrow keys aim for while moving up and down through shorter lines */
  private wantX = -1;
  private burst: { before: Snapshot; caretBefore: number } | null = null;
  private burstTimer = 0;

  constructor(private ed: Editor) {}

  private snap(l: ProseLayer): Snapshot { return { text: l.text, fg: [...l.fg], bg: [...l.bg] }; }

  private layout() {
    const l = this.layer!;
    return layoutProse(l, proseObstacles(this.ed.doc, l, this.ed.glyphs));
  }

  /** Start editing `layer` with the caret at frame cell (x, y), or at the end. */
  begin(layer: ProseLayer, at?: { x: number; y: number }, extend = false): void {
    this.endBurst();   // placing the caret ends a typing step, as a caret move does in a word processor
    if (this.layer !== layer) { this.layer = layer; this.anchor = null; }
    const to = at ? proseIndexAt(layer, this.layout(), at.x, at.y) : layer.text.length;
    if (extend) this.anchor ??= this.caret; else this.anchor = null;
    this.caret = to;
    this.wantX = -1;
    this.ed.emit("ui");
  }

  /** Drag with the Type tool: extend the selection to the cell under the pointer. */
  dragTo(at: { x: number; y: number }): void {
    const l = this.layer;
    if (!l) return;
    const to = proseIndexAt(l, this.layout(), at.x, at.y);
    if (to === this.caret) return;
    this.anchor ??= this.caret;
    this.caret = to;
    this.ed.emit("ui");
  }

  end(): void { this.endBurst(); this.layer = null; this.anchor = null; this.ed.emit("ui"); }

  /** [from, to) of the selected text, or null */
  selection(): [number, number] | null {
    if (this.anchor === null || this.anchor === this.caret) return null;
    return [Math.min(this.anchor, this.caret), Math.max(this.anchor, this.caret)];
  }

  selectedText(): string {
    const r = this.selection();
    return r && this.layer ? this.layer.text.slice(r[0], r[1]) : "";
  }

  selectAll(): void {
    if (!this.layer) return;
    this.endBurst();
    this.anchor = 0;
    this.caret = this.layer.text.length;
    this.ed.emit("ui");
  }

  /** Select the word around the caret (double-click). */
  selectWord(): void {
    const l = this.layer;
    if (!l) return;
    const isWord = (i: number): boolean => i >= 0 && i < l.text.length && !/[\s]/.test(l.text[i]);
    let a = this.caret, b = this.caret;
    if (!isWord(a) && isWord(a - 1)) a--;
    while (isWord(a - 1)) a--;
    b = a;
    while (isWord(b)) b++;
    if (b > a) { this.endBurst(); this.anchor = a; this.caret = b; this.ed.emit("ui"); }
  }

  /** Document cells of the selected characters, for the overlay. */
  selectionCells(): { x: number; y: number }[] {
    const r = this.selection(), l = this.layer;
    if (!r || !l) return [];
    const lay = this.layout(), out: { x: number; y: number }[] = [];
    for (let i = r[0]; i < r[1]; i++) {
      const at = lay.place[i] >= 0 ? lay.place[i] : lay.before[i];
      if (at >= 0) out.push({ x: (at % l.width) + l.x, y: Math.floor(at / l.width) + l.y });
    }
    return out;
  }

  /** Recolour the selected characters; a channel left undefined is kept. -1 as bg = see-through. */
  recolor(fg?: number, bg?: number): boolean {
    const r = this.selection();
    if (!r) return false;
    this.edit((l) => { for (let i = r[0]; i < r[1]; i++) { if (fg !== undefined) l.fg[i] = fg; if (bg !== undefined) l.bg[i] = bg; } });
    this.anchor = r[0]; this.caret = r[1];   // keep the selection for another colour
    this.endBurst();
    return true;
  }

  /** Delete the selection; returns false when there was none. */
  deleteSelection(): boolean {
    const r = this.selection();
    if (!r) return false;
    this.edit((l) => { deleteText(l, r[0], r[1]); this.caret = r[0]; });
    return true;
  }

  caretCell(): { x: number; y: number } | null {
    const l = this.layer;
    if (!l) return null;
    const c = proseCaretCell(l, this.layout(), this.caret);
    return c && { x: c.x + l.x, y: c.y + l.y };
  }

  /** Apply an edit: reflow now, and fold it into the running undo step. */
  private edit(fn: (l: ProseLayer) => void): void {
    const l = this.layer!;
    this.burst ??= { before: this.snap(l), caretBefore: this.caret };
    fn(l);
    this.anchor = null;
    refreshProseLayer(this.ed.doc, l, this.ed.glyphs);
    this.ed.recomposite();
    this.wantX = -1;
    clearTimeout(this.burstTimer);
    this.burstTimer = window.setTimeout(() => this.endBurst(), 1500);
    this.ed.emit("ui");
  }

  endBurst(): void {
    clearTimeout(this.burstTimer);
    const b = this.burst, l = this.layer, ed = this.ed;
    this.burst = null;
    if (!b || !l) return;
    const after = this.snap(l), caretAfter = this.caret;
    if (after.text === b.before.text && after.fg.join() === b.before.fg.join() && after.bg.join() === b.before.bg.join()) return;
    const restore = (s: Snapshot, caret: number): void => {
      l.text = s.text; l.fg = [...s.fg]; l.bg = [...s.bg];
      refreshProseLayer(ed.doc, l, ed.glyphs);
      if (this.layer === l) this.caret = caret;
    };
    ed.history.push({ label: "Edit text", redo: () => restore(after, caretAfter), undo: () => restore(b.before, b.caretBefore) });
    ed.emit("ui");
  }

  insert(str: string): void {
    const fg = this.ed.fg, bg = this.ed.drawBg ? this.ed.bg : -1;
    const r = this.selection();
    this.edit((l) => {
      if (r) { deleteText(l, r[0], r[1]); this.caret = r[0]; }   // typing replaces the selection
      this.caret = insertText(l, this.caret, str, fg, bg);
    });
  }

  backspace(): void { if (!this.deleteSelection() && this.caret > 0) this.edit((l) => { deleteText(l, this.caret - 1, this.caret); this.caret--; }); }
  deleteForward(): void { const l = this.layer!; if (!this.deleteSelection() && this.caret < l.text.length) this.edit((l2) => deleteText(l2, this.caret, this.caret + 1)); }

  move(dx: number, dy: number, home = false, end = false, extend = false): void {
    this.endBurst();
    const l = this.layer!;
    const lay = this.layout();
    const sel = this.selection();
    if (extend) this.anchor ??= this.caret;
    else if (sel && dx && !dy) { this.anchor = null; this.caret = dx < 0 ? sel[0] : sel[1]; this.ed.emit("ui"); return; }   // collapse to an end
    else this.anchor = null;
    if (home || end) {
      const c = proseCaretCell(l, lay, this.caret);
      if (c) this.caret = proseIndexAt(l, lay, home ? 0 : l.width - 1, c.y);
      this.wantX = -1;
    } else if (dy) {
      const c = proseCaretCell(l, lay, this.caret);
      if (c) {
        if (this.wantX < 0) this.wantX = c.x;
        const target = proseIndexAt(l, lay, this.wantX, Math.max(0, Math.min(l.height - 1, c.y + dy)));
        const t = proseCaretCell(l, lay, target);
        if (t && t.y !== c.y) this.caret = target;
      }
    } else {
      this.caret = Math.max(0, Math.min(l.text.length, this.caret + dx));
      this.wantX = -1;
    }
    this.ed.emit("ui");
  }

  /** Keyboard handling while a prose layer is being edited. */
  keydown(e: KeyboardEvent): boolean {
    if (!this.layer) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Escape") { if (this.selection()) { this.anchor = null; this.ed.emit("ui"); } else this.end(); return true; }
    if (mod) return false;   // shortcuts (undo, select all, copy, paste…) belong to the app
    const ext = e.shiftKey;
    if (e.key === "ArrowLeft") this.move(-1, 0, false, false, ext);
    else if (e.key === "ArrowRight") this.move(1, 0, false, false, ext);
    else if (e.key === "ArrowUp") this.move(0, -1, false, false, ext);
    else if (e.key === "ArrowDown") this.move(0, 1, false, false, ext);
    else if (e.key === "Home") this.move(0, 0, true, false, ext);
    else if (e.key === "End") this.move(0, 0, false, true, ext);
    else if (e.key === "Enter") this.insert("\n");
    else if (e.key === "Backspace") this.backspace();
    else if (e.key === "Delete") this.deleteForward();
    else if (e.key.length === 1 && !e.altKey) this.insert(e.key);
    else return false;
    return true;
  }
}
