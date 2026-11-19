import { Router } from "express";
import { randomBytes } from "node:crypto";
import { db, getSetting, isClientId } from "../db.ts";
import {
  createSession,
  currentSessionHash,
  destroySession,
  fakeSalt,
  findUserByEmail,
  getUserRow,
  hashSecret,
  pickColor,
  rateLimit,
  requireUser,
  sha256,
  toUser,
  userCount,
  verifySecret,
} from "../auth.ts";
import { HttpError, blob, str } from "../http.ts";

export const authApi = Router();

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function registrationOpen(): boolean {
  return userCount() === 0 || getSetting("registration_open", "false") === "true";
}

function limit(key: string, max = 10) {
  if (!rateLimit(key, max)) throw new HttpError(429, "Trop de tentatives, réessaie dans une minute");
}

authApi.get("/status", (_req, res) => {
  res.json({ needsSetup: userCount() === 0, registrationOpen: registrationOpen() });
});

/** KDF salt for an email; unknown emails get a stable fake one. */
authApi.post("/prelogin", (req, res) => {
  limit(`pre:${req.ip}`, 30);
  const email = str(req.body.email);
  const row = findUserByEmail(email);
  res.json({ salt: row ? row.kdf_salt : fakeSalt(email) });
});

type InviteRow = { token_hash: string; expires_at: number; used_by: string | null };

authApi.get("/invite/:token", (req, res) => {
  const inv = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(String(req.params.token))) as InviteRow | undefined;
  res.json({ valid: !!inv && !inv.used_by && inv.expires_at > Date.now() });
});

authApi.post("/register", (req, res) => {
  limit(`reg:${req.ip}`, 5);
  const b = req.body;
  let invite: InviteRow | undefined;
  if (b.invite) {
    invite = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(String(b.invite))) as InviteRow | undefined;
    if (!invite || invite.used_by || invite.expires_at < Date.now()) throw new HttpError(403, "Invitation invalide ou expirée");
  } else if (!registrationOpen()) {
    throw new HttpError(403, "Les inscriptions sont fermées : il faut une invitation");
  }
  const email = str(b.email);
  const name = str(b.name, 60);
  if (!EMAIL.test(email)) throw new HttpError(400, "Email invalide");
  if (!name) throw new HttpError(400, "Nom requis");
  if (!isClientId(b.id)) throw new HttpError(400, "Identifiant invalide");
  if (findUserByEmail(email) || getUserRow(b.id)) throw new HttpError(409, "Cet email est déjà utilisé");
  const first = userCount() === 0;
  db.prepare(
    `INSERT INTO users (id, email, name, auth_hash, kdf_salt, public_key, enc_private_key, recovery_enc_private_key, recovery_auth_hash, is_admin, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.id,
    email,
    name,
    hashSecret(blob(b.authKey, 100)),
    blob(b.salt, 64),
    blob(b.publicKey, 100),
    blob(b.encPrivateKey, 400),
    blob(b.recoveryEncPrivateKey, 400),
    hashSecret(blob(b.recoveryAuth, 100)),
    first ? 1 : 0,
    pickColor(userCount()),
    Date.now(),
  );
  if (invite) db.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").run(b.id, invite.token_hash);
  createSession(res, b.id);
  res.json({ user: toUser(getUserRow(b.id)!) });
});

authApi.post("/login", (req, res) => {
  const email = str(req.body.email);
  limit(`login:${req.ip}`, 20);
  limit(`login:${email.toLowerCase()}`, 8);
  const row = findUserByEmail(email);
  if (!row || !verifySecret(String(req.body.authKey ?? ""), row.auth_hash)) throw new HttpError(401, "Email ou mot de passe incorrect");
  createSession(res, row.id);
  res.json({ user: toUser(row), keys: { publicKey: row.public_key, encPrivateKey: row.enc_private_key } });
});

/** Step 1 of account recovery: prove the recovery key, receive the private key encrypted under it. */
authApi.post("/recover", (req, res) => {
  const email = str(req.body.email);
  limit(`recover:${req.ip}`, 5);
  const row = findUserByEmail(email);
  if (!row || !verifySecret(String(req.body.recoveryAuth ?? ""), row.recovery_auth_hash)) throw new HttpError(401, "Email ou clé de récupération incorrecte");
  res.json({ userId: row.id, publicKey: row.public_key, recoveryEncPrivateKey: row.recovery_enc_private_key });
});

/** Step 2: set a new password (re-encrypted private key), logging out every other session. */
authApi.post("/recover/finish", (req, res) => {
  const email = str(req.body.email);
  limit(`recover:${req.ip}`, 5);
  const row = findUserByEmail(email);
  if (!row || !verifySecret(String(req.body.recoveryAuth ?? ""), row.recovery_auth_hash)) throw new HttpError(401, "Email ou clé de récupération incorrecte");
  db.prepare("UPDATE users SET auth_hash = ?, kdf_salt = ?, enc_private_key = ? WHERE id = ?").run(
    hashSecret(blob(req.body.authKey, 100)),
    blob(req.body.salt, 64),
    blob(req.body.encPrivateKey, 400),
    row.id,
  );
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
  createSession(res, row.id);
  res.json({ user: toUser(row), keys: { publicKey: row.public_key, encPrivateKey: blob(req.body.encPrivateKey, 400) } });
});

authApi.post("/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authApi.use(requireUser);

authApi.get("/me", (req, res) => {
  const row = getUserRow(req.user!.id)!;
  res.json({ user: req.user, encVault: row.enc_vault });
});

/** Material needed to unlock the private key on a device that has a session but no key yet. */
authApi.get("/keys", (req, res) => {
  const row = getUserRow(req.user!.id)!;
  res.json({ salt: row.kdf_salt, publicKey: row.public_key, encPrivateKey: row.enc_private_key });
});

authApi.patch("/me", (req, res) => {
  const name = str(req.body.name, 60);
  if (name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.user!.id);
  res.json({ user: { ...req.user, name: name || req.user!.name } });
});

authApi.put("/vault", (req, res) => {
  db.prepare("UPDATE users SET enc_vault = ? WHERE id = ?").run(blob(req.body.encVault, 2_000_000), req.user!.id);
  res.json({ ok: true });
});

authApi.post("/password", (req, res) => {
  limit(`pw:${req.user!.id}`, 5);
  const row = getUserRow(req.user!.id)!;
  if (!verifySecret(String(req.body.authKey ?? ""), row.auth_hash)) throw new HttpError(400, "Mot de passe actuel incorrect");
  db.prepare("UPDATE users SET auth_hash = ?, kdf_salt = ?, enc_private_key = ? WHERE id = ?").run(
    hashSecret(blob(req.body.newAuthKey, 100)),
    blob(req.body.newSalt, 64),
    blob(req.body.newEncPrivateKey, 400),
    row.id,
  );
  // Every other device must log in again with the new password.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(row.id, currentSessionHash(req) ?? "");
  res.json({ ok: true });
});

/** Public key lookup for sharing. Exact email match only. */
authApi.get("/lookup", (req, res) => {
  limit(`lookup:${req.user!.id}`, 30);
  const row = findUserByEmail(str(req.query.email));
  if (!row) throw new HttpError(404, "Aucun compte avec cet email");
  res.json({ user: { id: row.id, name: row.name, email: row.email, publicKey: row.public_key } });
});

export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}
