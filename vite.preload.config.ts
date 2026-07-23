import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: process.env.LOCALSCRIBE_PRIVATE_SOURCEMAPS === "1",
  },
});
