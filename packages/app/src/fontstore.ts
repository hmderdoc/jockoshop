/**
 * The bitmap font a document is drawn in.
 *
 * A piece of ANSI art says which font it wants in one of two ways: it carries
 * the bitmap itself (XBIN, ArtWorx .adf, ICE Draw .idf), or its SAUCE record
 * names one (`IBM VGA50`, `Amiga Topaz 1`, …). An embedded font wins — it is
 * the art's own — and a name we do not have is not an error: the name is kept
 * so an export still records what the art asks for, and the picture is drawn
 * in IBM VGA with a note saying which font is missing.
 */
import {
  type BitmapFont, EMBEDDED_FONT_ASSET, type KdDocument, parseRawFont, resolveFontName,
} from "@killerdraw/core";

/** Where the served font files live, relative to the app root. */
const DIR = "fonts";

export interface DocumentFont {
  font: BitmapFont;
  /** what to tell the artist, when the font is not the one the document named */
  note?: string;
}

export class FontStore {
  private readonly cache = new Map<string, BitmapFont>();
  private readonly inFlight = new Map<string, Promise<BitmapFont>>();

  /** IBM VGA: always loaded, and what everything falls back to. */
  constructor(readonly fallback: BitmapFont) {}

  /** Load one of the standard fonts by its path in the font table. */
  load(file: string): Promise<BitmapFont> {
    const have = this.cache.get(file);
    if (have) return Promise.resolve(have);
    let job = this.inFlight.get(file);
    if (!job) {
      // the file names are upstream's, so they hold spaces and apostrophes
      const url = `${DIR}/${file.split("/").map(encodeURIComponent).join("/")}`;
      job = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
        .then((b) => {
          const font = parseRawFont(new Uint8Array(b));
          this.cache.set(file, font);
          return font;
        })
        .finally(() => this.inFlight.delete(file));
      this.inFlight.set(file, job);
    }
    return job;
  }

  /**
   * The font to draw `doc` in. Embedded bitmap first, then the named font,
   * then IBM VGA.
   */
  async forDocument(doc: KdDocument): Promise<DocumentFont> {
    const embedded = doc.assets.get(EMBEDDED_FONT_ASSET);
    if (embedded) {
      try {
        return { font: parseRawFont(embedded), note: `Drawing in the font embedded in this file (${embedded.length / 256} rows per cell).` };
      } catch (err) {
        return { font: this.fallback, note: `This file carries a font jockoshop could not read (${(err as Error).message}); drawing in IBM VGA.` };
      }
    }
    const { font: wanted, known } = resolveFontName(doc.fontName);
    try {
      const font = await this.load(wanted.file);
      return known ? { font } : { font, note: `“${doc.fontName}” is not a font jockoshop has; drawing in ${wanted.name}. The name is kept, so exports still ask for it.` };
    } catch (err) {
      return { font: this.fallback, note: `Could not load ${wanted.name} (${(err as Error).message}); drawing in IBM VGA.` };
    }
  }

  /**
   * What identifies the font a document wants, so a caller can tell whether
   * anything actually changed before refetching.
   */
  static key(doc: KdDocument): string {
    const embedded = doc.assets.get(EMBEDDED_FONT_ASSET);
    return embedded ? `embedded:${embedded.length}:${embedded[0]}:${embedded[embedded.length - 1]}` : `name:${doc.fontName}`;
  }
}
