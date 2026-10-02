#!/usr/bin/env node
/**
 * Platform icons, from docs/icon.svg.
 *
 *   node scripts/make-icon.mjs      (or: npm run icon)
 *
 * The artwork is a vector, so this rasterizes it with the headless Chrome the
 * smoke tests already use rather than keeping a hand-exported PNG around that
 * nobody can regenerate.
 *
 * macOS gets a different raster from everyone else. A Mac icon is expected to
 * sit inside a margin — measured against Calculator, Mail and Notes, the
 * artwork is 828 x 837 of 1024, about 81% of the canvas, with ~100px clear on
 * each side. Full-bleed artwork is then a quarter larger than every icon
 * beside it in the dock, which reads as wrong without being obviously wrong.
 * Windows and Linux expect no such inset, so they keep the full-bleed raster.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const SVG = join(root, "docs/icon.svg");
const PNG = join(root, "docs/icon.png");
const FAVICON = join(root, "packages/app/public/favicon.png");
const ICONS = join(root, "packages/desktop/src-tauri/icons");

/** Apple's icon grid: an 824-wide body centred in 1024, so ~100px of margin. */
const MAC_BODY = 824, CANVAS = 1024;

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), ".cache/puppeteer/chrome-headless-shell");
  const arch = process.arch === "arm64" ? "mac_arm-" : "mac-";
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith(arch)).sort((a, b) => parseInt(b.split("-")[1]) - parseInt(a.split("-")[1])) : [];
  for (const d of dirs) {
    const inner = readdirSync(join(base, d))[0];
    const bin = join(base, d, inner, "chrome-headless-shell");
    if (existsSync(bin)) return bin;
  }
  throw new Error("no Chrome found: set CHROME_PATH, or run `npm run smoke` once to fetch it");
}

/** The artwork, optionally inset into the canvas the way macOS wants it. */
function page(svg, inset) {
  const body = inset
    ? `<g transform="translate(${(CANVAS - MAC_BODY) / 2} ${(CANVAS - MAC_BODY) / 2}) scale(${MAC_BODY / CANVAS})">${svg}</g>`
    : svg;
  // the SVG carries its own width/height; strip them so it fills the viewport
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">${body}</svg>`;
}

const svg = readFileSync(SVG, "utf8").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const browser = await puppeteer.launch({ executablePath: findChrome(), args: ["--no-sandbox", "--force-device-scale-factor=1"] });
const tab = await browser.newPage();
await tab.setViewport({ width: CANVAS, height: CANVAS });

const shoot = async (inset, out) => {
  await tab.setContent(page(svg, inset), { waitUntil: "load" });
  // omitBackground keeps the corners outside the rounded rect transparent
  writeFileSync(out, await tab.screenshot({ omitBackground: true, type: "png" }));
  console.log(`${inset ? "macOS (inset)" : "full bleed  "}  ->  ${out.replace(root, "")}`);
};

const tmp = mkdtempSync(join(tmpdir(), "jockoicon-"));
const macPng = join(tmp, "icon-macos.png");
await shoot(false, PNG);
await shoot(true, macPng);
await browser.close();

const tauri = (args) => execFileSync("npx", ["tauri", ...args], { cwd: join(root, "packages/desktop"), stdio: "inherit" });

// everything from the full-bleed artwork …
tauri(["icon", PNG]);
// … then macOS's own, which is the only one that wants the margin
const macOut = join(tmp, "out");
tauri(["icon", macPng, "--output", macOut]);
writeFileSync(join(ICONS, "icon.icns"), readFileSync(join(macOut, "icon.icns")));
console.log("icon.icns replaced with the inset build");

writeFileSync(FAVICON, readFileSync(PNG));
rmSync(tmp, { recursive: true, force: true });
console.log("favicon.png updated");
