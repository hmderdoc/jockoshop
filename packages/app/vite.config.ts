import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // use the core's sources directly, so there is no build step between the packages in dev
    alias: { "@killerdraw/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  // "localhost" can resolve to ::1 alone, and then nothing answers on 127.0.0.1 —
  // which is what the smoke scripts drive. Bind both.
  server: { port: 5183, strictPort: true, host: "0.0.0.0" },
});
