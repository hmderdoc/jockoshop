import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * What the About box shows. The version comes from tauri.conf.json, which is
 * what a release is tagged from, so the number in the app is the number on the
 * installer rather than a second one kept in step by hand.
 */
const tauriConf = JSON.parse(readFileSync(new URL("../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { version: string };
const git = (cmd: string, fallback: string): string => {
  try { return execSync(cmd, { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback; }
  catch { return fallback; }   // a source tarball with no .git is not an error
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(tauriConf.version),
    __APP_COMMIT__: JSON.stringify(git("git rev-parse --short HEAD", "unknown")),
    // -dirty when the build has uncommitted changes, so a local build never
    // claims to be the release it was built next to
    __APP_DIRTY__: JSON.stringify(git("git status --porcelain", "") !== ""),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  resolve: {
    // use the core's sources directly, so there is no build step between the packages in dev
    alias: { "@killerdraw/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  // "localhost" can resolve to ::1 alone, and then nothing answers on 127.0.0.1 —
  // which is what the smoke scripts drive. Bind both.
  server: { port: 5183, strictPort: true, host: "0.0.0.0" },
});
