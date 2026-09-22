#!/usr/bin/env node
// Copies TheDraw fonts into the app's public folder and builds the picker index.
// The fonts are not part of this repo: they ship with Synchronet (ctrl/tdfonts).
//   node scripts/sync-fonts.mjs [/path/to/tdfonts]
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const src = process.argv[2] ?? "/Volumes/Crucial2TB/Projects/synchronet/sbbs/ctrl/tdfonts";
const root = fileURLToPath(new URL("..", import.meta.url));
const dest = join(root, "packages/app/public/tdfonts");
// a file URL, not a path: on Windows an absolute path is not a valid ESM specifier
const { parseTdf, tdfTypeName } = await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href);

mkdirSync(dest, { recursive: true });
const index = [];
let skipped = 0;
for (const file of readdirSync(src).filter((f) => /\.tdf$/i.test(f)).sort()) {
  try {
    const fonts = parseTdf(new Uint8Array(readFileSync(join(src, file))));
    copyFileSync(join(src, file), join(dest, file));
    index.push({ file, fonts: fonts.map((f) => ({ name: f.name, height: f.height, type: tdfTypeName(f.type) })) });
  } catch { skipped++; }
}
writeFileSync(join(dest, "index.json"), JSON.stringify(index));
console.log(`${index.length} font files (${index.reduce((n, f) => n + f.fonts.length, 0)} fonts) -> ${dest}${skipped ? `, ${skipped} skipped` : ""}`);
