#!/usr/bin/env node
// Builds packages/app/public/shadeans.wasm from a pinned shadeans commit.
// Needs: Rust with `rustup target add wasm32-unknown-unknown`.
//   node scripts/build-shadeans.mjs [path/to/local/shadeans]   (a local checkout skips the clone)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/hmderdoc/shadeans.git";
const COMMIT = "6b536744db0bd8a23bbf5564163c4c78a5f2b30f";   // 0.3.0

const root = fileURLToPath(new URL("..", import.meta.url));
const crate = join(root, "packages/shadeans-wasm");
const vendor = join(crate, "vendor/shadeans");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

mkdirSync(join(crate, "vendor"), { recursive: true });
if (process.argv[2]) {
  rmSync(vendor, { recursive: true, force: true });
  symlinkSync(resolve(process.argv[2]), vendor);
  console.log(`using local shadeans at ${resolve(process.argv[2])}`);
} else {
  if (!existsSync(join(vendor, ".git"))) { rmSync(vendor, { recursive: true, force: true }); run("git", ["clone", "-q", REPO, vendor]); }
  run("git", ["fetch", "-q", "origin"], vendor);
  run("git", ["checkout", "-q", COMMIT], vendor);
}
run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], crate);
const built = join(crate, "target/wasm32-unknown-unknown/release/shadeans_wasm.wasm");
const dest = join(root, "packages/app/public/shadeans.wasm");
copyFileSync(built, dest);
console.log(`${dest}  ${(statSync(dest).size / 1024).toFixed(0)} KB`);
