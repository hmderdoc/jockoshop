#!/usr/bin/env node
// What is installed, and what each part of the build still needs. Run it before
// a long compile finds out for you:  npm run doctor
//
// Nothing here is required to *use* jockoshop: the editor runs from `npm run dev`
// with Node alone. Rust is for the desktop shell and the image converter.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const linux = process.platform === "linux";
const notes = [];

/** Run a command for its output; undefined if it is not there or fails. */
function run(cmd, args) {
  try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return undefined; }
}

const ok = (what, detail) => console.log(`  ok    ${what}${detail ? `  ${detail}` : ""}`);
const no = (what, detail, fix) => {
  console.log(`  MISS  ${what}${detail ? `  ${detail}` : ""}`);
  if (fix) notes.push(fix);
};

console.log("\njockoshop prerequisites\n");

// ---- the editor itself: Node only -----------------------------------------
console.log("the editor (npm run dev)");
const want = readFileSync(join(root, ".nvmrc"), "utf8").trim();
const major = (v) => Number(v.replace(/^v/, "").split(".")[0]);
if (major(process.version) >= major(want)) ok("node", `${process.version} (want ${want}+)`);
else no("node", `${process.version}, want ${want}+`, `Node is too old: install ${want} (nvm: \`nvm use\` in this directory).`);
ok("npm packages", existsSync(join(root, "node_modules")) ? "installed" : "run `npm install`");

// ---- optional extras -------------------------------------------------------
console.log("\noptional — the editor runs without these, and says what is missing");
const fonts = join(root, "packages/app/public/tdfonts");
if (existsSync(fonts)) ok("TheDraw fonts", "packages/app/public/tdfonts");
else no("TheDraw fonts", "text layers have no fonts to offer", "TheDraw fonts: `npm run fonts` (needs a Synchronet checkout, or it clones one).");
if (existsSync(join(root, "packages/app/public/shadeans.wasm"))) ok("shadeans.wasm", "image layers work");
else no("shadeans.wasm", "image layers cannot convert", "Image converter: `npm run shadeans` (needs Rust + `rustup target add wasm32-unknown-unknown`).");

// ---- Rust: the desktop shell and the wasm converter ------------------------
console.log("\nthe desktop app (npm run desktop) and shadeans");
// The oldest rustc Tauri's dependency tree has been seen to accept. It only
// climbs; a build that stops with "<crate> requires rustc 1.xx" means raise this.
const MIN_RUSTC = [1, 88];
const rustc = run("rustc", ["--version"]);
if (rustc) {
  const found = (/(\d+)\.(\d+)/.exec(rustc) ?? []).slice(1).map(Number);
  const old = found.length === 2 && (found[0] < MIN_RUSTC[0] || (found[0] === MIN_RUSTC[0] && found[1] < MIN_RUSTC[1]));
  const version = rustc.replace(/^rustc /, "");
  if (old) no("rustc", `${version}, want ${MIN_RUSTC.join(".")}+`, "Rust is too old for Tauri's dependencies: `rustup update stable`.");
  else ok("rustc", version);
  const which = run(process.platform === "win32" ? "where" : "which", ["rustc"]);
  if (which && /^\/usr\/bin\//.test(which)) {
    notes.push("rustc comes from your distro (/usr/bin/rustc), which is usually too old for Tauri and never updates: install rustup (https://rustup.rs) and open a new shell.");
  }
  const targets = run("rustup", ["target", "list", "--installed"]) ?? "";
  if (targets.includes("wasm32-unknown-unknown")) ok("wasm32 target");
  else no("wasm32 target", "needed by `npm run shadeans`", "wasm target: `rustup target add wasm32-unknown-unknown`.");
} else {
  no("rustc", "not installed", "Rust: install rustup (https://rustup.rs), then `rustup update stable`. Only needed for the desktop app and the image converter.");
}

// ---- Linux system libraries ------------------------------------------------
if (linux) {
  console.log("\nsystem libraries (Linux only — what gdk-sys, webkit2gtk-sys … link against)");
  const pkgconfig = run("pkg-config", ["--version"]);
  if (!pkgconfig) {
    no("pkg-config", "not installed", "pkg-config: `sudo apt install pkg-config build-essential`.");
  } else {
    ok("pkg-config", pkgconfig);
    // the modules whose absence produces the "was not found in the pkg-config search path" wall
    let missing = false;
    for (const mod of ["gdk-3.0", "webkit2gtk-4.1", "javascriptcoregtk-4.1", "libsoup-3.0"]) {
      const version = run("pkg-config", ["--modversion", mod]);
      if (version) ok(mod, version); else { no(mod); missing = true; }
    }
    if (missing) {
      notes.push("Linux packages Tauri needs (the same ones CI installs):\n"
        + "    sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev patchelf libxdo-dev libssl-dev \\\n"
        + "                     libayatana-appindicator3-dev build-essential pkg-config\n"
        + "    Debian 11 / Ubuntu 22.04 and older may only have webkit2gtk 4.0, which Tauri 2 cannot use — you need a newer release.");
    }
  }
  if (/microsoft/i.test(run("uname", ["-r"]) ?? "")) {
    notes.push("This is WSL, so the desktop build produces a *Linux* binary and `tauri dev` needs a display (WSLg). For a Windows .exe, build from PowerShell instead.");
    if (/^\/mnt\/[a-z]\//.test(root)) {
      notes.push(`The checkout is on a Windows drive (${root}). Compiling there is several times slower than from the WSL filesystem (~/), and some tools misbehave on it.`);
    }
  }
}

if (notes.length) {
  console.log("\nnext steps\n");
  for (const n of notes) console.log(`  - ${n}`);
}
console.log("\nJust want to draw? `npm run dev` needs none of the above beyond Node,");
console.log("and the Releases page has prebuilt apps: https://github.com/hmderdoc/jockoshop/releases\n");
