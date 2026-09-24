#!/usr/bin/env node
// Copies TheDraw fonts into the app's public folder and builds the picker index.
// The fonts are not part of this repo: they ship with Synchronet (ctrl/tdfonts),
// all 1,071 of them. With no argument this looks for a local Synchronet, and
// failing that fetches just that one directory from Synchronet's GitHub repo.
//   node scripts/sync-fonts.mjs [/path/to/tdfonts]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Where a Synchronet install keeps them, on the usual platforms. */
const LOCAL = [
  "/sbbs/ctrl/tdfonts", "/usr/local/sbbs/ctrl/tdfonts", "/opt/sbbs/ctrl/tdfonts",
  join(homedir(), "sbbs/ctrl/tdfonts"), "C:\\sbbs\\ctrl\\tdfonts",
];

/**
 * Synchronet's repo is large, so take only ctrl/tdfonts: a blobless sparse
 * clone, the same one CI does. Cached in node_modules so a second run is instant.
 */
function fetchFonts() {
  const at = join(root, "node_modules/.cache/sbbs");
  const fonts = join(at, "ctrl/tdfonts");
  if (existsSync(fonts)) return fonts;
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); }
  catch { fail("git is not installed, so the fonts cannot be fetched automatically."); }
  console.log("fetching TheDraw fonts from Synchronet (ctrl/tdfonts only)…");
  mkdirSync(join(root, "node_modules/.cache"), { recursive: true });
  try {
    execFileSync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse",
      "https://github.com/SynchronetBBS/sbbs.git", at], { stdio: "inherit" });
    execFileSync("git", ["-C", at, "sparse-checkout", "set", "ctrl/tdfonts"], { stdio: "inherit" });
  } catch { fail("could not fetch the fonts (no network, or the clone failed)."); }
  if (!existsSync(fonts)) fail("the clone worked but ctrl/tdfonts is not in it.");
  return fonts;
}

function fail(why) {
  console.error(`\nTheDraw fonts: ${why}\n`);
  console.error("They ship with Synchronet. Either point this at a copy you have:");
  console.error("    npm run fonts -- /path/to/ctrl/tdfonts");
  console.error("or fetch them by hand:");
  console.error("    git clone --depth 1 --filter=blob:none --sparse https://github.com/SynchronetBBS/sbbs.git");
  console.error("    git -C sbbs sparse-checkout set ctrl/tdfonts");
  console.error("    npm run fonts -- sbbs/ctrl/tdfonts\n");
  console.error("The editor runs without them; only TheDraw text layers need them.\n");
  process.exit(1);
}

const given = process.argv[2];
if (given && !existsSync(given)) fail(`there is no such directory: ${given}`);
const src = given ?? LOCAL.find((p) => existsSync(p)) ?? fetchFonts();
if (!given) console.log(`fonts from ${src}`);
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
