import { type Layer, type Raster, type Rect, createRaster, hasBlink, layerSize, renderGrid } from "@killerdraw/core";
import type { Editor } from "./editor.js";
import { type Pointer, type Tool, pickUp } from "./tools.js";

/** The art canvas, an overlay for cursors and previews, and pointer routing to the active tool. */
export class CanvasView {
  readonly root = document.createElement("div");
  private art = document.createElement("canvas");
  private refs = document.createElement("canvas");
  private overlay = document.createElement("canvas");
  private bitmaps = new Map<Uint8Array, ImageBitmap | null>();
  private raster!: Raster;
  private image!: ImageData;
  private hover: Pointer | null = null;
  private pressed = -1;
  private outline: { version: number; zoom: number; path: Path2D } | null = null;
  /** with iCE off, cells with a bright background blink, as they will in a viewer */
  private blinkTimer = 0;
  private blinkOff = false;

  constructor(private ed: Editor, private tools: () => Tool) {
    this.root.className = "canvas-wrap";
    this.art.className = "art";
    this.refs.className = "refs";
    this.overlay.className = "overlay";
    const stack = document.createElement("div");
    stack.className = "canvas-stack";
    stack.append(this.art, this.refs, this.overlay);
    this.root.append(stack);

    this.root.addEventListener("scroll", () => ed.emit("scroll"));
    new ResizeObserver(() => { if (this.fitZoom()) { this.paint(); ed.emit("ui"); } ed.emit("scroll"); }).observe(this.root);
    ed.on("pixels", (rect) => this.paint(rect as Rect | undefined));
    ed.on("ui", () => { this.drawRefs(); this.drawOverlay(); });
    ed.on("doc", () => this.drawOverlay());

    this.overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    this.overlay.addEventListener("pointerdown", (e) => {
      this.overlay.setPointerCapture(e.pointerId);
      const p = this.pointer(e, e.button);
      if (e.altKey && !this.tools().selects) { pickUp(ed, p.x, p.y); return; }
      this.pressed = e.button;
      ed.status = "";   // a message from the last action stays until the next one
      this.tools().down(p);
      ed.emit("status");
      this.drawOverlay();
    });
    this.overlay.addEventListener("pointermove", (e) => {
      const p = this.pointer(e, this.pressed);
      this.hover = p;
      if (this.pressed < 0) this.overlay.style.cursor = this.tools().cursor?.(p) ?? "crosshair";
      if (this.pressed >= 0) this.tools().move(p);
      ed.emit("status");
      this.drawOverlay();
    });
    const release = (e: PointerEvent): void => {
      if (this.pressed < 0) return;
      const p = this.pointer(e, this.pressed);
      this.pressed = -1;
      this.tools().up(p);
      this.drawOverlay();
    };
    this.overlay.addEventListener("dblclick", (e) => this.tools().dblclick?.(this.pointer(e as PointerEvent, 0)));
    this.overlay.addEventListener("pointerup", release);
    this.overlay.addEventListener("pointercancel", release);
    this.overlay.addEventListener("pointerleave", () => { this.hover = null; this.drawOverlay(); ed.emit("status"); });
    this.paint();
  }

  /**
   * With zoomFit on, pick the zoom that fits the document's width in the
   * available space, in quarter steps between 0.5× and 4×. Returns true if it changed.
   */
  fitZoom(): boolean {
    const ed = this.ed;
    if (!ed.zoomFit || !this.raster) return false;
    const avail = this.root.clientWidth - 2 * 24;
    if (avail <= 0) return false;
    const z = Math.max(0.5, Math.min(4, Math.floor((avail / this.raster.width) * 4) / 4));
    if (z === ed.zoom) return false;
    ed.zoom = z;
    return true;
  }

  /** the full-resolution rendering of the document, for the preview to scale down */
  get artCanvas(): HTMLCanvasElement {
    return this.art;
  }

  /** the part of the document on screen, in document pixels */
  viewport(): { x: number; y: number; width: number; height: number } {
    const z = this.ed.zoom, pad = 24, r = this.root;
    const x = Math.max(0, (r.scrollLeft - pad) / z), y = Math.max(0, (r.scrollTop - pad) / z);
    return {
      x, y,
      width: Math.min(this.raster.width - x, (r.clientWidth - Math.max(0, pad - r.scrollLeft)) / z),
      height: Math.min(this.raster.height - y, (r.clientHeight - Math.max(0, pad - r.scrollTop)) / z),
    };
  }

  /** the document cell under a client-pixel position (clamped to the canvas), or null if it is not over the canvas area */
  cellAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const wrap = this.root.getBoundingClientRect();
    if (clientX < wrap.left || clientX > wrap.right || clientY < wrap.top || clientY > wrap.bottom) return null;
    const r = this.overlay.getBoundingClientRect(), z = this.ed.zoom;
    return {
      x: Math.max(0, Math.min(this.ed.doc.width - 1, Math.floor((clientX - r.left) / z / this.raster.cellWidth))),
      y: Math.max(0, Math.min(this.ed.doc.height - 1, Math.floor((clientY - r.top) / z / this.raster.cellHeight))),
    };
  }

  /** scroll so this document pixel is in the middle */
  centerOn(px: number, py: number): void {
    const z = this.ed.zoom, r = this.root;
    r.scrollLeft = px * z + 24 - r.clientWidth / 2;
    r.scrollTop = py * z + 24 - r.clientHeight / 2;
  }

  get hoverCell(): Pointer | null {
    return this.hover;
  }

  private pointer(e: PointerEvent, button: number): Pointer {
    const r = this.overlay.getBoundingClientRect();
    const px = (e.clientX - r.left) / this.ed.zoom, py = (e.clientY - r.top) / this.ed.zoom;
    const ch = this.raster.cellHeight;
    return {
      x: Math.floor(px / this.raster.cellWidth), y: Math.floor(py / ch),
      hy: Math.floor(py / (ch / 2)), px, py, button, shift: e.shiftKey, alt: e.altKey,
    };
  }

  /** Redraw the art: everything (and resize if the document changed size), or one rect of cells. */
  paint(rect?: Rect): void {
    const { doc, comp, font } = this.ed;
    const ninePx = doc.letterSpacing9px;
    const fresh = !this.raster || this.raster.width !== doc.width * (ninePx ? 9 : 8) || this.raster.height !== doc.height * font.height;
    if (fresh) {
      this.raster = createRaster(doc.width, doc.height, font, ninePx);
      this.image = new ImageData(this.raster.data as Uint8ClampedArray<ArrayBuffer>, this.raster.width, this.raster.height);
      this.art.width = this.raster.width;
      this.art.height = this.raster.height;
      if (this.fitZoom()) this.ed.emit("ui");
    }
    const zoom = this.ed.zoom;
    const w = Math.round(this.raster.width * zoom), hgt = Math.round(this.raster.height * zoom);
    const css = { w: `${w}px`, h: `${hgt}px` };
    if (this.art.style.width !== css.w || this.art.style.height !== css.h) {
      for (const c of [this.art, this.refs, this.overlay]) { c.style.width = css.w; c.style.height = css.h; }
      this.overlay.width = this.refs.width = w;
      this.overlay.height = this.refs.height = hgt;
      rect = undefined;   // the overlay was cleared by the resize; everything is redrawn below anyway
    }
    const opts = { palette: doc.palette, iceColors: doc.iceColors, letterSpacing9px: ninePx, blinkOff: this.blinkOff };
    const ctx = this.art.getContext("2d")!;
    const blinking = hasBlink(comp.grid, doc.iceColors);
    if (blinking && !this.blinkTimer) {
      this.blinkTimer = window.setInterval(() => { this.blinkOff = !this.blinkOff; this.paint(); }, 500);
    } else if (!blinking && this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = 0;
      if (this.blinkOff) { this.blinkOff = false; opts.blinkOff = false; rect = undefined; }
    }
    if (fresh || !rect) {
      renderGrid(comp.grid, font, this.raster, opts);
      ctx.putImageData(this.image, 0, 0);
    } else {
      renderGrid(comp.grid, font, this.raster, opts, rect);
      const cw = this.raster.cellWidth, ch = this.raster.cellHeight;
      ctx.putImageData(this.image, 0, 0, rect.x * cw, rect.y * ch, rect.width * cw, rect.height * ch);
    }
    this.drawRefs();
    this.drawOverlay();
  }

  /** Reference layers: images to draw from, over the art but not part of it. */
  drawRefs(): void {
    const ctx = this.refs.getContext("2d")!;
    ctx.clearRect(0, 0, this.refs.width, this.refs.height);
    const z = this.ed.zoom, cw = this.raster.cellWidth * z, ch = this.raster.cellHeight * z;
    const walk = (layers: Layer[]): void => {
      for (const l of layers) {
        if (!l.visible) continue;
        if (l.type === "group") { walk(l.children); continue; }
        if (l.type !== "reference") continue;
        const bytes = this.ed.doc.assets.get(l.source);
        if (!bytes) continue;
        if (!this.bitmaps.has(bytes)) {
          this.bitmaps.set(bytes, null);
          void createImageBitmap(new Blob([bytes as BlobPart])).then((bmp) => { this.bitmaps.set(bytes, bmp); this.drawRefs(); });
        }
        const bmp = this.bitmaps.get(bytes);
        if (!bmp) continue;
        ctx.globalAlpha = l.opacity;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(bmp, l.x * cw, l.y * ch, l.width * cw, l.height * ch);
      }
    };
    walk(this.ed.doc.layers);
    ctx.globalAlpha = 1;
  }

  drawOverlay(): void {
    const ctx = this.overlay.getContext("2d")!;
    const z = this.ed.zoom, cw = this.raster.cellWidth * z, ch = this.raster.cellHeight * z;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);

    const l = this.ed.active;
    if (l && l.type !== "group") {
      const g = layerSize(l);
      if (g) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "rgba(90,200,255,.7)";
        ctx.strokeRect(l.x * cw + 0.5, l.y * ch + 0.5, g.width * cw - 1, g.height * ch - 1);
        ctx.setLineDash([]);
      }
    }

    // free-transform handles: the framed box and its knobs (Move tool; the shape tools on a shape layer)
    const handles = this.tools().handles?.();
    if (handles) {
      const b = handles.box, s = Math.max(7, 4 * z);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "rgba(255,255,255,.8)";
      ctx.strokeRect(b.x * cw + 0.5, b.y * ch + 0.5, b.width * cw - 1, b.height * ch - 1);
      ctx.setLineDash([]);
      for (const k of handles.knobs) {
        const x = k.px * z, y = k.py * z;
        ctx.fillStyle = "#fff"; ctx.fillRect(x - s / 2, y - s / 2, s, s);
        ctx.strokeStyle = "#000"; ctx.strokeRect(x - s / 2 + 0.5, y - s / 2 + 0.5, s - 1, s - 1);
      }
    }

    const found = this.ed.found, fl = found && this.ed.active?.id === found.layerId ? this.ed.active : null;
    if (found && fl && fl.type === "cells") {
      ctx.strokeStyle = "rgba(255,80,220,.95)";
      for (const i of found.indices) {
        const x = (i % fl.grid.width) + fl.x, y = Math.floor(i / fl.grid.width) + fl.y;
        ctx.strokeRect(x * cw + 0.5, y * ch + 0.5, cw - 1, ch - 1);
      }
    }

    const sel = this.ed.selection;
    if (sel) {
      // the border between selected and unselected cells, rebuilt only when the selection changes
      if (!this.outline || this.outline.version !== this.ed.selectionVersion || this.outline.zoom !== z) {
        const path = new Path2D(), W = sel.width, H = sel.height, m = sel.mask;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (!m[y * W + x]) continue;
            const px = x * cw, py = y * ch;
            if (y === 0 || !m[(y - 1) * W + x]) { path.moveTo(px, py + 0.5); path.lineTo(px + cw, py + 0.5); }
            if (y === H - 1 || !m[(y + 1) * W + x]) { path.moveTo(px, py + ch - 0.5); path.lineTo(px + cw, py + ch - 0.5); }
            if (x === 0 || !m[y * W + x - 1]) { path.moveTo(px + 0.5, py); path.lineTo(px + 0.5, py + ch); }
            if (x === W - 1 || !m[y * W + x + 1]) { path.moveTo(px + cw - 0.5, py); path.lineTo(px + cw - 0.5, py + ch); }
          }
        }
        this.outline = { version: this.ed.selectionVersion, zoom: z, path };
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#000";
      ctx.stroke(this.outline.path);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#fff";
      ctx.stroke(this.outline.path);
      ctx.setLineDash([]);
    }

    // mirror mode: the axes
    if (this.ed.mirrorX || this.ed.mirrorY) {
      ctx.strokeStyle = "rgba(255,80,220,.6)";
      ctx.setLineDash([2, 4]);
      if (this.ed.mirrorX) { const x = (this.ed.doc.width / 2) * cw; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.overlay.height); ctx.stroke(); }
      if (this.ed.mirrorY) { const y = (this.ed.doc.height / 2) * ch; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.overlay.width, y); ctx.stroke(); }
      ctx.setLineDash([]);
    }

    // selected prose characters
    const textSel = this.ed.prose.selectionCells();
    if (textSel.length) {
      ctx.fillStyle = "rgba(90,200,255,.45)";
      for (const c of textSel) ctx.fillRect(c.x * cw, c.y * ch, cw, ch);
    }

    const tool = this.tools();
    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (const [x, y] of tool.preview?.() ?? []) ctx.fillRect(x * cw, y * ch, cw, ch);
    for (const [x, hy] of tool.previewHalf?.() ?? []) ctx.fillRect(x * cw, hy * (ch / 2), cw, ch / 2);

    const caret = tool.caret?.();
    if (caret) {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(caret[0] * cw, caret[1] * ch + ch - 3 * z, cw, 3 * z);
    }

    if (this.hover) {
      ctx.strokeStyle = "rgba(255,255,255,.9)";
      const fp = tool.footprint?.(this.hover);
      const rh = fp?.half ? ch / 2 : ch;
      for (const [x, y] of fp?.cells ?? [[this.hover.x, this.hover.y]]) ctx.strokeRect(x * cw + 0.5, y * rh + 0.5, cw - 1, rh - 1);
    }

    // the other people in a joint: their cell, in their own colour, with their nick over it
    for (const c of this.ed.joint?.cursors() ?? []) {
      const x = c.x * cw, y = c.y * ch;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2);
      ctx.lineWidth = 1;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "bottom";
      const w = ctx.measureText(c.nick).width + 4;
      ctx.fillStyle = c.color;
      ctx.fillRect(x, Math.max(0, y - 12), w, 12);
      ctx.fillStyle = "#000";
      ctx.fillText(c.nick, x + 2, Math.max(0, y - 12) + 11);
    }
  }
}
