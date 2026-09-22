import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // use the core's sources directly, so there is no build step between the packages in dev
    alias: { "@killerdraw/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
  server: { port: 5183, strictPort: true },
});
