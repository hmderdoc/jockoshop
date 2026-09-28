import { type Color, type Rgb, VGA_PALETTE } from "./color.js";
import { CellGrid } from "./grid.js";
import type { AspectRatio } from "./formats/sauce.js";
import type { ContourOptions } from "./contour.js";
import type { ImageMatte } from "./matte.js";
import type { CellMatch } from "./match.js";
import type { Sauce } from "./formats/sauce.js";

/**
 * Filters matching cells out of a layer at composite time so the layers below
 * show through. The cells stay in the layer; disabling the rule restores them.
 */
export interface KeyRule {
  match: CellMatch;
  /** what becomes transparent where the rule matches */
  drop: "cell" | "glyph" | "fg" | "bg";
  enabled: boolean;
}

/**
 * Hides part of a layer without changing its cells. In the layer's own
 * coordinates, so it moves with the layer; cells outside it are hidden.
 */
export interface LayerMask {
  width: number;
  height: number;
  /** 1 = the layer shows here */
  data: Uint8Array;
  enabled: boolean;
}

interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** position of the layer's grid origin in document cells */
  x: number;
  y: number;
  keys: KeyRule[];
  mask?: LayerMask;
  /** palette swap: 16 entries, palette colour i is shown as remap[i] (see remap.ts) */
  remap?: number[];
  /**
   * 0-1; undefined = 1. Text cells cannot be half-transparent, so a translucent
   * layer is blended as pixels and its cells re-matched through shadeans by
   * the app — its cells stop being the ones drawn. Opt-in per layer for that reason.
   */
  opacity?: number;
  /**
   * Whether prose layers flow around this layer's content. undefined = auto:
   * a layer that covers most of a prose frame is a background and is flowed
   * over; anything smaller is an obstacle.
   */
  textWrap?: "always" | "never";
  /**
   * 3dBBS depth in centi-world-units relative to the screen: 0 (or undefined) =
   * at the screen, negative = behind it, positive = in front. See depth.ts.
   */
  depth?: number;
  /**
   * "remote": the layer other people's cells land in while joined to a
   * collaboration server (see joint/sync.ts). A marker, not a kind of layer —
   * it is an ordinary layer that the joint client recognises again after a
   * save and reload, and that the app tags in the layer list.
   */
  joint?: "remote";
}

/** Hand-drawn cells: the grid is the source of truth. */
export interface CellsLayer extends LayerBase {
  type: "cells";
  grid: CellGrid;
}

export interface FontRun {
  /** asset path of the .tdf, e.g. "assets/fonts/COOLFONT.TDF" */
  font: string;
  /** index of the font within a multi-font .tdf */
  fontIndex: number;
  text: string;
}

/** Live TheDraw text: `cache` is regenerated from the recipe (see fontlayer.ts). */
export interface FontLayer extends LayerBase {
  type: "font";
  /** consecutive runs form one text; a new run is a font switch mid-string. "\n" breaks lines. */
  runs: FontRun[];
  /** wrap at this many cells; undefined = never wrap */
  wrapWidth?: number;
  /** added to each font's own letter spacing */
  spacing: number;
  lineGap: number;
  spaceWidth: number;
  /** ink for outline and block fonts */
  fg: Color;
  /** background behind the letters; null = see-through */
  bg: Color | null;
  cache?: CellGrid;
}

/** shadeans' conversion settings; names follow its command-line options. */
export interface ShadeansOptions {
  /** how visible dither texture is: 1 = pixel art, lower = more and bolder shading */
  lambda: number;
  /** pixel-art baseline: no shade characters */
  blocks: boolean;
  /**
   * ASCII only: match against printable 32-126 and nothing else, on one
   * background for the whole picture. Not a shadeans setting — shadeans is
   * built around CP437's ░▒▓█, so this routes the layer through the font
   * matcher instead, whatever font the document is in.
   */
  ascii?: boolean;
  /**
   * The one background an ASCII picture sits on; undefined = black, which is
   * what ASCII art is. It is worth choosing rather than assuming: printable
   * ASCII reaches only 39% ink, so on black a bright photograph has nowhere to
   * go and comes back as a solid wall of the densest letters. Putting it on a
   * light ground turns the same picture into dark strokes on white.
   */
  asciiBg?: number;
  /**
   * One ink for the whole picture; undefined = take each cell's colour from
   * the image. Set, the characters carry the picture by themselves, which is
   * what a plain-text piece is — and what survives being saved as `.txt` or
   * pasted somewhere with no colour at all.
   */
  asciiInk?: number;
  /**
   * Draw the picture's edges as strokes instead of matching its tone — what
   * hand-drawn ASCII actually does. Set = on; see ContourOptions. Only means
   * anything with `ascii`, since the stroke alphabet is ASCII.
   */
  contour?: ContourOptions;
  /** pulls neighbouring cells onto shared colours (0 = off, 0.006 = flat) */
  coherence: number;
  sweeps: number;
  /** 24-bit colour per cell instead of the 16-colour palette */
  truecolor: boolean;
  autoLevels: boolean;
  /** undefined = shadeans' default for the colour mode */
  autoChroma?: number;
  equalize: number;
  /** undefined = shadeans' default for the colour mode */
  localContrast?: number;
  contrast: number;
  saturation: number;
  smooth: number;
}

/** A source image plus conversion settings: `cache` is regenerated by shadeans. */
export interface ImageLayer extends LayerBase {
  type: "image";
  /** asset path of the untouched source image */
  source: string;
  /** part of the source to convert, in source pixels; undefined = all of it */
  crop?: { x: number; y: number; width: number; height: number };
  cols: number;
  /** 0 = follow the image's aspect ratio */
  rows: number;
  options: ShadeansOptions;
  /** cut a background out of the source before matching it; undefined = keep all of it */
  matte?: ImageMatte;
  cache?: CellGrid;
}

/**
 * Reflowing prose: a word processor's text in a frame of cells. `text` holds
 * paragraphs separated by "\n"; `fg`/`bg` are per character (bg -1 = see-through).
 * With `flowAround`, cells that other layers occupy inside the frame are
 * obstacles the text wraps around. `cache` is regenerated by prose.ts.
 */
export interface ProseLayer extends LayerBase {
  type: "prose";
  text: string;
  fg: number[];
  bg: number[];
  /** frame size in cells; the layer's x/y is its top-left */
  width: number;
  height: number;
  flowAround: boolean;
  /** gaps between obstacles narrower than this are not written into */
  minGap: number;
  align: "left" | "center" | "right";
  cache?: CellGrid;
}

/**
 * A reference image: shown on the canvas to draw from, at a chosen size and
 * opacity, but never part of the picture — it is not composited or exported.
 */
export interface ReferenceLayer extends LayerBase {
  type: "reference";
  /** asset path of the image */
  source: string;
  /** size in cells; the layer's x/y is its top-left */
  width: number;
  height: number;
  /** 0-1 */
  opacity: number;
}

export interface GroupLayer {
  type: "group";
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** bottom first */
  children: Layer[];
}

/**
 * A live line, rectangle or ellipse: re-rendered from its parameters, so it
 * can be restyled and resized after the fact. `cache` is regenerated by shapelayer.ts.
 */
export interface ShapeLayer extends LayerBase {
  type: "shape";
  kind: "line" | "rect" | "ellipse";
  /** the box the shape fits, in cells; the layer's x/y is its top-left */
  width: number;
  height: number;
  /** a line runs from the top-left corner to the bottom-right; flipped, from the top-right to the bottom-left */
  flip: boolean;
  /** what the outline is made of; an ellipse renders the box-drawing styles as the character */
  style: "char" | "half" | "single" | "double";
  fill: "none" | "color" | "char";
  glyph: number;
  fg: Color;
  /** null = see-through */
  bg: Color | null;
  cache?: CellGrid;
}

export type ContentLayer = CellsLayer | FontLayer | ImageLayer | ProseLayer | ReferenceLayer | ShapeLayer;
export type Layer = ContentLayer | GroupLayer;

export interface KdDocument {
  width: number;
  height: number;
  /** on: background 8-15 is a bright colour. off: it means blink. */
  iceColors: boolean;
  letterSpacing9px: boolean;
  /**
   * The piece is ASCII: printable 32-126 only, no blocks, no shade ramp, no
   * line drawing. Optional so projects written before it still open.
   *
   * It is a constraint, not a filter — nothing already drawn is altered or
   * thrown away. It keeps the characters out of the places new ones come from,
   * counts whatever is already outside it so it can be found, and puts image
   * layers into ASCII mode.
   */
  asciiOnly?: boolean;
  /**
   * What the art's pixels were meant to be shaped like, as SAUCE records it.
   * "stretch" = drawn for a 4:3 CRT, so it wants stretching vertically to look
   * right on square pixels; "square" = drawn for square pixels already;
   * "none" = the file says nothing, so it is shown as it is.
   */
  aspectRatio: AspectRatio;
  fontName: string;
  palette: Rgb[];
  sauce: Sauce;
  /** bottom first */
  layers: Layer[];
  /** embedded files (source images, .tdf fonts, meshes) keyed by archive path */
  assets: Map<string, Uint8Array>;
}

let nextId = 1;
export function newLayerId(): string {
  return `L${(nextId++).toString(36)}${Math.floor(Math.random() * 0x100000).toString(36)}`;
}

export function createCellsLayer(name: string, width: number, height: number): CellsLayer {
  return {
    type: "cells", id: newLayerId(), name, visible: true, locked: false,
    x: 0, y: 0, keys: [], grid: new CellGrid(width, height),
  };
}

export function createDocument(width = 80, height = 25): KdDocument {
  return {
    width, height,
    iceColors: false,
    letterSpacing9px: false,
    aspectRatio: "none",
    fontName: "IBM VGA",
    palette: VGA_PALETTE.map((c) => [c[0], c[1], c[2]] as const),
    sauce: { title: "", author: "", group: "", date: "", comments: [] },
    layers: [createCellsLayer("Layer 1", width, height)],
    assets: new Map(),
  };
}

/** The cells a layer currently contributes, or undefined (a reference layer, or a cache not built yet). */
export function layerGrid(layer: ContentLayer): CellGrid | undefined {
  return layer.type === "cells" ? layer.grid : layer.type === "reference" ? undefined : layer.cache;
}

/** The layer's footprint in cells, for handles and outlines. */
export function layerSize(layer: ContentLayer): { width: number; height: number } | null {
  if (layer.type === "reference" || layer.type === "shape") return { width: layer.width, height: layer.height };
  const g = layerGrid(layer);
  return g ? { width: g.width, height: g.height } : null;
}

/** Visible content layers, bottom first, with groups flattened. */
export function visibleLayers(layers: readonly Layer[], out: ContentLayer[] = []): ContentLayer[] {
  for (const l of layers) {
    if (!l.visible) continue;
    if (l.type === "group") visibleLayers(l.children, out);
    else out.push(l);
  }
  return out;
}

export function findLayer(layers: readonly Layer[], id: string): Layer | undefined {
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.type === "group") {
      const hit = findLayer(l.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * An independent copy with new ids: cells, recipe, key rules and mask are all
 * copied, and a group's children are copied with it. Embedded assets are
 * shared, since they are never modified.
 */
/** Deep copy of plain JSON-shaped data (key rules, font runs). No platform API, so the core stays portable. */
function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneLayer(layer: Layer, name = `${layer.name} copy`): Layer {
  if (layer.type === "group") return { ...layer, id: newLayerId(), name, children: layer.children.map((c) => cloneLayer(c, c.name)) };
  const { mask, ...rest } = layer;
  const base = {
    id: newLayerId(), name,
    keys: cloneData(layer.keys),
    ...(layer.remap ? { remap: [...layer.remap] } : {}),
    ...(mask ? { mask: { ...mask, data: mask.data.slice() } } : {}),
  };
  if (rest.type === "cells") return { ...rest, ...base, grid: rest.grid.clone() };
  if (rest.type === "font") return { ...rest, ...base, runs: cloneData(rest.runs), cache: rest.cache?.clone() };
  if (rest.type === "prose") return { ...rest, ...base, fg: [...rest.fg], bg: [...rest.bg], cache: rest.cache?.clone() };
  if (rest.type === "reference") return { ...rest, ...base };
  if (rest.type === "shape") return { ...rest, ...base, cache: rest.cache?.clone() };
  return { ...rest, ...base, options: { ...rest.options }, crop: rest.crop && { ...rest.crop }, matte: rest.matte && { ...rest.matte }, cache: rest.cache?.clone() };
}
