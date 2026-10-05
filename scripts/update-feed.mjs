#!/usr/bin/env node
/**
 * The updater's latest.json for one release, from the signed assets the build
 * jobs attached to it:
 *
 *   node scripts/update-feed.mjs v0.1.16 > latest.json
 *
 * Built once, after every build job has finished, rather than by tauri-action's
 * includeUpdaterJson — that has each job download the release's latest.json,
 * add its own platform and upload it again, and jobs running side by side can
 * each overwrite the other's platform.
 *
 * A platform whose build failed (no asset, or no signature) is left out with a
 * warning: those installs stay where they are until the next release. Needs
 * the gh CLI, logged in (GH_TOKEN in Actions).
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** updater platform key -> the asset that installs it, in order of preference */
export const PLATFORMS = {
  "darwin-aarch64": [/_aarch64\.app\.tar\.gz$/],
  "darwin-x86_64": [/_x64\.app\.tar\.gz$/],
  "windows-x86_64": [/_x64-setup\.exe$/, /_x64_en-US\.msi$/],
  "linux-x86_64": [/_amd64\.AppImage$/],
};

/**
 * @param {{ tag: string, notes: string, pubDate: string, assets: { name: string, url: string }[] }} release
 * @param {(name: string) => string} readSig the text of a `.sig` asset
 */
export function buildFeed(release, readSig) {
  const names = new Set(release.assets.map((a) => a.name));
  const platforms = {};
  const missing = [];
  for (const [key, patterns] of Object.entries(PLATFORMS)) {
    const asset = patterns.map((p) => release.assets.find((a) => p.test(a.name) && names.has(`${a.name}.sig`))).find(Boolean);
    if (!asset) { missing.push(key); continue; }
    const signature = readSig(`${asset.name}.sig`).trim();
    if (!signature) { missing.push(key); continue; }
    platforms[key] = { signature, url: asset.url };
  }
  if (!Object.keys(platforms).length) throw new Error(`${release.tag}: no signed updater assets at all — was TAURI_SIGNING_PRIVATE_KEY set?`);
  return { feed: { version: release.tag.replace(/^v/, ""), notes: release.notes, pub_date: release.pubDate, platforms }, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  if (!tag) { console.error("usage: update-feed.mjs <tag>"); process.exit(2); }
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 26 });
  const r = JSON.parse(gh("release", "view", tag, "--json", "assets,body,publishedAt,createdAt"));
  const { feed, missing } = buildFeed(
    { tag, notes: r.body ?? "", pubDate: r.publishedAt || r.createdAt, assets: r.assets.map((a) => ({ name: a.name, url: a.url })) },
    (name) => gh("release", "download", tag, "--pattern", name, "--output", "-"),
  );
  for (const key of missing) console.error(`warning: ${tag} has no signed update for ${key}; those installs keep their version`);
  process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
}
