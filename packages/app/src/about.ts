/**
 * The mark in the corner, and what it opens.
 *
 * The app icon is the same artwork the installers carry (docs/icon.svg), drawn
 * as vector here so it stays crisp at 22px and in a retina window alike rather
 * than being a downscale of the 1024px raster.
 */
import { modal } from "./dialogs.js";
import { openExternal } from "./io.js";
import { h } from "./ui.js";

export const REPO_URL = "https://github.com/hmderdoc/jockoshop";
export const RELEASES_URL = `${REPO_URL}/releases`;

/** "0.1.11 (d645732)", or "… d645732+" when the build had uncommitted changes. */
export function buildLabel(): string {
  const commit = __APP_COMMIT__ === "unknown" ? "" : ` (${__APP_COMMIT__}${__APP_DIRTY__ ? "+" : ""})`;
  return `${__APP_VERSION__}${commit}`;
}

/**
 * The icon, at whatever size is asked for. The ids inside are suffixed because
 * two copies on one page would otherwise share gradient and clip definitions,
 * and the second would take the first's.
 */
let marks = 0;
export function appMark(size = 22): SVGSVGElement {
  const n = marks++;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `
<defs>
  <linearGradient id="jbg${n}" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#1B1E27"/><stop offset="1" stop-color="#0B0D12"/></linearGradient>
  <linearGradient id="jsheen${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <clipPath id="jclip${n}"><rect width="1024" height="1024" rx="228"/></clipPath>
</defs>
<g clip-path="url(#jclip${n})">
  <rect width="1024" height="1024" fill="url(#jbg${n})"/>
  <path d="M560 430 V 700 A 150 150 0 0 1 410 850 H 370" stroke="#F4F1EA" stroke-width="128" fill="none" stroke-linecap="round"/>
  <rect x="496" y="170" width="128" height="176" rx="22" fill="#FFB020"/>
  <rect width="1024" height="1024" fill="url(#jsheen${n})"/>
</g>`;
  return svg;
}

/** A link that opens outside the app, since a webview has nowhere to put a page. */
function link(label: string, url: string, note: string): HTMLElement {
  return h("button.linkish", {
    title: url,
    onclick: () => void openExternal(url).catch(() => { /* nothing useful to say if the OS refuses */ }),
  }, label, h("span.muted", {}, note));
}

/** What the app is, which build this is, and where to get another one. */
export function aboutDialog(): void {
  const close = (): void => backdrop.remove();
  const backdrop = modal("jockoshop", [
    h("div.about-head", {}, appMark(64),
      h("div", {},
        h("p", { style: "margin:0 0 2px" }, "A layered, non-destructive editor for ANSI and ASCII art."),
        h("p.hint", { style: "margin:0" }, `Version ${buildLabel()} · built ${__APP_BUILT__}`))),
    h("p.hint", {}, "Layers that stay editable — live text, live images, shapes and prose — over a CP437 grid, with the formats the scene actually uses: ANS, XBIN, TundraDraw, PETSCII and the rest."),
    h("div.about-links", {},
      link("GitHub repository", REPO_URL, "source, issues"),
      link("Release builds", RELEASES_URL, "macOS, Windows, Linux")),
    h("p.hint", {}, "Apache-2.0. The image converter is shadeans; TheDraw fonts come from Synchronet and the bitmap fonts from Moebius, each under its own licence — see NOTICE.md."),
  ], [h("button.primary", { onclick: close }, "Close")], 460);
  backdrop.querySelector<HTMLButtonElement>("button.primary")?.focus();
}
