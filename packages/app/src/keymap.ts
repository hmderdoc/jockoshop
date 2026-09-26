/**
 * Keyboard shortcuts as data.
 *
 * Artists who draw with keys keep a hand on the keyboard and never reach for a
 * swatch, so the bindings that matter most — colours, character sets, brush
 * size — follow Moebius, which is what they already have in their fingers.
 * Where jockoshop has something Moebius does not, it keeps its own key.
 *
 * One table drives both the handler and the shortcut sheet, so the sheet
 * cannot drift from what the keys actually do.
 */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export interface Binding {
  /** one combo, or several that all do the same thing */
  combo: string | string[];
  /** what it does, for the shortcut sheet */
  label: string;
  group: string;
  /** true when this is the key Moebius uses, so the sheet can say so */
  moebius?: boolean;
  /** skip the binding (and grey it in the sheet) when this is false */
  when?: () => boolean;
  run(e: KeyboardEvent): void;
  /** leave the browser's own behaviour alone (default: prevent it) */
  passive?: boolean;
}

/** The name this event's key goes by in a combo: "a", "5", "f3", "arrowup", "escape", ",". */
function keyName(e: KeyboardEvent): string {
  const k = e.key;
  if (k === " ") return "space";
  if (/^F\d+$/.test(k)) return k.toLowerCase();
  if (k.length === 1) return k.toLowerCase();
  return k.toLowerCase();
}

/**
 * The combos an event could match, best first.
 *
 * `mod` is Cmd on a Mac and Ctrl everywhere else, the way menu accelerators
 * work. Moebius also uses plain Ctrl for colours and character sets, which on a
 * Mac is a different key from Cmd but on Windows is the same one — so there a
 * Ctrl press offers `ctrl+…` first and `mod+…` second, and a binding like
 * Ctrl+0 (foreground black) wins over one like Cmd+0 (zoom to fit), exactly as
 * it does in Moebius. Zoom keeps a `mod+alt+0` of its own for that reason.
 */
export function comboCandidates(e: KeyboardEvent, isMac = IS_MAC): string[] {
  const name = keyName(e);
  if (name === "control" || name === "meta" || name === "alt" || name === "shift") return [];
  const tail = `${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${name}`;
  const out: string[] = [];
  const isMod = isMac ? e.metaKey : e.ctrlKey;
  if (e.ctrlKey && (isMac || !e.metaKey)) out.push(`ctrl+${tail}`);
  if (isMod) out.push(`mod+${tail}`);
  if (!e.ctrlKey && !e.metaKey) out.push(tail);
  return out;
}

/** Index a table for lookup; later entries do not overwrite earlier ones. */
export function indexBindings(bindings: readonly Binding[]): Map<string, Binding> {
  const map = new Map<string, Binding>();
  for (const b of bindings) {
    for (const c of Array.isArray(b.combo) ? b.combo : [b.combo]) if (!map.has(c)) map.set(c, b);
  }
  return map;
}

/** The binding an event fires, or null. */
export function lookup(index: Map<string, Binding>, e: KeyboardEvent, isMac?: boolean): Binding | null {
  for (const c of comboCandidates(e, isMac)) {
    const b = index.get(c);
    if (b && (!b.when || b.when())) return b;
  }
  return null;
}

/** A combo written the way a person reads it: "⌘⇧X" on a Mac, "Ctrl+Shift+X" elsewhere. */
export function comboLabel(combo: string, isMac = IS_MAC): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const has = (m: string): boolean => parts.includes(m);
  const pretty = key.length === 1
    ? key.toUpperCase()
    : key.replace(/^f(\d+)$/, "F$1").replace(/^arrow/, "").replace(/^(.)/, (c) => c.toUpperCase());
  if (isMac) {
    return `${has("ctrl") ? "⌃" : ""}${has("alt") ? "⌥" : ""}${has("shift") ? "⇧" : ""}${has("mod") ? "⌘" : ""}${pretty}`;
  }
  const mods = [has("mod") || has("ctrl") ? "Ctrl" : "", has("alt") ? "Alt" : "", has("shift") ? "Shift" : ""].filter(Boolean);
  return [...mods, pretty].join("+");
}
