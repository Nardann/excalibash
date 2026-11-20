import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request } from "express";
import { config } from "./config.ts";
import { rateLimit } from "./auth.ts";
import { relay, tunnelExists } from "./tunnels.ts";

// Second origin for web tunnels. Tunnelled sites run here, isolated from Excalibash's own origin
// (its storage holds the account keys). This server only hands out the boot page and service
// worker, and relays encrypted frames; it holds no session and decrypts nothing.

const ID = /^[A-Za-z0-9_-]{16,43}$/;

/** Excalibash's own origin, the only one allowed to hand tunnel keys to this origin. */
export function mainOrigin(req: Request): string {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  return `${req.protocol}://${req.hostname}:${config.port}`;
}

/** Public URL of the proxy origin, as seen from Excalibash's own origin. */
export function proxyUrl(req: Request): string {
  if (config.proxyUrl) return config.proxyUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.hostname}:${config.proxyPort}`;
}

const asset = (name: string) => readFileSync(join(import.meta.dirname, "proxy", name), "utf8");
const SW = asset("sw.js");
const BOOT = asset("boot.js");

const bootHtml = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Excalibash · tunnel</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#e2e8f0;font:600 14px system-ui,sans-serif}</style>
</head><body><p id="status">Chargement…</p><script src="/eb-proxy/boot.js"></script></body></html>`;

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");

app.get("/eb-proxy/sw.js", (req, res) => {
  res
    .type("application/javascript")
    .set({ "Service-Worker-Allowed": "/", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" })
    .send(SW.replace("__MAIN_ORIGIN__", mainOrigin(req)));
});

app.get("/eb-proxy/boot.js", (req, res) => {
  res.type("application/javascript").set("Cache-Control", "no-cache").send(BOOT.replace("__MAIN_ORIGIN__", mainOrigin(req)));
});

/** Rejects unknown tunnels and floods before reading the body: this origin has no authentication. */
function tunnelGuard(req: Request, res: express.Response, next: express.NextFunction) {
  const id = String(req.params.id);
  if (!rateLimit(`proxy:${req.ip}`, 2000)) {
    res.status(429).json({ error: "trop de requêtes" });
    return;
  }
  if (!ID.test(id) || !tunnelExists(id)) {
    res.status(404).json({ error: "tunnel inconnu" });
    return;
  }
  next();
}

app.post("/eb-proxy/req/:id", tunnelGuard, express.json({ limit: "64mb" }), async (req, res) => {
  const id = String(req.params.id);
  const { rid, ts, d } = req.body ?? {};
  if (typeof rid !== "string" || rid.length > 64 || !Number.isSafeInteger(ts) || typeof d !== "string") {
    res.status(400).json({ error: "requête invalide" });
    return;
  }
  const reply = await relay(id, rid, ts, d);
  if (reply === null) {
    res.status(504).json({ error: "machine hors ligne ou sans réponse" });
    return;
  }
  res.set("Cache-Control", "no-store").json({ d: reply });
});

// Anything else, before the service worker controls the page: the boot page.
app.get(/.*/, (req, res) => {
  res
    .type("html")
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${mainOrigin(req)}`,
      "Referrer-Policy": "no-referrer",
    })
    .send(bootHtml);
});

export function startProxy(): void {
  createServer(app).listen(config.proxyPort, config.host, () => {
    console.log(`Tunnels web (origine séparée) sur http://${config.host}:${config.proxyPort}`);
  });
}
