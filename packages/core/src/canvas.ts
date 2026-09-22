import type { KdDocument, Layer } from "./document.js";
import type { Command } from "./history.js";

export interface CanvasEdges {
  /** columns to add at the left; everything shifts right. Negative crops. */
  left: number;
  /** rows to add at the top; everything shifts down. Negative crops. */
  top: number;
  right: number;
  bottom: number;
}

/**
 * Grow or crop the canvas at any edge. Adding at the left or top moves every
 * layer by the same amount, so the picture keeps its place relative to itself.
 * No cell data is touched: layers keep what ends up outside the canvas, so
 * cropping is undone by growing again.
 */
export function canvasResizeCommand(doc: KdDocument, edges: Partial<CanvasEdges>): Command {
  const left = edges.left ?? 0, top = edges.top ?? 0;
  const width = doc.width + left + (edges.right ?? 0), height = doc.height + top + (edges.bottom ?? 0);
  if (width < 1 || height < 1) throw new Error("the canvas must keep at least one row and one column");
  const before = { width: doc.width, height: doc.height };
  const shift = (layers: Layer[], dx: number, dy: number): void => {
    for (const l of layers) {
      if (l.type === "group") shift(l.children, dx, dy);
      else { l.x += dx; l.y += dy; }
    }
  };
  return {
    label: "Resize canvas",
    redo: () => { doc.width = width; doc.height = height; shift(doc.layers, left, top); },
    undo: () => { doc.width = before.width; doc.height = before.height; shift(doc.layers, -left, -top); },
  };
}
