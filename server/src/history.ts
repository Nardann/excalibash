// Board history. The server only ever copies the per-element ciphertext entries it already holds:
// nothing is decrypted here. Entries are stored once per board (keyed by the hash of their
// serialized form), and a version is just the ordered list of hashes of the scene.
import { createHash } from "node:crypto";
import { db, tx } from "./db.ts";
import { config } from "./config.ts";

type Entry = { id: string; v: number; n: number; c: string };

const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const serialize = (e: Entry) => JSON.stringify({ id: e.id, v: e.v, n: e.n, c: e.c });

/** Drops the entries of a board that no remaining version refers to. */
function collectGarbage(boardId: string): void {
  const referenced = new Set<string>();
  for (const v of db.prepare("SELECT hashes FROM board_versions WHERE board_id = ?").all(boardId) as { hashes: string }[]) {
    for (const h of JSON.parse(v.hashes) as string[]) referenced.add(h);
  }
  const del = db.prepare("DELETE FROM board_entries WHERE board_id = ? AND hash = ?");
  for (const r of db.prepare("SELECT hash FROM board_entries WHERE board_id = ?").all(boardId) as { hash: string }[]) {
    if (!referenced.has(r.hash)) del.run(boardId, r.hash);
  }
}

/** Applies the retention rules to one board (inside the caller's transaction). */
function prune(boardId: string, now: number): void {
  const { keep, days, maxBytes } = config.history;
  const rows = db.prepare("SELECT id, created_at FROM board_versions WHERE board_id = ? ORDER BY id DESC").all(boardId) as { id: number; created_at: number }[];
  const keepIds = new Set(rows.slice(0, keep).map((r) => r.id));
  const seenDays = new Set<number>();
  for (const r of rows) {
    if (r.created_at < now - days * DAY) continue;
    const day = Math.floor(r.created_at / DAY);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    keepIds.add(r.id);
  }
  const del = db.prepare("DELETE FROM board_versions WHERE id = ?");
  const left = rows.filter((r) => keepIds.has(r.id));
  for (const r of rows) if (!keepIds.has(r.id)) del.run(r.id);
  if (left.length < rows.length) collectGarbage(boardId);
  // The entries table only holds what remaining versions reference, so its size is the stored size.
  const total = () => (db.prepare("SELECT COALESCE(SUM(length(data)), 0) AS n FROM board_entries WHERE board_id = ?").get(boardId) as { n: number }).n;
  while (left.length > 1 && total() > maxBytes) {
    del.run(left.pop()!.id);
    collectGarbage(boardId);
  }
}

/** Removes all history of boards (key rotation: old-epoch ciphertexts must not survive). */
export function purgeHistory(boardIds: Iterable<string>): void {
  for (const id of boardIds) {
    db.prepare("DELETE FROM board_versions WHERE board_id = ?").run(id);
    db.prepare("DELETE FROM board_entries WHERE board_id = ?").run(id);
  }
}

/** Per-room bookkeeping: when to snapshot and what changed, hashing each entry only once. */
export class HistoryTracker {
  private dirty = false;
  private loaded = false;
  private lastAt = 0;
  private lastKey = "";
  /** Entry objects are replaced (never mutated) on update, so identity is a safe cache key. */
  private hashOf = new WeakMap<Entry, string>();

  private readonly boardId: string;

  constructor(boardId: string) {
    this.boardId = boardId;
  }

  markDirty(): void {
    if (config.history.keep > 0) this.dirty = true;
  }

  /** Pending edits were dropped (content replaced): nothing to capture. */
  discard(): void {
    this.dirty = false;
  }

  private hash(e: Entry): string {
    let h = this.hashOf.get(e);
    if (!h) this.hashOf.set(e, (h = sha256(serialize(e))));
    return h;
  }

  /** Records a version if the scene changed (and, unless `final`, if the minimum interval elapsed). */
  capture(epoch: number, entries: readonly Entry[], final = false): void {
    if (!this.dirty || config.history.keep <= 0) return;
    try {
      if (!this.loaded) {
        const last = db.prepare("SELECT created_at, hashes FROM board_versions WHERE board_id = ? ORDER BY id DESC LIMIT 1").get(this.boardId) as { created_at: number; hashes: string } | undefined;
        this.lastAt = last?.created_at ?? 0;
        this.lastKey = last?.hashes ?? "";
        this.loaded = true;
      }
      const now = Date.now();
      const { intervalMs } = config.history;
      if (!final && intervalMs > 0 && now - this.lastAt < intervalMs) return;
      this.dirty = false;
      const hashes = entries.map((e) => this.hash(e));
      const key = JSON.stringify(hashes);
      if (key === this.lastKey || (!this.lastKey && !entries.length)) return;
      tx(() => {
        const have = new Set((db.prepare("SELECT hash FROM board_entries WHERE board_id = ?").all(this.boardId) as { hash: string }[]).map((r) => r.hash));
        const insert = db.prepare("INSERT INTO board_entries (board_id, hash, data) VALUES (?, ?, ?)");
        let bytes = 0;
        entries.forEach((e, i) => {
          if (have.has(hashes[i])) return;
          const data = serialize(e);
          insert.run(this.boardId, hashes[i], data);
          have.add(hashes[i]);
          bytes += data.length;
        });
        db.prepare("INSERT INTO board_versions (board_id, created_at, epoch, hashes, bytes, count) VALUES (?, ?, ?, ?, ?, ?)").run(this.boardId, now, epoch, key, bytes, entries.length);
        prune(this.boardId, now);
      });
      this.lastAt = now;
      this.lastKey = key;
    } catch (e) {
      // History must never get in the way of saving the board.
      console.error("[history]", e);
    }
  }
}
