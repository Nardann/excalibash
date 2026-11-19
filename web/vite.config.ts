import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.BACKEND ?? "http://127.0.0.1:6767";

/**
 * Small build-time patches to Excalidraw:
 * - it always adds esm.sh as a fallback source for its fonts; everything is self-hosted
 *   (and the CSP forbids third-party fonts), so point that fallback at our own origin;
 * - it draws a "link" badge on every element with a link; terminal tiles need their internal
 *   link to render, but the badge has no meaning for them and clutters diagrams.
 */
function excalidrawPatches(): Plugin {
  return {
    name: "excalibash:excalidraw-patches",
    transform(code, id) {
      if (!id.includes("@excalidraw/excalidraw")) return null;
      let out = code.replace(/`https:\/\/esm\.sh\/\$\{[\s\S]*?\}\/dist\/prod\/`/g, '(window.location.origin + "/")');
      out = out.replace(/if\((\w+)\.link&&!(\w+)\.selectedElementIds\[\1\.id\]\)/g, "if($1.link&&!$1.customData?.terminalId&&!$2.selectedElementIds[$1.id])");
      return out === code ? null : out;
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawPatches()],
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
