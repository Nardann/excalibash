import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

export const config = {
  port: Number(process.env.PORT ?? 6767),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: resolve(process.env.DATA_DIR ?? resolve(root, "data")),
  get dbPath() {
    return resolve(this.dataDir, "excalibash.db");
  },
  /** Built frontend served as static files. */
  webDir: resolve(process.env.WEB_DIR ?? resolve(root, "web", "dist")),
  /** Cross-compiled agent binaries offered for download. */
  agentDistDir: resolve(process.env.AGENT_DIST_DIR ?? resolve(root, "agent", "dist")),
  /** Public URL used in agent install commands (falls back to the request's host). */
  publicUrl: process.env.PUBLIC_URL ?? "",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Encrypted scrollback kept per terminal, replayed to new viewers. */
  scrollbackBytes: Number(process.env.SCROLLBACK_BYTES ?? 768 * 1024),
};
