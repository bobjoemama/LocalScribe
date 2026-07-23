import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // Public artifacts must not disclose application source through adjacent
    // maps. Opt in explicitly for a private diagnostic build only.
    sourcemap: process.env.LOCALSCRIBE_PRIVATE_SOURCEMAPS === "1",
    rollupOptions: {
      external: ["better-sqlite3", "uiohook-napi"],
    },
  },
});
