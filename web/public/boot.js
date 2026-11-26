// Runs before the app (no inline scripts under the CSP): self-hosted Excalidraw assets + theme.
window.EXCALIDRAW_ASSET_PATH = "/";
try {
  // The theme shown (src/themes.ts): light or dark (or the system's choice), with the CSS
  // variables of the theme chosen for that base, stored by the app.
  var mode = localStorage.getItem("eb-theme");
  var root = document.documentElement;
  var dark = mode === "dark" || (mode !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) root.classList.add("dark");
  var saved = JSON.parse(localStorage.getItem("eb-theme-vars") || "null");
  var vars = saved && saved[dark ? "dark" : "light"];
  if (vars && typeof vars === "object") {
    for (var k in vars) {
      // Only the forms themes.ts produces: #rrggbb colors and rgba(r, g, b, a).
      var val = vars[k];
      if (/^[a-z0-9-]{1,32}$/.test(k) && typeof val === "string" && /^(#[0-9a-fA-F]{3,8}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [\d.]{1,5}\))$/.test(val)) {
        root.style.setProperty("--" + k, val);
      }
    }
  }
} catch (e) {}
