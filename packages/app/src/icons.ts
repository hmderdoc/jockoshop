/**
 * Line icons drawn for this app: 24x24, stroked with the current text colour.
 * Inline SVG so there is no icon font or external file to load.
 */
const ICONS = {
  // tools
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M13.5 7.5l3 3"/>',
  half: '<rect x="5" y="5" width="14" height="14"/><path d="M5 5h14v7H5z" fill="currentColor" stroke="none"/>',
  eraser: '<path d="M9 19l-4.5-4.5a1.5 1.5 0 0 1 0-2.1l7.9-7.9a1.5 1.5 0 0 1 2.1 0l4.5 4.5a1.5 1.5 0 0 1 0 2.1L12 19z"/><path d="M8.5 9.5l6.5 6.5"/><path d="M9 19h11"/>',
  line: '<path d="M6 18L18 6"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M9 7L4 12l5 5z"/><path d="M15 7l5 5-5 5z" fill="currentColor" stroke="none"/>',
  sauce: '<rect x="4" y="5" width="16" height="14"/><path d="M8 10h8M8 14h5"/>',
  reference: '<rect x="3" y="5" width="18" height="14" stroke-dasharray="3 2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M3 16l5-5 4.5 4.5 3-3L21 17" opacity=".6"/>',
  scale: '<rect x="4" y="9" width="11" height="11"/><path d="M15 9V4H4"/><path d="M20 4l-5 5M20 4h-4M20 4v4"/>',
  recent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  fill: '<path d="M5.5 12.5l7-7 6.5 6.5-6 6a2 2 0 0 1-2.8 0l-4.7-4.7a.6.6 0 0 1 0-.8z"/><path d="M12.5 5.5L10 3"/><path d="M6 12.5h12.5"/><path d="M20.5 15.5c1 1.4 1.5 2.4 1.5 3a1.5 1.5 0 0 1-3 0c0-.6.5-1.6 1.5-3z"/>',
  pick: '<path d="M13 8l3 3-8.5 8.5L4 20l.5-3.5z"/><path d="M12 7l5 5"/><path d="M15 9l2.6-2.6a2 2 0 0 1 2.8 2.8L17.8 11.8"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5"/>',
  type: '<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  marquee: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.6"/>',
  lasso: '<ellipse cx="12" cy="9.5" rx="8" ry="5"/><path d="M7.5 13.6c-1.2 1.2-1 3 .6 3.4 1.6.4 2 2 .4 3.5"/>',
  wand: '<path d="M4 20L14.5 9.5"/><path d="M14 3l.9 2.6L17.5 6.5l-2.6.9L14 10l-.9-2.6L10.5 6.5l2.6-.9z"/><path d="M19.5 12l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  find: '<circle cx="10.5" cy="10.5" r="6"/><path d="M20 20l-5.2-5.2"/>',
  // files and edit
  new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>',
  open: '<path d="M3 6h6l2 2.5h10V19H3z"/>',
  importLayer: '<path d="M12 3v9"/><path d="M8.5 8.5L12 12l3.5-3.5"/><path d="M12 12.5l8 3.5-8 3.5-8-3.5 4-1.75"/><path d="M16 14.25L20 16"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><path d="M8 20v-6h8v6"/>',
  export: '<path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 16v4h16v-4"/>',
  undo: '<path d="M8 5L3 10l5 5"/><path d="M3 10h11a5.5 5.5 0 0 1 0 11h-3"/>',
  redo: '<path d="M16 5l5 5-5 5"/><path d="M21 10H10a5.5 5.5 0 0 0 0 11h3"/>',
  canvas: '<path d="M7 2v15h15"/><path d="M2 7h15v15"/>',
  // layers
  cells: '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16"/>',
  text: '<path d="M5 19l7-15 7 15"/><path d="M8 13h8"/>',
  image: '<rect x="3" y="5" width="18" height="14"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M3 16l5-5 4.5 4.5 3-3L21 17"/>',
  prose: '<path d="M4 6h16M4 10h16M4 14h10M4 18h13"/>',
  group: '<path d="M12 3l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4"/><path d="M4 16.5l8 4 8-4"/>',
  up: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  eye: '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12z" opacity=".35"/><path d="M4 4l16 16"/>',
  swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h15"/><path d="M17 12l4 4-4 4"/><path d="M21 16H6"/>',
  edit: '<path d="M4 20l1-4L16 5l3 3L8 19z"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

/**
 * A button that shows only an icon. `label` is its name — shown as the hover
 * tip (with `tip` after it) and read by assistive tech.
 */
export function iconButton(
  name: IconName, label: string, props: { tip?: string; onclick?: (e: MouseEvent) => void; disabled?: boolean; active?: boolean; plus?: boolean; class?: string } = {},
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `ib${props.active ? " active" : ""}${props.class ? ` ${props.class}` : ""}`;
  b.title = props.tip ? `${label} — ${props.tip}` : label;
  b.setAttribute("aria-label", label);
  b.disabled = !!props.disabled;
  if (props.plus) { const p = document.createElement("span"); p.className = "plus"; p.textContent = "+"; b.append(p); }
  b.append(icon(name));
  if (props.onclick) b.addEventListener("click", props.onclick);
  return b;
}
