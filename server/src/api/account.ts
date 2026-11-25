import { Router } from "express";
import { db } from "../db.ts";
import { destroySession, rateLimit, requireUser, verifySecret, getUserRow } from "../auth.ts";
import { HttpError, blob } from "../http.ts";
import { purgeUser } from "./admin.ts";
import { emailEnabled } from "../mailer.ts";
import { NOTIFY_EVENTS, getPrefs, setPrefs, type NotifyPrefs } from "../notify.ts";

/** The signed-in user's own account: onboarding state, self-service deletion. */
export const accountApi = Router();
accountApi.use(requireUser);

accountApi.get("/", (req, res) => {
  const row = db.prepare("SELECT onboarded, findable_name, findable_email FROM users WHERE id = ?").get(req.user!.id) as {
    onboarded: number;
    findable_name: number;
    findable_email: number;
  };
  res.json({
    onboarded: !!row.onboarded,
    findableName: !!row.findable_name,
    findableEmail: !!row.findable_email,
    notifications: getPrefs(req.user!.id),
    emailEnabled: emailEnabled(),
  });
});

accountApi.put("/notifications", (req, res) => {
  const body = req.body ?? {};
  if (!NOTIFY_EVENTS.every((e) => typeof body[e] === "boolean")) throw new HttpError(400, "Valeur invalide");
  const prefs = Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, body[e]])) as NotifyPrefs;
  setPrefs(req.user!.id, prefs);
  res.json(prefs);
});

accountApi.put("/visibility", (req, res) => {
  const { findableName, findableEmail } = req.body ?? {};
  if (typeof findableName !== "boolean" || typeof findableEmail !== "boolean") throw new HttpError(400, "Valeur invalide");
  db.prepare("UPDATE users SET findable_name = ?, findable_email = ? WHERE id = ?").run(findableName ? 1 : 0, findableEmail ? 1 : 0, req.user!.id);
  res.json({ findableName, findableEmail });
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
