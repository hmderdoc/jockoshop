# jockoshop — design

A layered, non-destructive ANSI art editor. The project file stores the
*recipe* for a picture (hand-drawn cells, live TheDraw text, source images plus
conversion settings, depth) and regenerates the cells; `.ans` is an export,
the way `.png` is an export of a `.psd`.

Status (2026-09-21): the core and a working editor exist — cells, live TheDraw
text and live shadeans image layers, key rules, find & replace, project files.
§9 lists what is done and what is not.

## 1. Reference points

| Project | Role | Facts that shape the design |
|---|---|---|
| [Moebius](https://github.com/blocktronics/moebius) | Feature baseline | Electron. The document is one flat array of `{code, fg, bg}`; no layers. Tools: half-block brush, shade/char/colorize brushes, line, rectangle, ellipse, fill, sample, select (flip/rotate), shifter, crop, mirror mode, reference-image overlay, iCE, 9px fonts, SAUCE, ANS/BIN/XBIN, PNG + UTF-8 export, undo, collaboration server. |
| [shadeans](https://github.com/hmderdoc/shadeans) | Image conversion | Rust, `image` crate only. `convert(src, cols, rows, palette, opts) -> Vec<Cell>`; matching is a few ms at 80 columns, so conversion can be live. Binary crate only — no `lib.rs` yet. |
| [3dBBS](https://github.com/hmderdoc/3dBBS) | 3D target | Text depth layers: `CSI = Ps z` (layer 0–15), `CSI = Ps ; Pd * z` (depth 0–1800). One grid: a cell has exactly one depth tag. Mesh scene: 16 slots, 32 objects, vertex-coloured 3DM1, always behind text, black-background cells transparent to it. |
| HERMedIT | Code to reuse | TypeScript `tdf.ts`, `cp437.ts`, `attr.ts`, `shapes.ts`. 1,071 `.tdf` fonts ship with Synchronet (`ctrl/tdfonts`, also in the Synchronet GitHub repo). |

## 2. Stack

- **TypeScript** for everything except image matching.
- **shadeans compiled to WASM**, not ported. The algorithm is still changing
  (0.3.0), and `prepare()` depends on the `image` crate's CatmullRom resampler
  in linear light; a port would be a second implementation to keep in step.
  With WASM the CLI and the editor give identical output from one source.
  Done without touching shadeans: `packages/shadeans-wasm` is a small C-ABI
  crate that compiles shadeans' source files in by `#[path]` from a pinned
  commit, with only `image`'s resize (the browser decodes the file; no codecs).
  Measured: 71 KB module; rendered output is pixel-identical to the native CLI
  on the same image in 16-colour, iCE/132-column and 24-bit modes; an 80-column
  conversion takes 20-140 ms in Node and ~70 ms in Chrome, so sliders are live.
  If shadeans gains a `lib.rs` this crate can depend on it normally instead.
- Web-first UI on canvas 2D. Desktop shell: **Tauri 2** (`packages/desktop`), chosen over Electron for size
  (7 MB app vs ~150 MB) and because Rust is already in the toolchain. The app talks to it through one small
  interface (`app/src/io.ts`: open, save, save-as, read-by-path, open requests, close guard, title) with a
  browser implementation behind the same interface, so the web build is unchanged. File reads/writes are
  Tauri commands (no fs-plugin scope to fight); dialogs come from the dialog plugin; writes go to a temp file
  then rename. **(unverified)**: Windows and Linux builds — only macOS (arm64) has been built and run.
- The core has no DOM dependency, so it runs headless in Node (CLI export,
  tests) and could later be lowered to ES5 for Synchronet.

```
packages/core           model, compositor, matcher, undo, formats, tdf, export profiles
packages/shadeans-wasm  wasm-bindgen wrapper around the shadeans library
packages/app            renderer, tools, panels
packages/cli            headless open / render / export
```

## 3. Document model

A document has a size in cells, a font (8x16 raw bitmap, 8px or 9px), a
palette, a target profile, SAUCE fields, and an ordered tree of layers and
groups.

Every layer has: name, visible, locked, offset (layers keep content outside
the canvas when moved), optional mask, **key rules** (§5), optional depth
(0–1800), and its type-specific recipe.

| Type | Stores | Regenerated when |
|---|---|---|
| **Cells** | Sparse hand-drawn cells | never — it is the source |
| **Font** | String, font runs (mid-string font switches), colours, anchor, wrap width, spacing | text, font, style or position changes |
| **Prose** | Text with hard breaks, per-character colours, a frame, flow-around on/off, min gap, alignment | text, frame or anything under a flow-around frame changes (HERMedIT's paragraph model, generalised from box interiors to arbitrary free spans per row) |
| **Image** | Embedded source image, crop/scale/offset, full shadeans options | any of those change |
| **Mesh** (later) | 3DM1 mesh (or OBJ source), placement from 3D-AUTHORING §2 cell→world math, spin | placement changes |

Any layer can be rasterized to a Cells layer. Generated layers cache their
cells; the cache is never the source of truth.

### Cells

```
glyph   u8        CP437 code
fg, bg  Color     palette index 0–15, or 24-bit RGB
present bits      glyph | fg | bg — each channel may be absent ("inherit")
```

Stored per layer as typed arrays. A cell that was never painted has no
channels present.

## 4. Compositing

Bottom-up per cell, onto a base of space / light grey / black. Implemented in
`packages/core/src/composite.ts`; what an absent channel means:

| Upper-layer cell | Result |
|---|---|
| nothing present, or keyed out | skipped |
| half block (`▀▄▌▐`) missing one colour | that half is see-through. If the cell below divides on the same axis the halves merge exactly (`▀` over `▄` becomes one two-colour cell); otherwise the rule for "glyph, no bg" applies |
| space (or NUL/255) with no bg | skipped — nothing of it is visible |
| glyph, no bg | the glyph sits on the colour the stack below *appears* to be: a `█` region counts as its foreground colour |
| glyph, no fg | ink takes the foreground below |
| no glyph | recolours what is below (a colour-wash layer) |

- Under a two-colour cell (e.g. `░` red on green) the inherited background is
  the literal background by default; `inheritBg: "dominant"` takes whichever
  colour covers more of the cell, from the font's coverage. Both exist so the
  choice can be judged on screen.
- With iCE off a background of 8-15 means blink, so a background the compositor
  derives is dimmed to 0-7, and a merged half block is flipped (`▀`/`▄`) when
  that keeps the bright colour in the foreground.
- Each output cell records its owner: the layer that supplied the glyph (used
  for depth export).
- Dirty-rect updates: measured 2.9 ms for a full 80x200, 5-layer recomposite
  and 0.01 ms for an 8x4 rect (Node 20, M-series).
- **Opacity by re-matching** (later, opt-in per layer): render the stack to
  8x16 pixels, alpha-blend, re-match through the shadeans scorer. Opt-in
  because it rewrites hand-placed glyphs.
- **Masks**: a per-layer bitmap in layer coordinates (so it moves with the layer), made from a selection;
  masked cells are skipped. Stored as `layers/<id>.mask.bin`.
- **Palette swap**: a per-layer 16-entry remap applied to palette colours after key rules (which keep
  matching the stored colours); 24-bit colours pass through.

## 5. Cell matcher, key rules, find & replace

One matcher drives three features.

```
CellMatch {
  glyph?:  any | oneOf [codes] | not [codes]
  fg?:     any | oneOf [colors] | not [colors]
  bg?:     any | oneOf [colors] | not [colors]
  appearsSolid?: color     // matches by rendered look, not literal values
}
```

`appearsSolid: black` catches every way a cell can be "empty": space on black,
NUL or 255 on black, any glyph with fg = bg = black, `█` with black foreground.
A literal match such as `glyph ',' fg yellow bg blue` is equally valid.

**Key rules** — a layer holds a list of `{ match, drop: cell | glyph | fg | bg, enabled }`.
At composite time, matching cells (or just the named channel) are treated as
absent, so the layer below shows through. Non-destructive: the cells stay in
the layer, and disabling the rule brings them back. An imported `.ans` dropped
in as an upper layer gets a suggested `appearsSolid: black` rule.

**Find & replace** — same matcher plus a replacement where each channel is
either a new value or "keep". Scope: selection, layer, or all layers. Applies
to Cells layers; on a generated layer it offers to rasterize first.

**Select by match** — the matcher as a selection tool (every yellow-on-blue
comma becomes the selection).

## 6. Editor baseline (Moebius parity)

Half-block brush, shade/char/colorize brushes, line, rectangle, ellipse
(outline/filled), fill, sample, select with move/flip/rotate, shifter, crop,
mirror mode, reference-image overlay, F-key character sets (TheDraw/PabloDraw
convention), iCE, 8/9px, SAUCE editor, undo/redo. All tools act on the active
Cells layer. Undo is operation-based per document (cell patches and layer
property patches), which leaves room for collaboration later.

## 6a. Editor layout

Three columns, following ANSI-editor convention (Moebius) with a preview on the right.

- **Left — the tool is the entry point.** An icon palette, and under it only what that tool needs: drawing tools →
  brush / colours / characters; select tools → selection options and operations, including "mask the layer";
  Type on a text layer → its font runs and text (on a cells layer it types cells); Move → position;
  Find → find & replace. Panels with text fields are updated in place, never rebuilt while you type.
- **The tool follows the layer.** Live layers take only some tools (text: Type, Move, the select tools; image: Move
  and the select tools). Selecting a layer the current tool can't act on switches to the natural one — Type for
  text, Move for an image — while Move and the select tools carry over unchanged. Returning to a layer where the
  replaced tool works restores it, unless a tool was chosen by hand in between. Inapplicable tools are dimmed and
  refuse with the reason. With Move, double-clicking a text layer selects it, switches to Type and puts the caret
  in its text field.
- **Right — the picture and its layers.** An always-on scaled preview with the canvas viewport marked (click/drag to
  scroll; its mode switch also gives the 3D views), the layer stack, then the active layer's properties as
  collapsible panels that default to closed unless they hold something (a mask, key rules, a palette swap).
- **Icons, not labels**, for tools, file actions and layer actions: hand-drawn inline SVG (`icons.ts`), each with a
  hover tip and an `aria-label`. Explanations live in hover tips so panels stay terse.

## 7. Targets and export

Profiles: **16-colour** (blink or iCE), **truecolor** (`ESC[0;R;G;Bt` /
`ESC[1;R;G;Bt`, as shadeans and Moebius use), **3dBBS**. The editor previews
the active profile's constraints (e.g. black backgrounds become see-through to
the mesh scene under 3dBBS).

Formats: import/export ANS, BIN, XBIN with SAUCE; export PNG and UTF-8.

**Depth convention** (the editor's, matching 3dBBS's scene axes where +Z points
at the viewer): 0 = at the screen, negative = behind it, positive = in front.
The wire parameter `Pd` is an unsigned distance *behind* the glass, so export
writes `Pd = -depth`. Verified against the 3dBBS source (2026-09-22):
`termSetLayerDepth` takes `Pd / 100` world units and `scene3dTextShifts` uses
`(1/2 − 1/(2 + depth))` — the preview uses the same formula. Typical values
from fshell_ts: 300 for a backdrop, 135 for panels. Pop-out: front depths go
out as `CSI = Ps ; Pd + z`, 3dBBS protocol 0.4 (fixed in 3dBBS itself on
2026-09-22: parser, both clamps, `APC_3DS_MINOR` 4). A 0.3 client parses the
form as a layer select — harmless, an explicit `CSI = 0 z` follows — and shows
the layer at the glass.

**Depth export** flattens the stack; each surviving cell is tagged with the
depth of the layer that supplied its glyph. At most 16 distinct depths —
beyond that the exporter merges nearest depths and says so. Editor preview:
parallax or anaglyph, no 3DS required. Mesh export (APC `3DS:` + cache upload)
comes with Mesh layers.

## 8. Project file

ZIP container, JSON manifest (like `.ora`/`.kra`):

```
manifest.json      version, document settings, layer tree, recipes, key rules
layers/<id>.bin    typed-array cell data for Cells layers (+ caches, optional)
assets/images/     original source images, untouched
assets/fonts/      the .tdf fonts actually used, so the file is portable
assets/meshes/
preview.ans        flattened
preview.png
```

Extension and format name: undecided.

## 9. Work list

Order is flexible; everything here is in scope.

1. **Done** — core: model, compositor, matcher, undo, project file, ANS/BIN/XBIN/SAUCE, pixel renderer, PNG.
   The ANSI parser agrees cell-for-cell with Moebius's on real files, including shadeans 24-bit output.
2. **Mostly** — editor: canvas, layer panel (incl. duplicate), key rules, masks, palette swap, find & replace,
   selections (marquee, lasso, magic wand, select-by-match; add/subtract/intersect; fill, delete, copy, cut,
   paste-as-layer; drawing confined to the selection), pencil, half-block brush, eraser, line, rectangle, fill,
   pick-up, type, move layer, canvas resize at any edge, undo/redo, open/import/save/export.
   Also: ellipse, mirror mode (glyph-aware), F-key character sets, SAUCE editor, 9px flag, reference layers
   (drawn over the canvas, never composited; convertible to image layers), scaling cells (nearest, or re-matched
   through shadeans), flips, recent files (desktop).
   Shapes: outline in brush character / half blocks / CP437 single or double box drawing, hollow / colour / character
   fill, corner-to-corner drag (HERMedIT-style ellipse). The Brush is one tool with Moebius's modes (half block
   default, character, shading, colorize) and a size; the eraser takes the size too.
   Shape layers: a live layer that re-renders a line/box/ellipse from its parameters (kind, style, fill, glyph, colours,
   box, flip) through the same `planShapeCells` the tools paint with. The shape tools paint cells on a cells layer and
   place a shape layer anywhere else (Add layer → Shape arms them); on a shape layer their handles reshape it, and the
   left panels (Shape, Brush) restyle it — the right side stays layer properties. Saved like other live layers.
   Free transform (`transform.ts`, the Move tool / Cmd+T): one handle model for every layer type; cells content or the
   selected cells are lifted, scaled nearest-neighbour and put back as one undo step.
   3D pictures: animated PNG of the wiggle (`encodeApng`, verified against Pillow) and a red/cyan anaglyph PNG.
   Fonts (`fontnames.ts`, app `fontstore.ts`): a document is drawn in the font SAUCE names, or in the bitmap the
   file embeds (XBIN/ADF/IDF, kept at `assets/fonts/document.fnt`), which wins. The name table is generated from
   Moebius's `lookup_url` switch and carries the 86 names whose files we actually ship — Moebius lists 66 more than
   it has bitmaps for, so those would only fail to load. An unknown name is kept on the document (an export still
   asks for it) and drawn in IBM VGA with a status note. `Editor.setFont` rebuilds the glyph classes, since half
   blocks come from the bitmaps and a custom font may have none. Verified against 48,211 real SAUCE records from
   the corpus in `ansi-llm/raw_ansi_art`: 99.3% resolve exactly, and everything unresolved is junk in the field
   (tool names, artist handles, null bytes) rather than a font we lack.
   Image conversion off CP437 (`fontmatch.ts`): shadeans hardcodes CP437's ░▒▓█ and half blocks (`0xB0-0xB2`,
   `0xDB-0xDF`). Measured ink coverage at those codes — CP437 25/50/75/100%, Topaz 19/31/23/39%, PETSCII
   53/70/66/56% — so off the IBM codepages it is not a ramp at all. `matchImageToFont` reads the bitmaps instead:
   per cell, per distinct shape, the shape splits the pixels in two, each group's mean is its best colour and the
   leftover is the error; a shortlist is then re-scored with the colours quantised, since picking on free colours
   can choose a shape whose two colours round together and come out flat. `hasCp437Ramp` routes: shadeans keeps the
   IBM fonts. Note the match has *lower* squared error on CP437 too (-25%) and still looks worse — banded rather
   than dithered — which is the whole reason shadeans exists, and a reminder that this metric is not the goal.
   `pickFixedBg` exists for the C64's one-global-background constraint; it can only raise error, which is what a
   constraint does. Not done for real PETSCII: the C64 palette, 40x25, and any dithering under those constraints.
   TheDraw font picking (`app/fonts.ts`): with ~3,500 fonts the search *is* the feature, so the list sorts by any
   column and filters by a row range rather than a bare maximum — a max on its own still shows every shorter font,
   which was the complaint. `randomFontOfHeight` keeps the height fixed on purpose: a random font that also resizes
   the text throws the layout out and reads as a mistake rather than a suggestion, and it excludes the current font
   so rolling again always moves. It goes through the same undoable `change()` as picking one by hand.
   Keyboard (`app/keymap.ts` + the table in `main.ts`): shortcuts are data, and the sheet under `?` is generated
   from the same table, so it cannot drift from what the keys do. `mod` is Cmd on a Mac and Ctrl elsewhere; Moebius
   also uses bare Ctrl for colours and character sets, which off a Mac is the same physical key as `mod`, so a Ctrl
   press offers `ctrl+…` before `mod+…` and Ctrl+1 stays a foreground colour there as it is in Moebius (zoom keeps
   `mod+alt+0` for the same reason). Colour toggling is ported from Moebius's `palette.js` exactly, including the
   bit that makes it usable without looking: changing hue while bright stays bright. Bindings taken from
   `app/menu.js` and `app/document/input/keyboard.js` of the vendored 1.0.29 checkout, not from memory.
   The character grid sizes itself from `font.height` — a cell is 8 wide but 8, 14, 16 or 19 rows tall, and a
   picker canvas fixed at 16 rows paints a shorter font's glyphs into its top half while the clicks are still
   computed against the whole element. Measured before the fix: 240 of 256 squares picked the wrong character in an
   8-row font, 192 in EGA, 207 in VGA25G, 0 in IBM VGA — which is why it went unnoticed.
   `.xb` export passes the current font as `fontBytes`; XBIN is the format that carries its own font, and reading
   one back already prefers the embedded bitmap, so a document round-trips through it in the right font.
   The font browser (`app/fontpicker.ts`) follows the TheDraw picker's shape — filter, list, arrow-to-preview,
   Enter — but previews the *document* rather than a sample string, plus the 256-character map. That is the only
   thing that actually answers "which font does this file want": the font is the codepage, so the same bytes are a
   picture in one and a wall of the wrong letter in another. Opening art whose SAUCE names no font, where the
   picture leans on the high range the codepages disagree about, says so in the status line.
   9px letter spacing was already rendered correctly (`render.ts`: the 9th column repeats the 8th for CP437
   192-223); it moved from inside the SAUCE dialog to a top-bar toggle beside iCE, which is where it was looked for.
   Aspect ratio (SAUCE flags bits 3-4): "stretch" scales the *drawing* vertically by 1.2 at 8px cells or 1.35 at 9px
   — what a 4:3 screen does to 640x400 and 720x400 — in the canvas (`view.ts` `ys`, which the hit-testing divides
   back out) and in PNG export (`stretchRows`, nearest-neighbour so no colour is invented). The grid never changes.
   Cutting a background out (`matte.ts`, `cleanup.ts`, `halves.ts`): keying happens in the source pixels, before
   shadeans — a cell straddling a silhouette otherwise comes back as one character blending subject and background,
   which nothing afterwards can separate. Keyed pixels lose their alpha and take the nearest kept colour ("bleed"),
   so the matcher only sees subject colours; coverage is then sampled per *half* cell, so the edge lands on ▀▄ and
   the compositor's existing half-block merge does the rest. For art that is already cells there is no source to
   re-key, so `defringe` takes the deleted colour out of the cells around a selection instead — a half block keeps
   its other half, a shade drawn in that colour loses its ink, that colour behind a character lets the layer below
   through. Delete on a live layer cuts the selection out of the layer's mask rather than refusing.
   Joint (Moebius collaboration): `core/joint/` = protocol (RLE and messages byte-identical to libtextmode, tested
   against the vendored module) and `JointSync` (S = mirror of the server canvas; L = composite minus the Remote
   layer; DRAWs for the cells that changed in L, Remote cleared where a local edit supersedes it); `app/joint.ts` =
   client, `app/jointui.ts` = connect dialog and floating users/chat window. Tested end to end against the genuine
   Moebius server (`scripts/joint-server/`, two headless browsers). Not yet: reconnect/merge after a dropped socket,
   sending SELECTION, rendering other people's floating pastes.
   Not yet: rotating a selection (free transform moves and scales), shade/colorize brushes as their own tools, shifter,
   palette editing.
3. **Done** — font layers: all 1,071 Synchronet `.tdf` files parse (3,474 fonts; 550 files hold more than
   one, which a first-font-only reader never sees). The set is entirely colour fonts, so outline/block
   rendering is covered by unit tests only, not by real fonts. Not yet: per-character caret editing on canvas.
4. **Done** — image layers: live resize / crop / adjust from the embedded original; alpha becomes absent cells.
   Known: transparent pixels decode as black, so cells straddling an image's edge can pick up a black fringe.
5. **Done** — depth: signed per-layer depth, `planDepth` (cell owner -> at most 16 protocol layers, closest
   merged beyond that), `.ans` export with `CSI = Ps ; Pd * z` / `CSI = Ps z`, and a stereo preview that
   draws deepest-first with 3dBBS's disparity model (glass 2.0 units from the camera), so uncovered areas are
   black exactly as on the device. **(unverified)**: not yet viewed on a 3DS or against `tests/stress_server.py`.
   Import reads the tags back: a tagged `.ans` opens as one cells layer per depth plane.
6. Mesh layers.
7. **Done** — opacity by re-matching (app side: `opacity.ts`), opt-in per layer; exports use the live composite so
   the re-matched cells go out; the project file's `preview.ans` does not include them (it is built by the core).
8. **Done (macOS)** — desktop shell. Not yet: headless CLI (`packages/cli`), recent files, Windows/Linux builds.

Not planned yet, not precluded: animation, collaboration.

## 10. Environment notes

- Rust 1.95 with the `wasm32-unknown-unknown` target installed. No wasm-bindgen / wasm-pack needed.
- TheDraw fonts and `shadeans.wasm` are build products (`npm run fonts`, `npm run shadeans`), not committed.
- `npm audit` reports `extract-zip` via puppeteer-core's browser downloader: dev-only, and the smoke test
  never downloads a browser (it uses one already on the machine).
- Node: pinned to 20.20.0 via `.nvmrc` (already installed under nvm; run
  `nvm use` in the project). The machine default stays 18.17.1.
