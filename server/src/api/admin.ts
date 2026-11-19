import { Router } from "express";
import { db, getSetting, setSetting } from "../db.ts";
import { requireAdmin, requireUser, sha256 } from "../auth.ts";
import { subtree, type ItemRow } from "../access.ts";
import { dropBoardTerminals, dropMachine } from "../terminals.ts";
import { evictRoom } from "../rooms.ts";
import { HttpError, pid, publicUrl, str } from "../http.ts";
import { newInviteToken } from "./auth.ts";

/**
 * Administration is deliberately narrow: admins manage *accounts*, never content.
 * There is no way to read, reset, impersonate or join another user's data.
 */
export const adminApi = Router();
adminApi.use(requireUser, requireAdmin);

adminApi.get("/", (_req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_admin AS isAdmin, u.color, u.created_at AS createdAt,
        (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id) AS items,
        (SELECT COUNT(*) FROM machines m WHERE m.owner_id = u.id) AS machines
       FROM users u ORDER BY u.created_at`,
    )
    .all();
  const invites = db
    .prepare(
      `SELECT i.token_hash AS id, i.note, i.expires_at AS expiresAt, i.created_at AS createdAt, u.name AS usedBy
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`,
    )
    .all();
  res.json({ users, invites, registrationOpen: getSetting("registration_open", "false") === "true" });
});

adminApi.patch("/settings", (req, res) => {
  if (typeof req.body.registrationOpen === "boolean") setSetting("registration_open", String(req.body.registrationOpen));
  res.json({ ok: true });
});

adminApi.post("/invites", (req, res) => {
  const token = newInviteToken();
  const days = Math.min(30, Math.max(1, Number(req.body.days) || 7));
  db.prepare("INSERT INTO invites (token_hash, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(token),
    req.user!.id,
    str(req.body.note, 100) || null,
    Date.now() + days * 86400_000,
    Date.now(),
  );
  res.json({ url: `${publicUrl(req)}/register?invite=${token}` });
});

adminApi.delete("/invites/:id", (req, res) => {
  db.prepare("DELETE FROM invites WHERE token_hash = ?").run(pid(req));
  res.json({ ok: true });
});

adminApi.patch("/users/:id", (req, res) => {
  if (pid(req) === req.user!.id) throw new HttpError(400, "Impossible de modifier son propre rôle");
  if (typeof req.body.isAdmin !== "boolean") throw new HttpError(400, "Rien à modifier");
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(req.body.isAdmin ? 1 : 0, pid(req));
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(pid(req));
  res.json({ ok: true });
});

adminApi.delete("/users/:id", (req, res) => {
  const id = pid(req);
  if (id === req.user!.id) throw new HttpError(400, "Impossible de supprimer son propre compte");
  const roots = db.prepare("SELECT * FROM items WHERE owner_id = ? AND parent_id IS NULL").all(id) as ItemRow[];
  for (const root of roots) {
    for (const i of subtree(root.id)) {
      if (i.kind !== "board") continue;
      evictRoom(i.id, 4404, "supprimé", true);
      dropBoardTerminals(i.id);
    }
  }
  for (const { id: m } of db.prepare("SELECT id FROM machines WHERE owner_id = ?").all(id) as { id: string }[]) dropMachine(m);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  res.json({ ok: true });
});
