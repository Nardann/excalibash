import { Router } from "express";
import { db } from "../db.ts";
import { destroySession, rateLimit, requireUser, verifySecret, getUserRow } from "../auth.ts";
import { HttpError, blob } from "../http.ts";
import { purgeUser } from "./admin.ts";

/** The signed-in user's own account: onboarding state, self-service deletion. */
export const accountApi = Router();
accountApi.use(requireUser);

accountApi.get("/", (req, res) => {
  const row = db.prepare("SELECT onboarded, discoverable FROM users WHERE id = ?").get(req.user!.id) as { onboarded: number; discoverable: number };
  res.json({ onboarded: !!row.onboarded, discoverable: !!row.discoverable });
});

accountApi.put("/discoverable", (req, res) => {
  if (typeof req.body?.discoverable !== "boolean") throw new HttpError(400, "Valeur invalide");
  db.prepare("UPDATE users SET discoverable = ? WHERE id = ?").run(req.body.discoverable ? 1 : 0, req.user!.id);
  res.json({ discoverable: req.body.discoverable });
});

accountApi.post("/onboarded", (req, res) => {
  db.prepare("UPDATE users SET onboarded = 1 WHERE id = ?").run(req.user!.id);
  res.json({ ok: true });
});

accountApi.delete("/", (req, res) => {
  const user = req.user!;
  if (!rateLimit(`account-delete:${user.id}`, 5, 15 * 60_000)) throw new HttpError(429, "Trop d'essais, réessaie plus tard");
  const authKey = blob(req.body?.authKey, 100);
  const row = getUserRow(user.id);
  if (!row || !verifySecret(authKey, row.auth_hash)) throw new HttpError(403, "Mot de passe incorrect");
  if (user.isAdmin) {
    const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ?").get(user.id) as { n: number };
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?").get(user.id) as { n: number };
    if (others.n > 0 && admins.n === 0) throw new HttpError(400, "Nomme d'abord un autre administrateur");
  }
  purgeUser(user.id);
  destroySession(req, res);
  res.json({ ok: true });
});
