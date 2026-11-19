import { db } from "./db.ts";

export type Role = "owner" | "editor" | "viewer";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export const atLeast = (role: Role | undefined, min: Role): boolean => !!role && RANK[role] >= RANK[min];

export type ItemRow = {
  id: string;
  kind: "folder" | "board";
  parent_id: string | null;
  owner_id: string;
  created_by: string | null;
  enc_name: string;
  key_wrap: string | null;
  key_epoch: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

export type MachineRow = {
  id: string;
  owner_id: string;
  enc_name: string;
  enc_pub: string;
  enc_auth: string | null;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  last_seen: number | null;
  created_at: number;
};

export function getItem(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
}

const ANCESTORS = `
  WITH RECURSIVE anc(id, parent_id, deleted_at, depth) AS (
    SELECT id, parent_id, deleted_at, 0 FROM items WHERE id = ?
    UNION ALL
    SELECT i.id, i.parent_id, i.deleted_at, anc.depth + 1 FROM items i JOIN anc ON i.id = anc.parent_id WHERE anc.depth < 128
  )`;

/** Effective role of a user on an item: the strongest grant on the item or any ancestor. */
export function roleOn(userId: string, itemId: string): Role | undefined {
  const rows = db
    .prepare(`${ANCESTORS} SELECT g.role FROM anc JOIN grants g ON g.item_id = anc.id AND g.user_id = ?`)
    .all(itemId, userId) as { role: Role }[];
  let best: Role | undefined;
  for (const r of rows) if (!best || RANK[r.role] > RANK[best]) best = r.role;
  return best;
}

/** True when the item or one of its ancestors is in the trash. */
export function isTrashed(itemId: string): boolean {
  const row = db.prepare(`${ANCESTORS} SELECT 1 AS x FROM anc WHERE deleted_at IS NOT NULL LIMIT 1`).get(itemId);
  return !!row;
}

export function ancestorIds(itemId: string): string[] {
  return (db.prepare(`${ANCESTORS} SELECT id FROM anc`).all(itemId) as { id: string }[]).map((r) => r.id);
}

/** The item and all of its descendants. */
export function subtree(itemId: string): ItemRow[] {
  return db
    .prepare(
      `WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id)
       SELECT items.* FROM items JOIN sub ON sub.id = items.id`,
    )
    .all(itemId) as ItemRow[];
}

/** Every item a user can reach through their grants. */
export function visibleItems(userId: string): (ItemRow & { owner_name: string })[] {
  return db
    .prepare(
      `WITH RECURSIVE acc(id) AS (
         SELECT item_id FROM grants WHERE user_id = ?
         UNION SELECT i.id FROM items i JOIN acc ON i.parent_id = acc.id
       )
       SELECT i.*, u.name AS owner_name FROM items i JOIN acc ON acc.id = i.id JOIN users u ON u.id = i.owner_id`,
    )
    .all(userId) as (ItemRow & { owner_name: string })[];
}

export function getMachine(id: string): MachineRow | undefined {
  return db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as MachineRow | undefined;
}
