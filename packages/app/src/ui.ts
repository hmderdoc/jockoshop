import { CP437_UNICODE, type Color, cp437Encode, isRgb, toRgb } from "@killerdraw/core";

type Child = Node | string | null | undefined | false;

/** Tiny DOM builder: h("button.primary", { onclick }, "Save") */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}`, props: Record<string, unknown> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag) as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className += ` ${v}`;
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const COLOR_NAMES = [
  "black", "blue", "green", "cyan", "red", "magenta", "brown", "light grey",
  "dark grey", "light blue", "light green", "light cyan", "light red", "light magenta", "yellow", "white",
];

export function cssColor(c: Color, palette: readonly (readonly [number, number, number])[]): string {
  const [r, g, b] = toRgb(c, palette);
  return `rgb(${r},${g},${b})`;
}

export function colorName(c: Color): string {
  if (isRgb(c)) { const [r, g, b] = toRgb(c); return `rgb ${r},${g},${b}`; }
  return COLOR_NAMES[c];
}

/** "A", "█ 219" — how a glyph is written in the UI. */
export function glyphLabel(code: number): string {
  const ch = String.fromCodePoint(CP437_UNICODE[code]);
  return code > 32 && code < 127 ? ch : `${code === 0 || code === 32 || code === 255 ? "␣" : ch} ${code}`;
}

/**
 * One character means that character ("5" is the digit five); anything longer
 * must be a CP437 code, "219" or "#219" ("#5" for codes below 10).
 */
export function parseGlyph(text: string): number | null {
  if ([...text].length === 1) return cp437Encode(text)[0];
  const m = /^#?(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 255 ? n : null;
}

/**
 * A <select> over the 16 colours, with optional leading special choices
 * (e.g. "any", "keep", "see-through") whose value is a string key.
 */
export function colorSelect(
  value: Color | string, specials: [string, string][], onchange: (v: Color | string) => void,
): HTMLSelectElement {
  const sel = h("select", { onchange: () => onchange(/^\d+$/.test(sel.value) ? Number(sel.value) : sel.value) });
  for (const [key, label] of specials) sel.append(h("option", { value: key }, label));
  COLOR_NAMES.forEach((n, i) => sel.append(h("option", { value: String(i) }, `${i} ${n}`)));
  if (typeof value === "number" && isRgb(value)) sel.append(h("option", { value: String(value) }, colorName(value)));
  sel.value = String(value);
  return sel;
}

/**
 * A number field with its own spin buttons: hold one and it repeats, faster the
 * longer it is held — the same on every platform, unlike native spinners.
 * `oncommit` fires once when a change is complete (stepping paused, Enter, or
 * blur); with `onlive`, every step also fires `onlive`, for values that should
 * follow the buttons as they are held. Returns the wrapper; `.input` is the field.
 */
export function numberInput(value: number | undefined, opts: { min?: number; max?: number; placeholder?: string; width?: number },
  oncommit: (v: number | undefined) => void, onlive?: (v: number | undefined) => void): HTMLElement & { input: HTMLInputElement } {
  let committed = value, timer = 0, held = false;
  const read = (): number | undefined | null => {
    if (input.value === "") return undefined;
    let v = Math.round(Number(input.value));
    if (Number.isNaN(v)) return null;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    return v;
  };
  const commit = (): void => {
    clearTimeout(timer);
    timer = 0;
    const v = read();
    if (v === null || v === committed) return;
    committed = v;
    oncommit(v);
  };
  const changed = (): void => {
    const v = read();
    if (v !== null && onlive) onlive(v);
    clearTimeout(timer);
    if (!held) timer = window.setTimeout(commit, 350);   // a held spin button commits on release instead
  };
  const step = (dir: 1 | -1): void => {
    const cur = read();
    let v = (cur === undefined || cur === null ? 0 : cur) + dir;
    if (opts.min !== undefined) v = Math.max(opts.min, v);
    if (opts.max !== undefined) v = Math.min(opts.max, v);
    input.value = String(v);
    changed();
  };
  const input = h("input", {
    type: "number", value: value === undefined ? "" : String(value), min: opts.min, max: opts.max,
    placeholder: opts.placeholder ?? "", style: `width:${opts.width ?? 58}px`,
    oninput: changed,
    onchange: changed,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") commit();
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); step(e.key === "ArrowUp" ? 1 : -1); }
    },
    onblur: commit,
  });
  // hold to repeat: 400 ms, then every 80 ms, then every 30 ms after a second
  const spin = (dir: 1 | -1): HTMLButtonElement => {
    let hold = 0, started = 0;
    const stop = (): void => { clearTimeout(hold); hold = 0; held = false; if (started) { started = 0; commit(); } };
    const tick = (): void => { step(dir); hold = window.setTimeout(tick, performance.now() - started > 1000 ? 30 : 80); };
    return h("button.spin", {
      tabindex: -1, title: dir > 0 ? "Increase — hold to repeat" : "Decrease — hold to repeat",
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        started = performance.now();
        held = true;
        step(dir);
        hold = window.setTimeout(tick, 400);
        const done = (): void => { stop(); window.removeEventListener("pointerup", done); window.removeEventListener("pointercancel", done); };
        window.addEventListener("pointerup", done);
        window.addEventListener("pointercancel", done);
      },
    }, dir > 0 ? "▴" : "▾");
  };
  const wrap = h("span.num", {}, input, h("span.spins", {}, spin(1), spin(-1))) as HTMLElement & { input: HTMLInputElement };
  wrap.input = input;
  return wrap;
}

export function field(label: string, ...controls: Child[]): HTMLElement {
  return h("label.field", {}, h("span", {}, label), ...controls);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept });
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Hand the user a file. In the desktop shell (or a browser with the File System Access API) this is a Save As dialog; elsewhere, a download. */
export function download(name: string, bytes: Uint8Array, type = "application/octet-stream"): void {
  const ext = name.replace(/^.*\./, "");
  if ("__TAURI_INTERNALS__" in window) {
    void (async () => {
      const [{ save }, { invoke }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/api/core")]);
      const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (path) await invoke("write_file", { path, data: Array.from(bytes) });
    })();
    return;
  }
  if ("showSaveFilePicker" in window) {
    const picker = window.showSaveFilePicker as (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
    void (async () => {
      let handle: FileSystemFileHandle;
      try { handle = await picker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [type]: [`.${ext}`] } }] }); }
      catch (err) { if (err instanceof DOMException && err.name === "AbortError") return; throw err; }
      const w = await handle.createWritable();
      await w.write(bytes as BufferSource);
      await w.close();
    })();
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
