import type { Request } from "express";
import { config } from "./config.ts";
import { knownHostnames } from "./tls.ts";
import type { MailLink } from "./mailTemplate.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Opaque client-produced blob (ciphertext, key, wrapped key): must be a non-empty base64url string. */
export function blob(v: unknown, max = 8192): string {
  if (typeof v !== "string" || !v || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) throw new HttpError(400, "Données chiffrées invalides");
  return v;
}

export const pid = (req: Request, name = "id"): string => String(req.params[name]);

export function publicUrl(req: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

let warnedHost = false;

/**
 * A link for an email sent to someone else. Without PUBLIC_URL the address comes from the Host
 * header, which the sender controls: only a name this instance knows as its own is used, otherwise
 * the email goes without the link (a forged Host would send the recipient elsewhere).
 */
export function mailLink(req: Request, path: string, label: string): MailLink | undefined {
  if (config.publicUrl) return { label, url: config.publicUrl.replace(/\/$/, "") + path };
  const host = req.hostname?.replace(/^\[|\]$/g, "").toLowerCase();
  if (host && knownHostnames().includes(host)) return { label, url: publicUrl(req) + path };
  if (!warnedHost) {
    warnedHost = true;
    console.warn(`[mail] hôte « ${host} » inconnu : liens retirés des emails. Définir PUBLIC_URL.`);
  }
  return undefined;
}
