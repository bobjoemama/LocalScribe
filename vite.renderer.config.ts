import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    sourcemap: process.env.LOCALSCRIBE_PRIVATE_SOURCEMAPS === "1",
  },
});
