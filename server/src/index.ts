import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { config } from "./config.ts";
import { pruneSessions, userFromRequest } from "./auth.ts";
import { HttpError, publicUrl } from "./http.ts";
import { announceSetup, authApi } from "./api/auth.ts";
import { itemsApi } from "./api/items.ts";
import { machinesApi } from "./api/machines.ts";
import { adminApi } from "./api/admin.ts";
import { getItem, isTrashed, roleOn } from "./access.ts";
import { joinBoard, flushAllRooms } from "./rooms.ts";
import { authenticateAgent, handleAgent } from "./terminals.ts";
import { installScript, uninstallScript } from "./install.ts";
import { pairScript, pairingAgentApi, pairingOwnerApi } from "./api/pairing.ts";
import { accountApi } from "./api/account.ts";
import { proxyUrl, startProxy } from "./proxy.ts";
import { certificatePem, initTls, pinFor, serve, tlsInfo } from "./tls.ts";

initTls();

const CSP = [
  "default-src 'self'",
  // Argon2 runs as WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Installing a library from libraries.excalidraw.com fetches it from there (explicit user action).
  "connect-src 'self' https://libraries.excalidraw.com",
  "worker-src 'self' blob:",
  // Excalidraw's own embeds (YouTube, Figma…) are third-party iframes; web tunnels use the proxy origin.
  "frame-src 'self' https: __PROXY__",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": CSP.replace("__PROXY__", new URL(proxyUrl(req)).origin),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/config", (req, res) => {
  res.json({
    proxyUrl: proxyUrl(req),
    emailVerification: !!(config.smtp.host || config.smtp.transport === "log"),
    contactEmail: config.contactEmail || null,
    legalName: config.legalName || null,
    tls: tlsInfo(req),
  });
});
// Small bodies before authentication; large ones (board content, key rotation) only for signed-in users.
const small = express.json({ limit: "256kb" });
const large = express.json({ limit: "200mb" });
app.use("/api/auth", small, authApi);
app.use("/api/machines/pairings", small, pairingOwnerApi);
app.use("/api/machines", small, machinesApi);
app.use("/api/pair", small, pairingAgentApi);
app.use("/api/admin", small, adminApi);
app.use("/api/account", small, accountApi);
app.use("/api", (req, res, next) => (userFromRequest(req) ? large : small)(req, res, next), itemsApi);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Introuvable" });
});
app.use("/api", (err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Contenu trop volumineux" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Erreur serveur" });
});

const AGENT_FILE = /^excalibash-agent-(linux|darwin)-(amd64|arm64)$/;

app.get("/p/:code", (req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(pairScript(publicUrl(req), String(req.params.code), pinFor(req)));
});

app.get("/uninstall.sh", (_req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(uninstallScript());
});

app.get("/install.sh", (req, res) => {
  res.type("text/x-shellscript").send(installScript(publicUrl(req), pinFor(req)));
});

app.get("/certificate.pem", (_req, res) => {
  const pem = certificatePem();
  if (!pem) {
    res.status(404).send("not found\n");
    return;
  }
  res.attachment("excalibash.pem").type("application/x-pem-file").send(Buffer.from(pem));
});

app.get("/downloads", (_req, res) => {
  const files = existsSync(config.agentDistDir) ? readdirSync(config.agentDistDir).filter((f) => AGENT_FILE.test(f)) : [];
  res.json({ files });
});

app.get("/downloads/:file", (req, res) => {
  const file = req.params.file;
  if (!AGENT_FILE.test(file) || !existsSync(join(config.agentDistDir, file))) {
    res.status(404).send("not found\n");
    return;
  }
  res.download(join(config.agentDistDir, file));
});

if (existsSync(config.webDir)) {
  app.use(express.static(config.webDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws|agent).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(join(config.webDir, "index.html"));
  });
} else {
  console.warn(`[web] ${config.webDir} absent — lance le frontend avec \`npm run dev\` dans web/`);
}

const boardWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
// Web tunnel responses (up to ~48 MB of body, base64) travel on the agent socket.
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024 * 1024 });

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://x");
  const reject = (code: number, text: string) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };

  if (url.pathname === "/agent") {
    const machineId = authenticateAgent(req);
    if (!machineId) return reject(401, "Unauthorized");
    agentWss.handleUpgrade(req, socket, head, (ws) => handleAgent(ws, machineId));
    return;
  }

  if (url.pathname === "/ws") {
    // Cookies are SameSite=Strict, but a cross-site page could still open a socket: check the origin.
    const origin = req.headers.origin;
    let sameOrigin = true;
    try {
      sameOrigin = !origin || new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false; // "null" or garbage
    }
    if (!sameOrigin) return reject(403, "Forbidden");
    const user = userFromRequest(req);
    if (!user) return reject(401, "Unauthorized");
    const item = getItem(url.searchParams.get("board") ?? "");
    const role = item ? roleOn(user.id, item.id) : undefined;
    if (!item || item.kind !== "board" || !role || isTrashed(item.id)) return reject(403, "Forbidden");
    boardWss.handleUpgrade(req, socket, head, (ws) => joinBoard(ws, user, item.id, role));
    return;
  }

  reject(404, "Not Found");
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Arrêt…");
  flushAllRooms();
  server.close();
  proxy.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(pruneSessions, 3600_000).unref();

const server = serve(app, config.port, "Excalibash", upgrade);
const proxy = startProxy();
announceSetup();
