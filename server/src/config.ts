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
  /**
   * Which proxies may set X-Forwarded-*: by default only local/private networks (a reverse proxy
   * on the host or in Docker), so internet clients cannot spoof their IP or the protocol.
   */
  trustProxy: process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /**
   * Web tunnels are served from a *separate origin* (another port, or PROXY_URL behind a reverse
   * proxy), so the proxied sites can never touch Excalibash's own storage and keys.
   */
  /**
   * Outgoing email (verification codes). Without SMTP_HOST, accounts are not email-verified.
   * SMTP_TRANSPORT=log prints emails to the server log instead (development and tests).
   */
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true", // true for port 465
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
    transport: process.env.SMTP_TRANSPORT ?? "", // "log" for development
  },
  /** Public contact (abuse reports, privacy requests) shown on the privacy page. */
  contactEmail: process.env.CONTACT_EMAIL ?? "",
  /** Who runs this instance, shown on the privacy page. */
  legalName: process.env.LEGAL_NAME ?? "",
  /** Instance-wide cap on new accounts per hour (on top of per-IP limits). */
  registrationsPerHour: Number(process.env.REGISTRATIONS_PER_HOUR ?? 50),
  proxyPort: Number(process.env.PROXY_PORT ?? 6768),
  proxyUrl: process.env.PROXY_URL ?? "",
  /** Encrypted scrollback kept per terminal, replayed to new viewers. */
  scrollbackBytes: Number(process.env.SCROLLBACK_BYTES ?? 768 * 1024),
};
