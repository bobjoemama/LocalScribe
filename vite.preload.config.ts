import { defineConfig, type Plugin } from "vite";

const forgeVite8PreloadOutput: Plugin = {
  name: "localscribe-forge-vite8-preload-output",
  configResolved(config) {
    const output = config.build.rollupOptions.output;
    if (!output || Array.isArray(output)) return;
    const outputOptions = output as unknown as Record<string, unknown>;
    // Forge 7.11 still emits Rollup's deprecated spelling. Vite 8/Rolldown
    // preserves the same no-split preload contract through `codeSplitting`.
    delete outputOptions.inlineDynamicImports;
    outputOptions.codeSplitting = false;
  },
};

export default defineConfig({
  plugins: [forgeVite8PreloadOutput],
  build: {
    sourcemap: process.env.LOCALSCRIBE_PRIVATE_SOURCEMAPS === "1",
  },
});
