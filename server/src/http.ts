import type { Request } from "express";
import { config } from "./config.ts";

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
