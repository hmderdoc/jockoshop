import { describe, expect, it } from "vitest";
import { comboCandidates, comboLabel, indexBindings, lookup, type Binding } from "../src/keymap.js";

/** just enough of a KeyboardEvent for the matcher */
const ev = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}): KeyboardEvent =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("reading a key press as a combo", () => {
  it("names plain keys, function keys and arrows the same way a binding does", () => {
    expect(comboCandidates(ev("x"), true)).toEqual(["x"]);
    expect(comboCandidates(ev("X", { shiftKey: true }), true)).toEqual(["shift+x"]);
    expect(comboCandidates(ev("F3"), true)).toEqual(["f3"]);
    expect(comboCandidates(ev("ArrowUp"), true)).toEqual(["arrowup"]);
    expect(comboCandidates(ev("Escape"), true)).toEqual(["escape"]);
  });

  it("on a Mac, Cmd is the menu modifier and Ctrl is its own key", () => {
    expect(comboCandidates(ev("d", { metaKey: true }), true)).toEqual(["mod+d"]);
    expect(comboCandidates(ev("1", { ctrlKey: true }), true)).toEqual(["ctrl+1"]);
  });

  /**
   * The interesting case: off a Mac, Ctrl is *both* the menu modifier and the
   * key Moebius uses for colours. Offering ctrl+ first is what lets Ctrl+1 be
   * a foreground colour there, as it is in Moebius, while Cmd/Ctrl+S stays Save.
   */
  it("elsewhere, Ctrl offers its own meaning first and the menu one second", () => {
    expect(comboCandidates(ev("1", { ctrlKey: true }), false)).toEqual(["ctrl+1", "mod+1"]);
    expect(comboCandidates(ev("s", { ctrlKey: true }), false)).toEqual(["ctrl+s", "mod+s"]);
  });

  it("ignores the modifier keys themselves", () => {
    for (const k of ["Control", "Meta", "Alt", "Shift"]) expect(comboCandidates(ev(k), true)).toEqual([]);
  });

  it("keeps Alt and Shift in a fixed order, so a table can be written by hand", () => {
    expect(comboCandidates(ev("F1", { altKey: true, shiftKey: true }), true)).toEqual(["alt+shift+f1"]);
    expect(comboCandidates(ev("x", { metaKey: true, shiftKey: true }), true)).toEqual(["mod+shift+x"]);
  });
});

describe("matching a press against the table", () => {
  const hits: string[] = [];
  const bindings: Binding[] = [
    { combo: "ctrl+1", label: "foreground 1", group: "Colour", run: () => hits.push("fg1") },
    { combo: "mod+1", label: "something else", group: "View", run: () => hits.push("mod1") },
    { combo: ["mod+=", "]"], label: "grow", group: "Brush", run: () => hits.push("grow") },
    { combo: "escape", label: "deselect", group: "Select", when: () => false, run: () => hits.push("never") },
  ];
  const index = indexBindings(bindings);

  it("prefers the Ctrl meaning over the menu one where they collide", () => {
    expect(lookup(index, ev("1", { ctrlKey: true }), false)?.label).toBe("foreground 1");
    expect(lookup(index, ev("1", { ctrlKey: true }), true)?.label).toBe("foreground 1");
  });

  it("finds a binding by any of its keys", () => {
    expect(lookup(index, ev("]"), true)?.label).toBe("grow");
    expect(lookup(index, ev("=", { metaKey: true }), true)?.label).toBe("grow");
    expect(lookup(index, ev("=", { ctrlKey: true }), false)?.label).toBe("grow");
  });

  it("skips a binding whose `when` says no, rather than swallowing the key", () => {
    expect(lookup(index, ev("Escape"), true)).toBeNull();
  });

  it("returns null for a key nothing claims", () => {
    expect(lookup(index, ev("j"), true)).toBeNull();
  });
});

describe("writing a combo out for the shortcut sheet", () => {
  it("uses the Mac symbols in the Mac order", () => {
    expect(comboLabel("mod+shift+x", true)).toBe("⇧⌘X");
    expect(comboLabel("ctrl+1", true)).toBe("⌃1");
    expect(comboLabel("alt+shift+f1", true)).toBe("⌥⇧F1");
    expect(comboLabel("ctrl+arrowup", true)).toBe("⌃Up");
  });

  it("spells them out elsewhere, where Cmd and Ctrl are one key", () => {
    expect(comboLabel("mod+shift+x", false)).toBe("Ctrl+Shift+X");
    expect(comboLabel("ctrl+1", false)).toBe("Ctrl+1");
    expect(comboLabel("escape", false)).toBe("Escape");
  });
});
