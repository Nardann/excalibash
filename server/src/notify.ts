import type { Request } from "express";
import { db } from "./db.ts";
import { emailEnabled, sendMail } from "./mailer.ts";
import { publicUrl } from "./http.ts";

/**
 * Email notifications, chosen by each person in their account (only shares on by default).
 * Names of boards and folders are encrypted, so emails can only say *what kind* of item it was.
 */
export const NOTIFY_EVENTS = ["itemDeleted", "itemShared", "accessRevoked", "itemTransferred", "newLogin"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export type NotifyPrefs = Record<NotifyEvent, boolean>;
/** Only shares are announced by default; a choice the person saved always wins. */
const DEFAULTS: NotifyPrefs = { itemDeleted: false, itemShared: true, accessRevoked: false, itemTransferred: false, newLogin: false };

export function readPrefs(raw: string | null | undefined): NotifyPrefs {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw || "{}") ?? {};
  } catch {}
  return Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, typeof parsed[e] === "boolean" ? parsed[e] : DEFAULTS[e]])) as NotifyPrefs;
}

export function getPrefs(userId: string): NotifyPrefs {
  const row = db.prepare("SELECT notify FROM users WHERE id = ?").get(userId) as { notify: string } | undefined;
  return readPrefs(row?.notify);
}

export function setPrefs(userId: string, prefs: NotifyPrefs): void {
  db.prepare("UPDATE users SET notify = ? WHERE id = ?").run(JSON.stringify(prefs), userId);
}

/** Everyone who can reach any of these items: grants on the items themselves or on an ancestor. */
export function usersWithAccess(itemIds: string[]): string[] {
  if (!itemIds.length) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE anc(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM items WHERE id IN (${itemIds.map(() => "?").join(",")})
         UNION SELECT i.id, i.parent_id, anc.depth + 1 FROM items i JOIN anc ON i.id = anc.parent_id WHERE anc.depth < 128
       )
       SELECT DISTINCT g.user_id AS id FROM grants g JOIN anc ON anc.id = g.item_id`,
    )
    .all(...itemIds) as { id: string }[];
  return rows.map((r) => r.id);
}

export const kindLabel = (kind: "board" | "folder") => (kind === "board" ? "un tableau" : "un dossier");

/**
 * Emails each recipient who turned `event` on. Never blocks or fails the request:
 * mail errors are logged and recorded for the admin page.
 */
export function notify(req: Request, userIds: string[], event: NotifyEvent, subject: string, body: (self: boolean) => string): void {
  if (!emailEnabled() || !userIds.length) return;
  const ids = [...new Set(userIds)];
  const rows = db
    .prepare(`SELECT id, email, notify FROM users WHERE suspended = 0 AND email_verified = 1 AND id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; email: string; notify: string }[];
  const footer = `\n\n—\nTu reçois cet email parce que tu as activé cette notification. Pour la couper : ${publicUrl(req)}/account`;
  for (const r of rows) {
    if (!readPrefs(r.notify)[event]) continue;
    sendMail(r.email, subject, body(r.id === req.user?.id) + footer).catch((e) => console.error(`[mail] notification ${event} : ${(e as Error).message}`));
  }
}
