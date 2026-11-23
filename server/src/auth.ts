import { scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { db, serverSecret } from "./db.ts";
import { config } from "./config.ts";

export type User = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  color: string;
  publicKey: string;
};

export type UserRow = {
  id: string;
  email: string;
  name: string;
  auth_hash: string;
  kdf_salt: string;
  public_key: string;
  enc_private_key: string;
  recovery_enc_private_key: string;
  recovery_auth_hash: string;
  enc_vault: string | null;
  is_admin: number;
  color: string;
  findable_name: number;
  findable_email: number;
  created_at: number;
};

export const COOKIE = "eb_session";

const COLORS = ["#4f46e5", "#e11d48", "#059669", "#d97706", "#0891b2", "#7c3aed", "#db2777", "#65a30d"];

export function pickColor(n: number): string {
  return COLORS[n % COLORS.length];
}

export function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name, isAdmin: !!r.is_admin, color: r.color, publicKey: r.public_key };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Hashes a client-derived key (never a password: the browser only ever sends
 * Argon2id-derived material). scrypt on top means a stolen database is still costly to use.
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const DUMMY_HASH = hashSecret("excalibash-dummy");

/** Same cost as a real check, so unknown emails cannot be told apart by timing. */
export function burnVerify(secret: string): false {
  verifySecret(secret, DUMMY_HASH);
  return false;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(secret, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Same answer shape for unknown emails, so prelogin does not reveal who has an account. */
export function fakeSalt(email: string): string {
  return createHmac("sha256", serverSecret()).update(email.trim().toLowerCase()).digest().subarray(0, 16).toString("base64url");
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) as UserRow | undefined;
}

export function getUserRow(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function createSession(req: Request, res: Response, userId: string): void {
  const token = randomBytes(32).toString("base64url");
  const expires = Date.now() + config.sessionDays * 86400_000;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, expires);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure || req.secure,
    expires: new Date(expires),
    path: "/",
  });
}

export function currentSessionHash(req: IncomingMessage): string | undefined {
  const token = readCookie(req.headers.cookie, COOKIE);
  return token ? sha256(token) : undefined;
}

export function destroySession(req: Request, res: Response): void {
  const hash = currentSessionHash(req);
  if (hash) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  res.clearCookie(COOKIE, { path: "/" });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Resolves the user from the session cookie of an HTTP request or WebSocket upgrade. */
export function userFromRequest(req: IncomingMessage): User | undefined {
  const hash = currentSessionHash(req);
  if (!hash) return undefined;
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended = 0")
    .get(hash, Date.now()) as UserRow | undefined;
  if (!row) return undefined;
  touchUser(row.id);
  return toUser(row);
}

const seen = new Map<string, number>();

/** Records activity at most once every 5 minutes per user. */
function touchUser(id: string): void {
  const now = Date.now();
  if ((seen.get(id) ?? 0) > now - 300_000) return;
  seen.set(id, now);
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, id);
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = userFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Non connecté" });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Réservé aux administrateurs" });
    return;
  }
  next();
}

export function pruneSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

// ---- Rate limiting for credential endpoints ---------------------------------------

const buckets = new Map<string, { count: number; reset: number }>();

/** Allows `limit` attempts per `windowMs` for a key (IP, or IP + email). */
export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();
