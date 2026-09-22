/**
 * Left sidebar: the tool palette, and under it whatever the chosen tool needs.
 * The tool decides the rest of the sidebar — drawing tools show the brush,
 * selection tools show selection options and operations, Type on a text layer
 * shows the font and the text, Move shows position, Find shows find & replace.
 */
import type { Editor, ToolId } from "./editor.js";
import type { FontLibrary } from "./fonts.js";
import { type IconName, iconButton } from "./icons.js";
import {
  type Panel, brushPanel, characterPanel, findPanel, fontPanel, positionPanel, prosePanel, selectOptionsPanel, selectionPanel,
} from "./sections.js";
import type { Tool } from "./tools.js";
import { h } from "./ui.js";

const TOOL_ICONS: Record<ToolId, IconName> = {
  pencil: "pencil", half: "half", eraser: "eraser", line: "line", rect: "rect", fill: "fill", pick: "pick",
  text: "type", move: "move", marquee: "marquee", lasso: "lasso", wand: "wand", find: "find",
};
/** palette order: draw, then select, then the rest */
const ORDER: ToolId[] = ["pencil", "half", "eraser", "line", "rect", "fill", "pick", "text", "marquee", "lasso", "wand", "move", "find"];

export function buildLeft(ed: Editor, tools: Tool[], lib: FontLibrary): HTMLElement {
  const palette = h("div.palette");
  const context = h("div.context");
  const root = h("div.panel.toolbox", {}, palette, context);
  let panels: Panel[] = [];
  let key = "";

  const note = (text: string): Panel => ({ el: h("p.hint.note", {}, text) });

  const build = (): Panel[] => {
    const tool = tools.find((t) => t.id === ed.tool)!, layer = ed.active;
    const content = layer && layer.type !== "group" ? layer : null;
    if (tool.selects) return [selectOptionsPanel(ed, tool), selectionPanel(ed)];
    if (tool.id === "move") return content ? [positionPanel(ed, content)] : [note("Select a layer to move.")];
    if (tool.id === "find") {
      return content?.type === "cells" ? [findPanel(ed, content)] : [note("Find & replace works on cells layers. Select one, or rasterize this layer.")];
    }
    if (tool.id === "text" && content?.type === "font") return [fontPanel(ed, lib, content)];
    if (tool.id === "text" && content?.type === "prose") return [prosePanel(ed, content), brushPanel(ed)];
    const out: Panel[] = [];
    if (content && content.type !== "cells") {
      out.push(note(content.type === "font"
        ? "This is a live text layer. Use the Type tool (T) to edit it; rasterize it to draw on it."
        : content.type === "prose" ? "This is a prose layer. Use the Type tool (T) to edit it on the canvas; rasterize it to draw on it."
        : "This is a live image layer. Adjust it on the right; rasterize it to draw on it."));
    }
    return [...out, brushPanel(ed), characterPanel(ed)];
  };

  const render = (force: boolean): void => {
    palette.replaceChildren(...ORDER.map((id) => {
      const t = tools.find((x) => x.id === id)!;
      const applies = ed.toolApplies(id);
      return iconButton(TOOL_ICONS[id], `${t.label} (${t.key.toUpperCase()})`, {
        tip: applies ? t.hint : "not for this kind of layer — rasterize it, or pick a cells layer",
        active: ed.tool === id, class: applies ? "tool" : "tool na", onclick: () => { ed.chooseTool(id); },
      });
    }));
    const layer = ed.active;
    const next = `${ed.tool}|${layer?.id ?? ""}|${layer?.type ?? ""}`;
    if (force || next !== key) {
      key = next;
      panels = build();
      context.replaceChildren(...panels.map((p) => p.el));
    } else for (const p of panels) p.update?.();
  };

  ed.on("ui", () => render(false));
  ed.on("doc", () => render(true));
  render(true);
  return root;
}
