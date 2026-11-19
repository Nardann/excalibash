// Runs before the app (no inline scripts under the CSP): self-hosted Excalidraw assets + theme.
window.EXCALIDRAW_ASSET_PATH = "/";
try {
  var t = localStorage.getItem("eb-theme");
  if (t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
} catch (e) {}
