import { describe, expect, it } from "vitest";
import { buildFeed } from "./update-feed.mjs";

// the asset names v0.1.15's release actually has, plus the .sig files signing adds
const BASE = "https://github.com/hmderdoc/jockoshop/releases/download/v0.1.16/";
const NAMES = [
  "jockoshop-0.1.16-1.x86_64.rpm", "jockoshop_0.1.16_aarch64.dmg", "jockoshop_0.1.16_amd64.AppImage",
  "jockoshop_0.1.16_amd64.deb", "jockoshop_0.1.16_x64-setup.exe", "jockoshop_0.1.16_x64.dmg",
  "jockoshop_0.1.16_x64_en-US.msi", "jockoshop_aarch64.app.tar.gz", "jockoshop_x64.app.tar.gz",
];
const SIGNED = ["jockoshop_aarch64.app.tar.gz", "jockoshop_x64.app.tar.gz", "jockoshop_0.1.16_x64-setup.exe", "jockoshop_0.1.16_x64_en-US.msi", "jockoshop_0.1.16_amd64.AppImage"];
const release = (names) => ({ tag: "v0.1.16", notes: "notes", pubDate: "2026-10-05T00:00:00Z", assets: names.map((name) => ({ name, url: BASE + name })) });
const sig = (name) => `sig of ${name}\n`;

describe("update feed", () => {
  it("maps each platform to its updater asset and signature", () => {
    const { feed, missing } = buildFeed(release([...NAMES, ...SIGNED.map((n) => `${n}.sig`)]), sig);
    expect(missing).toEqual([]);
    expect(feed.version).toBe("0.1.16");
    expect(feed.platforms).toEqual({
      "darwin-aarch64": { signature: "sig of jockoshop_aarch64.app.tar.gz.sig", url: `${BASE}jockoshop_aarch64.app.tar.gz` },
      "darwin-x86_64": { signature: "sig of jockoshop_x64.app.tar.gz.sig", url: `${BASE}jockoshop_x64.app.tar.gz` },
      "windows-x86_64": { signature: "sig of jockoshop_0.1.16_x64-setup.exe.sig", url: `${BASE}jockoshop_0.1.16_x64-setup.exe` },
      "linux-x86_64": { signature: "sig of jockoshop_0.1.16_amd64.AppImage.sig", url: `${BASE}jockoshop_0.1.16_amd64.AppImage` },
    });
  });

  it("falls back to the MSI on Windows, and leaves out a platform with no signed asset", () => {
    const signed = SIGNED.filter((n) => !n.endsWith("setup.exe") && !n.endsWith("AppImage"));
    const { feed, missing } = buildFeed(release([...NAMES, ...signed.map((n) => `${n}.sig`)]), sig);
    expect(feed.platforms["windows-x86_64"].url).toBe(`${BASE}jockoshop_0.1.16_x64_en-US.msi`);
    expect(missing).toEqual(["linux-x86_64"]);
  });

  it("refuses a release with nothing signed (an unsigned build is not an update)", () => {
    expect(() => buildFeed(release(NAMES), sig)).toThrow(/no signed updater assets/);
  });
});
