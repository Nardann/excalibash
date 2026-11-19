import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.BACKEND ?? "http://127.0.0.1:6767";

/**
 * Excalidraw always adds esm.sh as a fallback source for its fonts. Everything is self-hosted
 * (and the CSP forbids third-party fonts), so point that fallback at our own origin.
 */
function selfHostedExcalidrawFonts(): Plugin {
  return {
    name: "excalibash:self-hosted-excalidraw-fonts",
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw") || !code.includes("https://esm.sh/")) return null;
      return code.replace(/`https:\/\/esm\.sh\/\$\{[\s\S]*?\}\/dist\/prod\/`/g, '(window.location.origin + "/")');
    },
  };
}

export default defineConfig({
  plugins: [react(), selfHostedExcalidrawFonts()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/install.sh": backend,
      "/downloads": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 4000 },
});
