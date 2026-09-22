import { type FontLayer, type KdDocument, newLayerId } from "./document.js";
import { type StyledChar, type TdfFont, layoutTdf, parseTdf, renderTdf } from "./tdf.js";

const parsed = new WeakMap<Uint8Array, TdfFont[]>();

/** The parsed fonts of an embedded .tdf asset (parsed once per asset). */
export function fontsOfAsset(doc: KdDocument, path: string): TdfFont[] {
  const bytes = doc.assets.get(path);
  if (!bytes) throw new Error(`font asset not in document: ${path}`);
  let fonts = parsed.get(bytes);
  if (!fonts) { fonts = parseTdf(bytes); parsed.set(bytes, fonts); }
  return fonts;
}

/** Embed a .tdf in the document (once) and return its asset path. */
export function addFontAsset(doc: KdDocument, fileName: string, bytes: Uint8Array): string {
  const path = `assets/fonts/${fileName.replace(/^.*[\\/]/, "")}`;
  if (!doc.assets.has(path)) { parseTdf(bytes); doc.assets.set(path, bytes); }
  return path;
}

export function createFontLayer(name: string, font: string, text: string, fontIndex = 0): FontLayer {
  return {
    type: "font", id: newLayerId(), name, visible: true, locked: false, x: 0, y: 0, keys: [],
    runs: [{ font, fontIndex, text }], spacing: 0, lineGap: 1, spaceWidth: 3, fg: 7, bg: null,
  };
}

/** Regenerate a font layer's cells from its recipe. Call after any change to the recipe. */
export function refreshFontLayer(doc: KdDocument, layer: FontLayer): void {
  const text: StyledChar[] = [];
  let first: TdfFont | undefined;
  for (const run of layer.runs) {
    const fonts = fontsOfAsset(doc, run.font);
    const font = fonts[Math.min(run.fontIndex, fonts.length - 1)];
    first ??= font;
    for (const ch of run.text) text.push({ ch, font });
  }
  if (!first) { layer.cache = undefined; return; }
  const metrics = { lineGap: layer.lineGap, extraSpacing: layer.spacing, spaceWidth: layer.spaceWidth };
  const layout = layoutTdf(text, layer.wrapWidth ?? Infinity, metrics, first);
  layer.cache = renderTdf(text, layout, { fg: layer.fg, bg: layer.bg });
}
