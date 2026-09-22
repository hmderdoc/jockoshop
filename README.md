# jockoshop

A layered, non-destructive ANSI art editor. *(Package names inside the repo are still `killerdraw`, the working title.)*

**Downloads:** [Releases](https://github.com/hmderdoc/jockoshop/releases) — macOS (Apple silicon and Intel), Windows and Linux.
The builds are **not code-signed**. On macOS the first launch says "unidentified developer": right-click
`jockoshop.app` → **Open** (or `xattr -d com.apple.quarantine jockoshop.app`). Windows SmartScreen: "More info" → "Run anyway".

The project file keeps the recipe
for a picture (hand-drawn cells, live TheDraw text, source images plus their
conversion settings) and `.ans` is an export. See [DESIGN.md](DESIGN.md).

![jockoshop](docs/screenshots/overview.png)

| | |
|---|---|
| ![prose flowing around other layers](docs/screenshots/prose-flow.png) **Prose** wrapping around a TheDraw title and a converted image; text selected for recolouring | ![an image layer](docs/screenshots/image-layer.png) An **image layer**: shadeans converts it live; every setting is a slider, the original stays in the project |
| ![palette swap](docs/screenshots/palette-swap.png) A **palette swap** on the title layer — nothing in the layer changes | ![magic wand](docs/screenshots/magic-wand.png) **Magic wand "by look"**: one click takes every cell that shows as flat black |

![3D preview](docs/screenshots/3d-preview.png) The preview in red/cyan: layers at different **3dBBS depths**.

## Run it

```sh
nvm use                 # Node 20 (.nvmrc)
npm install
npm run fonts           # copies TheDraw fonts from a Synchronet install (ctrl/tdfonts) — optional
npm run shadeans        # builds the image converter to WebAssembly — optional, needs Rust + wasm32 target
npm run dev             # http://127.0.0.1:5183   (add ?demo for a sample layered document)
```

`npm run fonts -- /path/to/tdfonts` and `npm run shadeans -- /path/to/shadeans`
point the two optional steps at other locations. Without them the editor still
runs; text layers and image layers say what is missing.

## What works

- **Layers**: cells, live TheDraw text, live images, groups; visibility, reorder, duplicate, move (content pushed off the canvas is kept).
- **Transparency**, four ways, all per layer:
  - per-channel cells (character / foreground / background can each be absent), with exact half-block merging between layers;
  - **key rules** — filter cells by character + colours (or "looks solid black") so lower layers show through, without erasing anything;
  - **masks** — hide part of a layer from a selection, non-destructively; toggle or remove later;
  - or simply select and **Delete** (with the Char / FG / BG switches deciding what is removed — e.g. backgrounds only).
- **Selections**: marquee, lasso, magic wand (alike in char / fg / bg, *by look*, connected or everywhere, this layer or all layers), select by character + colours, all / none / invert / layer content; Shift adds, Alt subtracts, both intersect. Drawing is confined to the selection. Fill, delete, copy, cut; paste lands as a new layer.
- **Palette swap**: remap a layer's 16 colours as it is drawn — presets (hue rotations, all-one-hue, greyscale, swap bright/dark, negative), randomize, or per colour. Works on text and image layers; it is how you recolour a colour TheDraw font.
- **Find & replace** by character + colours, with the same matcher as key rules.
- **Prose layers**: a word processor's text in a frame, not stamped cells. Drag a frame with the Type tool (or “+ prose”) and type; click anywhere in the text to place the caret and fix a typo, and the paragraph reflows. **Flow-around**: whatever other layers already draw inside the frame — a box border, a circle, an image — is an obstacle the text wraps around, so text conforms to odd containers. Select text by dragging, Shift+arrows/Shift+click, double-click a word, or Cmd/Ctrl+A for the whole prose; type over it, Backspace/Delete it, Cmd+C/X/V it, and click a swatch to recolour it (left = foreground, right = background). Arrows, Home/End, Enter, paste; per-character colours; left/centre/right; a typing burst is one undo step. Resize the frame with Move's handles.
- **TheDraw text layers**: 3,474 fonts from Synchronet's set (multi-font files included), font switches mid-string, wrap, spacing; re-editable at any time; rasterize when done.
- **Resize on the canvas**: with Move, an image layer has handles — drag the corner to resize (aspect kept), the right edge for width only, the bottom edge for height only, reconverting as you drag; a text layer's right edge drags its wrap width.
- **Image layers**: [shadeans](https://github.com/hmderdoc/shadeans) compiled to WebAssembly from its unmodified source; resize, crop and adjust from the embedded original at any time; transparent pixels become see-through cells.
- **Canvas**: add or remove rows and columns at any edge — adding at the top or left shifts every layer along; cropping loses nothing.
- **3D (3dBBS)**: per-layer depth (0 = at the screen, negative = behind, positive = in front), a stereo mode in the preview (wiggle, follow the mouse, red/cyan, side by side) drawn the way the device draws text layers, and `.ans` export with `CSI = … z` depth tags that other terminals ignore.
- **Drawing**: pencil (with per-channel switches: recolour only, or draw characters with no background), half-block brush, eraser, line, rectangle, fill, pick-up, type; undo/redo for everything.
- **Files**: `.kdraw` project (ZIP: manifest, layer data, masks, original assets, flattened `preview.ans`).
  Open / import: ANS (16-colour, iCE, 24-bit), BIN, XBIN, TundraDraw `.tnd`, Synchronet Ctrl-A `.msg`, Artworx `.adf`, iCE Draw `.idf`, Avatar `.avt`, plain text.
  Export: ANS, 3dBBS ANS, BIN, XBIN, TundraDraw, Ctrl-A, text (CP437 or UTF-8), PNG — the same set PabloDraw writes, plus 3dBBS.

Not yet: moving/transforming a selection in place (paste-as-layer + Move covers it for now), ellipse, mirror mode, reference overlay, SAUCE editor, mesh layers, importing depth tags back into layers, opacity by re-matching, recent files, Windows/Linux builds (untested).

## Desktop app (Tauri)

```sh
npm run desktop          # runs the app in a native window (first build compiles Tauri: a minute or two)
npm run desktop:build    # packages/desktop/src-tauri/target/release/bundle/macos/jockoshop.app (+ .dmg)
```

Needs Rust (already required for shadeans). The desktop app is the same web app in a system webview, plus what a
browser can't do: files with paths (Save saves in place, Shift-click / Cmd+Shift+S for Save As), a native menu bar,
`.kdraw` / `.ans` file associations, drag a file onto the window to open or import it, files on the command line,
and an "unsaved changes" prompt on close. Fonts and `shadeans.wasm` are compiled into the binary, so run
`npm run fonts` and `npm run shadeans` before building.

The `.dmg` is made with plain `hdiutil` (`scripts/make-dmg.sh`) rather than Tauri's DMG step, which scripts Finder
to arrange the window and so triggers a macOS "control Finder" permission prompt.

## Finding your way around

- **Left**: the tool palette (icons; hover for the name, shortcut and what it does). The tool decides what is under it —
  drawing tools show the brush, colours and characters; the select tools show selection options and what to do with the
  selection (fill, delete, copy, mask the layer…); **Type** on a text layer shows its font and text; **Move** shows the
  position; **Find** (`S`) shows find & replace.
  The tool follows the layer: select a text layer with a brush active and you get Type (an image layer: Move); go back
  to a cells layer and the brush returns. Move and the select tools carry over. With Move, double-click a text layer
  to edit its text.
- **Right**: an always-on preview of the whole picture — the pink box is what the canvas is showing; click or drag to go
  there, and switch it to a 3D mode to see the layer depths — then the layer stack, then the active layer's own
  properties in collapsible panels (depth, image settings, palette swap, mask, key rules). Panels remember whether you
  left them open.
- **Top**: new, open, import as layer, save, export (a small menu: `.ans`, `.png`, 3dBBS `.ans`), undo/redo, zoom, canvas
  size and iCE.

## Checks

```sh
npm run check           # typecheck + unit tests (core)
npm run smoke           # drives the running editor in headless Chrome with real mouse/keyboard input
```

`npm run smoke` needs `npm run dev` running and a Chrome binary (`CHROME_PATH`, or
one cached by puppeteer under `~/.cache/puppeteer`).

## Layout

```
packages/core           document model, compositor, matcher, undo, TDF, renderer, formats — no DOM
packages/app            the editor (Vite, plain TypeScript)
packages/shadeans-wasm  C-ABI wrapper that compiles shadeans' sources in by path
packages/desktop        Tauri shell: window, native menu, file read/write, open-with, close guard
scripts/                font sync, shadeans build, browser smoke test
```

## Licence

Apache-2.0 (see `LICENSE`). The image converter is [shadeans](https://github.com/hmderdoc/shadeans), compiled in
from its own source by `packages/shadeans-wasm`; TheDraw fonts are fetched from
[Synchronet](https://github.com/SynchronetBBS/sbbs) at build time and are not part of this repository.
