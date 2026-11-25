// Bundles the MCP client (../mcp/src/main.ts) with the web app's crypto code into a single
// ESM file, runnable with Node >= 22 and no node_modules.
import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  publicDir: false,
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "../mcp/src/main.ts",
    outDir: "../mcp/dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      output: { format: "es", entryFileNames: "excalibash-mcp.mjs", banner: "#!/usr/bin/env node", codeSplitting: false },
    },
  },
});
