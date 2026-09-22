import { type CellPatch, applyPatch } from "./edit.js";
import type { CellGrid } from "./grid.js";

export interface Command {
  label: string;
  redo(): void;
  undo(): void;
}

/** Undo for cell edits. The patch has already been applied when this is pushed. */
export function cellPatchCommand(label: string, grid: CellGrid, patch: CellPatch): Command {
  return {
    label,
    redo: () => applyPatch(grid, patch, "after"),
    undo: () => applyPatch(grid, patch, "before"),
  };
}

/** Undo for a property change (layer offset, visibility, a recipe field, a key rule list...). */
export function propertyCommand<T extends object, K extends keyof T>(
  label: string, target: T, key: K, before: T[K], after: T[K],
): Command {
  return {
    label,
    redo: () => { target[key] = after; },
    undo: () => { target[key] = before; },
  };
}

/** Several commands undone and redone as one step. */
export function groupCommand(label: string, commands: readonly Command[]): Command {
  return {
    label,
    redo: () => { for (const c of commands) c.redo(); },
    undo: () => { for (let i = commands.length - 1; i >= 0; i--) commands[i].undo(); },
  };
}

export class History {
  private readonly done: Command[] = [];
  private readonly undone: Command[] = [];

  constructor(private readonly limit = 1000) {}

  /** Record a command whose effect is already in place. */
  push(command: Command): void {
    this.serial++;
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
  }

  /** Apply a command and record it. */
  run(command: Command): void {
    command.redo();
    this.push(command);
  }

  private serial = 0;

  /**
   * Identifies the document's state: the number of commands pushed ever, and
   * how many are currently applied. Undo/redo move the second; a new command
   * after an undo bumps the first, so it never collides with an older state.
   */
  get position(): string { return `${this.serial}:${this.done.length}`; }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }

  undo(): Command | undefined {
    const c = this.done.pop();
    if (c) { c.undo(); this.undone.push(c); }
    return c;
  }

  redo(): Command | undefined {
    const c = this.undone.pop();
    if (c) { c.redo(); this.done.push(c); }
    return c;
  }
}
