import { Router, type Request } from "express";
import { db, isClientId, tx } from "../db.ts";
import { requireUser, getUserRow } from "../auth.ts";
import { atLeast, getItem, isTrashed, roleOn, subtree, visibleItems, type ItemRow, type Role } from "../access.ts";
import { activeTerminalCount, dropBoardTerminals, dropTerminals, rekeyTerminal, terminalsOfBoards } from "../terminals.ts";
import { evictRoom, flushRoom } from "../rooms.ts";
import { dropBoardTunnels, dropTunnels, rekeyTunnel, tunnelsOfBoards } from "../tunnels.ts";
import { HttpError, blob, pid, publicUrl } from "../http.ts";
import { kindLabel, notify, usersWithAccess } from "../notify.ts";

export const itemsApi = Router();
itemsApi.use(requireUser);

type Entry = { id: string; v: number; n: number; c: string };

function entries(v: unknown): Entry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HttpError(400, "Éléments invalides");
  return v.map((e) => {
    if (!e || typeof e.id !== "string" || !Number.isInteger(e.v) || !Number.isInteger(e.n)) throw new HttpError(400, "Élément invalide");
    return { id: e.id.slice(0, 64), v: e.v, n: e.n, c: blob(e.c, 2 * 1024 * 1024) };
  });
}

function files(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Fichiers invalides");
  const out: Record<string, string> = {};
  for (const [k, c] of Object.entries(v)) out[k.slice(0, 128)] = blob(c, 32 * 1024 * 1024);
  return out;
}

function need(req: Request, min: Role): { item: ItemRow; role: Role } {
  const item = getItem(pid(req));
  const role = item ? roleOn(req.user!.id, item.id) : undefined;
  if (!item || !role) throw new HttpError(404, "Élément introuvable");
  if (!atLeast(role, min)) throw new HttpError(403, min === "owner" ? "Réservé au propriétaire" : "Accès en lecture seule");
  if (role !== "owner" && isTrashed(item.id)) throw new HttpError(404, "Élément introuvable");
  return { item, role };
}

const boardIdsOf = (items: ItemRow[]) => new Set(items.filter((i) => i.kind === "board").map((i) => i.id));

function evictBoards(items: ItemRow[], code: number, reason: string, discard = false) {
  for (const id of boardIdsOf(items)) evictRoom(id, code, reason, discard);
}

// ---- Personal library (opaque to the server) -------------------------------------

itemsApi.get("/library", (req, res) => {
  const row = db.prepare("SELECT enc_library FROM users WHERE id = ?").get(req.user!.id) as { enc_library: string | null };
  res.set("Cache-Control", "no-store").json({ encLibrary: row.enc_library });
});

itemsApi.put("/library", (req, res) => {
  db.prepare("UPDATE users SET enc_library = ? WHERE id = ?").run(blob(req.body.encLibrary, 30_000_000), req.user!.id);
  res.json({ ok: true });
});

// ---- Listing --------------------------------------------------------------------

itemsApi.get("/tree", (req, res) => {
  const uid = req.user!.id;
  const rows = visibleItems(uid);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Trash is private to the owner: others don't see trashed items or anything under them.
  const trashed = (r: ItemRow): boolean => {
    for (let cur: ItemRow | undefined = r, depth = 0; cur && depth < 128; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, depth++) {
      if (cur.deleted_at) return true;
    }
    return false;
  };
  const shares = new Map(
    (db.prepare("SELECT item_id, COUNT(*) AS n FROM grants WHERE role != 'owner' GROUP BY item_id").all() as { item_id: string; n: number }[]).map(
      (r) => [r.item_id, r.n],
    ),
  );
  const items = rows
    .filter((r) => r.owner_id === uid || !trashed(r))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      parentId: r.parent_id,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      encName: r.enc_name,
      keyWrap: r.key_wrap,
      epoch: r.key_epoch,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
      shares: shares.get(r.id) ?? 0,
      terminals: r.kind === "board" ? activeTerminalCount(r.id) : 0,
    }));
  const grants = db
    .prepare(
      `SELECT g.item_id AS itemId, g.role, g.wrapped_key AS wrappedKey, u.name AS grantedBy
       FROM grants g LEFT JOIN users u ON u.id = g.granted_by WHERE g.user_id = ?`,
    )
    .all(uid);
  res.json({ items, grants });
});

// ---- Create / rename / move -----------------------------------------------------

itemsApi.post("/items", (req, res) => {
  const uid = req.user!.id;
  const b = req.body;
  if (!isClientId(b.id) || getItem(b.id)) throw new HttpError(400, "Identifiant invalide");
  if (b.kind !== "folder" && b.kind !== "board") throw new HttpError(400, "Type invalide");
  let ownerId = uid;
  let keyWrap: string | null = null;
  if (b.parentId) {
    const parent = getItem(String(b.parentId));
    if (!parent || parent.kind !== "folder") throw new HttpError(400, "Dossier parent introuvable");
    if (!atLeast(roleOn(uid, parent.id), "editor") || isTrashed(parent.id)) throw new HttpError(403, "Pas le droit de créer ici");
    ownerId = parent.owner_id;
    keyWrap = blob(b.keyWrap, 200);
  }
  const ownerKey = b.parentId ? null : blob(b.ownerKey, 300);
  const els = entries(b.board?.elements);
  const fls = files(b.board?.files);
  const preview = b.board?.preview ? blob(b.board.preview, 8_000_000) : null;
  const now = Date.now();
  tx(() => {
    db.prepare(
      "INSERT INTO items (id, kind, parent_id, owner_id, created_by, enc_name, key_wrap, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(b.id, b.kind, b.parentId || null, ownerId, uid, blob(b.encName, 2000), keyWrap, now, now);
    if (ownerKey) {
      db.prepare("INSERT INTO grants (item_id, user_id, role, wrapped_key, granted_by, created_at) VALUES (?, ?, 'owner', ?, ?, ?)").run(b.id, uid, ownerKey, uid, now);
    }
    if (b.kind === "board") {
      db.prepare("INSERT INTO boards (id, elements, files, preview) VALUES (?, ?, ?, ?)").run(b.id, JSON.stringify(els), JSON.stringify(fls), preview);
    }
  });
  res.json({ id: b.id });
});

itemsApi.patch("/items/:id", (req, res) => {
  const { item } = need(req, "editor");
  db.prepare("UPDATE items SET enc_name = ?, updated_at = ? WHERE id = ?").run(blob(req.body.encName, 2000), Date.now(), item.id);
  res.json({ ok: true });
});

itemsApi.post("/items/:id/move", (req, res) => {
  const uid = req.user!.id;
  const { item } = need(req, "editor");
  const target = req.body.parentId ? getItem(String(req.body.parentId)) : null;
  if (target) {
    if (target.kind !== "folder" || !atLeast(roleOn(uid, target.id), "editor")) throw new HttpError(403, "Pas le droit de déplacer ici");
    if (target.owner_id !== item.owner_id) throw new HttpError(400, "On ne peut déplacer qu'entre dossiers du même propriétaire");
    if (subtree(item.id).some((i) => i.id === target.id)) throw new HttpError(400, "Impossible de déplacer un dossier dans lui-même");
    const keyWrap = blob(req.body.keyWrap, 200);
    tx(() => {
      db.prepare("UPDATE items SET parent_id = ?, key_wrap = ?, updated_at = ? WHERE id = ?").run(target.id, keyWrap, Date.now(), item.id);
      // The owner reaches it through the new parent now.
      db.prepare("DELETE FROM grants WHERE item_id = ? AND role = 'owner'").run(item.id);
    });
  } else {
    if (item.owner_id !== uid) throw new HttpError(403, "Seul le propriétaire peut placer un élément à la racine");
    const ownerKey = blob(req.body.ownerKey, 300);
    tx(() => {
      db.prepare("UPDATE items SET parent_id = NULL, key_wrap = NULL, updated_at = ? WHERE id = ?").run(Date.now(), item.id);
      db.prepare(
        `INSERT INTO grants (item_id, user_id, role, wrapped_key, granted_by, created_at) VALUES (?, ?, 'owner', ?, ?, ?)
         ON CONFLICT(item_id, user_id) DO UPDATE SET role = 'owner', wrapped_key = excluded.wrapped_key`,
      ).run(item.id, uid, ownerKey, uid, Date.now());
    });
  }
  // Roles may have changed for people who had access through the old parent.
  evictBoards(subtree(item.id), 4410, "droits modifiés");
  res.json({ ok: true });
});

// ---- Trash ----------------------------------------------------------------------

function purge(item: ItemRow) {
  const all = subtree(item.id);
  evictBoards(all, 4404, "supprimé", true);
  for (const id of boardIdsOf(all)) {
    dropBoardTerminals(id);
    dropBoardTunnels(id);
  }
  db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
}

itemsApi.delete("/items/:id", (req, res) => {
  const { item, role } = need(req, "editor");
  const permanent = req.query.permanent === "1";
  if (permanent) {
    if (role !== "owner" || item.owner_id !== req.user!.id) throw new HttpError(403, "Réservé au propriétaire");
    if (!item.deleted_at) throw new HttpError(400, "Mets-le d'abord à la corbeille");
  }
  // Collected before the purge, which drops the grants.
  const recipients = usersWithAccess(subtree(item.id).map((i) => i.id));
  if (permanent) purge(item);
  else {
    db.prepare("UPDATE items SET deleted_at = ? WHERE id = ?").run(Date.now(), item.id);
    evictBoards(subtree(item.id), 4404, "supprimé");
  }
  const what = kindLabel(item.kind);
  const done = permanent ? "supprimé définitivement" : "mis à la corbeille";
  notify(req, recipients, "itemDeleted", `Excalibash : ${what} a été ${permanent ? "supprimé" : "mis à la corbeille"}`, (self) => ({
    title: permanent ? `${what[0].toUpperCase()}${what.slice(1)} a été supprimé` : `${what[0].toUpperCase()}${what.slice(1)} est dans la corbeille`,
    lines: [self ? `Tu as ${done} ${what}.` : `**${req.user!.name}** a ${done} ${what} auquel tu as accès.`],
    button: permanent ? undefined : { label: "Ouvrir Excalibash", url: `${publicUrl(req)}/` },
    note: permanent
      ? "La suppression est définitive : le contenu chiffré a été effacé du serveur."
      : "Tant qu'il est dans la corbeille, son propriétaire peut encore le restaurer.",
  }));
  res.json({ ok: true });
});

itemsApi.post("/items/:id/restore", (req, res) => {
  const { item } = need(req, "owner");
  db.prepare("UPDATE items SET deleted_at = NULL WHERE id = ?").run(item.id);
  res.json({ ok: true });
});

itemsApi.delete("/trash", (req, res) => {
  const rows = db.prepare("SELECT * FROM items WHERE owner_id = ? AND deleted_at IS NOT NULL").all(req.user!.id) as ItemRow[];
  for (const r of rows) if (getItem(r.id)) purge(r);
  res.json({ deleted: rows.length });
});

// ---- Board content ----------------------------------------------------------------

itemsApi.get("/items/:id/content", (req, res) => {
  const { item } = need(req, "viewer");
  if (item.kind !== "board") throw new HttpError(400, "Ce n'est pas un tableau");
  flushRoom(item.id);
  const row = db.prepare("SELECT elements, files FROM boards WHERE id = ?").get(item.id) as { elements: string; files: string };
  res.json({ epoch: item.key_epoch, elements: JSON.parse(row.elements), files: JSON.parse(row.files) });
});

itemsApi.get("/items/:id/preview", (req, res) => {
  const { item } = need(req, "viewer");
  const row = db.prepare("SELECT preview FROM boards WHERE id = ?").get(item.id) as { preview: string | null } | undefined;
  res.set("Cache-Control", "no-store").json({ preview: row?.preview ?? null, epoch: item.key_epoch });
});

itemsApi.put("/items/:id/preview", (req, res) => {
  const { item } = need(req, "editor");
  if (req.body.epoch !== item.key_epoch) throw new HttpError(409, "Clés renouvelées, recharge la page");
  db.prepare("UPDATE boards SET preview = ? WHERE id = ?").run(blob(req.body.preview, 8_000_000), item.id);
  res.json({ ok: true });
});

// ---- Sharing ----------------------------------------------------------------------

itemsApi.get("/items/:id/grants", (req, res) => {
  const { item } = need(req, "viewer");
  const grants = db
    .prepare(
      `SELECT g.user_id AS userId, g.role, u.name, u.email, u.public_key AS publicKey, u.color
       FROM grants g JOIN users u ON u.id = g.user_id WHERE g.item_id = ? ORDER BY g.created_at`,
    )
    .all(item.id);
  res.json({ ownerId: item.owner_id, grants });
});

itemsApi.put("/items/:id/grants/:userId", (req, res) => {
  const uid = req.user!.id;
  const { item } = need(req, "viewer");
  if (item.owner_id !== uid) throw new HttpError(403, "Seul le propriétaire peut partager");
  const target = getUserRow(pid(req, "userId"));
  if (!target) throw new HttpError(404, "Utilisateur introuvable");
  if (target.id === uid) throw new HttpError(400, "Tu as déjà accès");
  const role = req.body.role;
  if (role !== "editor" && role !== "viewer") throw new HttpError(400, "Rôle invalide");
  const isNew = !db.prepare("SELECT 1 FROM grants WHERE item_id = ? AND user_id = ?").get(item.id, target.id);
  db.prepare(
    `INSERT INTO grants (item_id, user_id, role, wrapped_key, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id, user_id) DO UPDATE SET role = excluded.role, wrapped_key = excluded.wrapped_key`,
  ).run(item.id, target.id, role, blob(req.body.wrappedKey, 300), uid, Date.now());
  evictBoards(subtree(item.id), 4410, "droits modifiés");
  if (isNew) {
    notify(req, [target.id], "itemShared", `Excalibash : ${req.user!.name} t'a partagé ${kindLabel(item.kind)}`, () => ({
      title: `${req.user!.name} t'a partagé ${kindLabel(item.kind)}`,
      lines: [
        `**${req.user!.name}** t'a donné accès à ${kindLabel(item.kind)} en ${role === "editor" ? "**modification**" : "**lecture seule**"}.`,
        "Tu le trouves dans « Partagés avec moi ».",
      ],
      button: { label: "Voir mes partages", url: `${publicUrl(req)}/shared` },
      note: "Son nom est chiffré : seul ton navigateur peut le lire, c'est pourquoi il n'apparaît pas ici.",
    }));
  }
  res.json({ ok: true });
});

/** Gives an item at the root of the owner's tree to someone who already has direct access to it. */
itemsApi.post("/items/:id/transfer", (req, res) => {
  const uid = req.user!.id;
  const { item } = need(req, "owner");
  if (item.owner_id !== uid) throw new HttpError(403, "Réservé au propriétaire");
  if (item.parent_id) throw new HttpError(400, "Seul un élément à la racine peut être donné");
  if (item.deleted_at) throw new HttpError(400, "Sors-le d'abord de la corbeille");
  const to = String(req.body?.userId ?? "");
  if (to === uid) throw new HttpError(400, "Tu en es déjà propriétaire");
  const grant = db.prepare("SELECT role FROM grants WHERE item_id = ? AND user_id = ?").get(item.id, to) as { role: Role } | undefined;
  if (!grant || grant.role === "owner") throw new HttpError(400, "Cette personne doit déjà avoir accès à cet élément");
  const all = subtree(item.id);
  tx(() => {
    db.prepare(`UPDATE items SET owner_id = ? WHERE id IN (${all.map(() => "?").join(",")})`).run(to, ...all.map((i) => i.id));
    db.prepare("UPDATE grants SET role = 'owner' WHERE item_id = ? AND user_id = ?").run(item.id, to);
    db.prepare("UPDATE grants SET role = 'editor' WHERE item_id = ? AND user_id = ?").run(item.id, uid);
  });
  evictBoards(all, 4410, "droits modifiés");
  notify(req, [to], "itemTransferred", `Excalibash : ${req.user!.name} t'a donné ${kindLabel(item.kind)}`, () => ({
    title: `${req.user!.name} t'a donné ${kindLabel(item.kind)}`,
    lines: [`**${req.user!.name}** t'a transféré ${kindLabel(item.kind)} : tu en es maintenant **propriétaire**.`, "Il est rangé dans « Mes fichiers »."],
    button: { label: "Ouvrir mes fichiers", url: `${publicUrl(req)}/` },
  }));
  res.json({ ok: true });
});

/** Everything the owner's browser needs to rotate the keys of a subtree. */
itemsApi.get("/items/:id/rotation", (req, res) => {
  const uid = req.user!.id;
  const { item } = need(req, "owner");
  if (item.owner_id !== uid) throw new HttpError(403, "Réservé au propriétaire");
  const all = subtree(item.id);
  const boards = boardIdsOf(all);
  for (const id of boards) flushRoom(id);
  const ids = all.map((i) => i.id);
  const marks = ids.map(() => "?").join(",");
  res.json({
    snapshotAt: Date.now(),
    items: all.map((i) => ({ id: i.id, kind: i.kind, parentId: i.parent_id, encName: i.enc_name, keyWrap: i.key_wrap, epoch: i.key_epoch })),
    boards: [...boards].map((id) => {
      const row = db.prepare("SELECT elements, files, preview FROM boards WHERE id = ?").get(id) as { elements: string; files: string; preview: string | null };
      return { id, elements: JSON.parse(row.elements), files: JSON.parse(row.files), preview: row.preview };
    }),
    terminals: terminalsOfBoards(boards).map((t) => ({
      id: t.id,
      boardId: t.boardId,
      machineId: t.machineId,
      machineOwnerId: t.machineOwnerId,
      keyForBoard: t.keyForBoard,
      encLabel: t.encLabel,
    })),
    webs: tunnelsOfBoards(boards).map((t) => ({
      id: t.id,
      boardId: t.boardId,
      machineId: t.machineId,
      machineOwnerId: t.machineOwnerId,
      keyForBoard: t.keyForBoard,
      encLabel: t.encLabel,
    })),
    grants: db
      .prepare(
        `SELECT g.item_id AS itemId, g.user_id AS userId, g.role, u.email, u.public_key AS publicKey
         FROM grants g JOIN users u ON u.id = g.user_id WHERE g.item_id IN (${marks})`,
      )
      .all(...ids),
  });
});

/**
 * Removes someone's access and installs freshly generated keys for the whole subtree,
 * so the revoked person cannot read anything written from now on.
 */
itemsApi.post("/items/:id/revoke", (req, res) => {
  const uid = req.user!.id;
  const { item } = need(req, "owner");
  if (item.owner_id !== uid) throw new HttpError(403, "Réservé au propriétaire");
  const revoked = String(req.body.userId);
  if (revoked === uid) throw new HttpError(400, "Impossible de se retirer soi-même");
  if (!db.prepare("SELECT 1 FROM grants WHERE item_id = ? AND user_id = ?").get(item.id, revoked)) throw new HttpError(404, "Cette personne n'a pas de partage ici");

  // Persist in-flight edits first so they count as changes (instead of being discarded below).
  for (const b of boardIdsOf(subtree(item.id))) flushRoom(b);
  const all = subtree(item.id);
  const allIds = new Set(all.map((i) => i.id));
  const boards = boardIdsOf(all);
  const snapshotAt = Number(req.body.snapshotAt);
  if (all.some((i) => i.kind === "board" && i.updated_at > snapshotAt)) throw new HttpError(409, "Le contenu a changé pendant la rotation, on recommence");

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const boardsIn = Array.isArray(req.body.boards) ? req.body.boards : [];
  const grantsIn = Array.isArray(req.body.grants) ? req.body.grants : [];
  const termsIn = Array.isArray(req.body.terminals) ? req.body.terminals : [];
  const websIn = Array.isArray(req.body.webs) ? req.body.webs : [];

  if (items.length !== allIds.size || !items.every((i: any) => allIds.has(i.id))) throw new HttpError(400, "Rotation incomplète (éléments)");
  if (boardsIn.length !== boards.size || !boardsIn.every((b: any) => boards.has(b.id))) throw new HttpError(400, "Rotation incomplète (tableaux)");
  const remaining = (
    db.prepare(`SELECT item_id, user_id FROM grants WHERE item_id IN (${[...allIds].map(() => "?").join(",")})`).all(...allIds) as {
      item_id: string;
      user_id: string;
    }[]
  ).filter((g) => !(g.item_id === item.id && g.user_id === revoked));
  const key = (i: string, u: string) => `${i}\u0000${u}`;
  const grantMap = new Map<string, string>(grantsIn.map((g: any) => [key(String(g.itemId), String(g.userId)), blob(g.wrappedKey, 300)]));
  if (grantMap.size !== remaining.length || !remaining.every((g) => grantMap.has(key(g.item_id, g.user_id)))) throw new HttpError(400, "Rotation incomplète (partages)");

  const known = new Map(terminalsOfBoards(boards).map((t) => [t.id, t]));
  const rekeyed = termsIn.map((t: any) => {
    const cur = known.get(String(t.id));
    if (!cur || cur.machineOwnerId !== uid) throw new HttpError(400, "Terminal invalide dans la rotation");
    return { id: cur.id, keyForBoard: blob(t.keyForBoard), keyForAgent: blob(t.keyForAgent), encLabel: blob(t.encLabel) };
  });
  const knownWebs = new Map(tunnelsOfBoards(boards).map((t) => [t.id, t]));
  const rekeyedWebs = websIn.map((t: any) => {
    const cur = knownWebs.get(String(t.id));
    if (!cur || cur.machineOwnerId !== uid) throw new HttpError(400, "Tunnel web invalide dans la rotation");
    return { id: cur.id, keyForBoard: blob(t.keyForBoard), keyForAgent: blob(t.keyForAgent, 4000), encLabel: blob(t.encLabel) };
  });

  const now = Date.now();
  tx(() => {
    db.prepare("DELETE FROM grants WHERE item_id = ? AND user_id = ?").run(item.id, revoked);
    for (const i of items) {
      const isRoot = i.id === item.id;
      const keyWrap = isRoot && !item.parent_id ? null : blob(i.keyWrap, 200);
      db.prepare("UPDATE items SET enc_name = ?, key_wrap = ?, key_epoch = key_epoch + 1, updated_at = ? WHERE id = ?").run(blob(i.encName, 2000), keyWrap, now, i.id);
    }
    for (const b of boardsIn) {
      db.prepare("UPDATE boards SET elements = ?, files = ?, preview = ? WHERE id = ?").run(
        JSON.stringify(entries(b.elements)),
        JSON.stringify(files(b.files)),
        b.preview ? blob(b.preview, 8_000_000) : null,
        b.id,
      );
    }
    for (const g of remaining) {
      db.prepare("UPDATE grants SET wrapped_key = ? WHERE item_id = ? AND user_id = ?").run(grantMap.get(key(g.item_id, g.user_id))!, g.item_id, g.user_id);
    }
  });

  evictBoards(all, 4409, "clés renouvelées", true);
  const kept = new Set(rekeyed.map((t: { id: string }) => t.id));
  dropTerminals([...known.keys()].filter((id) => !kept.has(id)));
  for (const t of rekeyed) rekeyTerminal(t.id, t.keyForBoard, t.keyForAgent, t.encLabel);
  const keptWebs = new Set(rekeyedWebs.map((t: { id: string }) => t.id));
  dropTunnels([...knownWebs.keys()].filter((id) => !keptWebs.has(id)));
  for (const t of rekeyedWebs) rekeyTunnel(t.id, t.keyForBoard, t.keyForAgent, t.encLabel);
  notify(req, [revoked], "accessRevoked", `Excalibash : ${req.user!.name} t'a retiré un accès`, () => ({
    title: "Un accès t'a été retiré",
    lines: [`**${req.user!.name}** t'a retiré l'accès à ${kindLabel(item.kind)} partagé avec toi.`],
    note: "Ses clés ont été renouvelées : ce qui y sera écrit désormais ne te sera plus lisible.",
  }));
  res.json({ ok: true });
});
