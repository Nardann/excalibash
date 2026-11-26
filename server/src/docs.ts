// Shared documents (Yjs CRDT). Everything here is opaque: updates and snapshots are ciphertext
// boxed under the board key, the server only orders them (seq), counts them and measures their size.
import { db, tx } from "./db.ts";

/** 128-bit random id, base64url without padding. */
export const isDocId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);

export const MAX_FRAME = 512 * 1024; // ciphertext of one update (base64url chars)
export const MAX_AWARENESS = 32 * 1024;
export const MAX_SNAPSHOT = 4 * 1024 * 1024;
export const MAX_DOC_BYTES = 8 * 1024 * 1024; // snapshot + updates
export const MAX_DOCS_PER_BOARD = 64;
export const COMPACT_UPDATES = 200;
export const COMPACT_BYTES = 1024 * 1024;

export const isB64 = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

type DocRow = { board_id: string; doc_id: string; epoch: number; snap: string | null; snap_seq: number; last_seq: number; bytes: number };

const row = (boardId: string, docId: string) =>
  db.prepare("SELECT * FROM board_docs WHERE board_id = ? AND doc_id = ?").get(boardId, docId) as DocRow | undefined;

export type DocState = { snap?: { d: string; seq: number }; ups: { d: string; seq: number }[] };

export function docState(boardId: string, docId: string): DocState {
  const r = row(boardId, docId);
  if (!r) return { ups: [] };
  const ups = db.prepare("SELECT seq, d FROM board_doc_updates WHERE board_id = ? AND doc_id = ? ORDER BY seq").all(boardId, docId) as { seq: number; d: string }[];
  return { ...(r.snap ? { snap: { d: r.snap, seq: r.snap_seq } } : {}), ups };
}

export type AppendResult = { ok: true; seq: number; compact: boolean } | { ok: false; error: string };

/** Appends one ciphertext update, creating the document on first write. */
export function appendUpdate(boardId: string, docId: string, epoch: number, d: string): AppendResult {
  return tx(() => {
    let r = row(boardId, docId);
    if (!r) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM board_docs WHERE board_id = ?").get(boardId) as { n: number }).n;
      if (n >= MAX_DOCS_PER_BOARD) return { ok: false, error: "trop de documents" } as const;
      db.prepare("INSERT INTO board_docs (board_id, doc_id, epoch, updated_at) VALUES (?, ?, ?, ?)").run(boardId, docId, epoch, Date.now());
      r = row(boardId, docId)!;
    }
    if (r.bytes + d.length > MAX_DOC_BYTES) return { ok: false, error: "document trop gros" } as const;
    const seq = r.last_seq + 1;
    db.prepare("INSERT INTO board_doc_updates (board_id, doc_id, seq, d) VALUES (?, ?, ?, ?)").run(boardId, docId, seq, d);
    db.prepare("UPDATE board_docs SET last_seq = ?, bytes = bytes + ?, updated_at = ? WHERE board_id = ? AND doc_id = ?").run(seq, d.length, Date.now(), boardId, docId);
    const count = seq - r.snap_seq;
    const upsBytes = r.bytes + d.length - (r.snap?.length ?? 0);
    return { ok: true, seq, compact: count > COMPACT_UPDATES || upsBytes > COMPACT_BYTES } as const;
  });
}

/** Replaces the snapshot and every update up to `upto` by the client's compacted snapshot. */
export function applySnapshot(boardId: string, docId: string, d: string, upto: number): { ok: true } | { ok: false; error: string } {
  return tx(() => {
    const r = row(boardId, docId);
    if (!r) return { ok: false, error: "document inconnu" } as const;
    if (!Number.isSafeInteger(upto) || upto <= r.snap_seq || upto > r.last_seq) return { ok: false, error: "instantané périmé" } as const;
    const rest = (db.prepare("SELECT COALESCE(SUM(LENGTH(d)), 0) AS n FROM board_doc_updates WHERE board_id = ? AND doc_id = ? AND seq > ?").get(boardId, docId, upto) as { n: number }).n;
    if (d.length + rest > MAX_DOC_BYTES) return { ok: false, error: "document trop gros" } as const;
    db.prepare("DELETE FROM board_doc_updates WHERE board_id = ? AND doc_id = ? AND seq <= ?").run(boardId, docId, upto);
    db.prepare("UPDATE board_docs SET snap = ?, snap_seq = ?, bytes = ?, updated_at = ? WHERE board_id = ? AND doc_id = ?").run(d, upto, d.length + rest, Date.now(), boardId, docId);
    return { ok: true } as const;
  });
}

/** Everything a client needs to re-encrypt the documents of a board (key rotation). */
export function listDocs(boardId: string) {
  const docs = db.prepare("SELECT doc_id, epoch, snap, snap_seq, last_seq FROM board_docs WHERE board_id = ? ORDER BY doc_id").all(boardId) as Pick<
    DocRow,
    "doc_id" | "epoch" | "snap" | "snap_seq" | "last_seq"
  >[];
  return docs.map((r) => ({
    doc: r.doc_id,
    epoch: r.epoch,
    snap: r.snap,
    snapSeq: r.snap_seq,
    seq: r.last_seq,
    ups: db.prepare("SELECT seq, d FROM board_doc_updates WHERE board_id = ? AND doc_id = ? ORDER BY seq").all(boardId, r.doc_id) as { seq: number; d: string }[],
  }));
}

export type RotatedDoc = { doc: string; upto: number; d: string };

/**
 * Key rotation, inside the caller's transaction: each document becomes one fresh snapshot under the
 * new key. False when the set of documents (or any document's last seq) changed since the client
 * read them: the client must start over rather than lose someone's edits.
 */
export function replaceDocs(boardId: string, incoming: RotatedDoc[]): boolean {
  const cur = db.prepare("SELECT doc_id, last_seq FROM board_docs WHERE board_id = ?").all(boardId) as { doc_id: string; last_seq: number }[];
  if (cur.length !== incoming.length) return false;
  const byId = new Map(incoming.map((i) => [i.doc, i]));
  if (byId.size !== cur.length) return false;
  for (const c of cur) if (byId.get(c.doc_id)?.upto !== c.last_seq) return false;
  for (const c of cur) {
    const i = byId.get(c.doc_id)!;
    db.prepare("DELETE FROM board_doc_updates WHERE board_id = ? AND doc_id = ?").run(boardId, c.doc_id);
    db.prepare(
      "UPDATE board_docs SET snap = ?, snap_seq = last_seq, bytes = ?, epoch = (SELECT key_epoch FROM items WHERE id = ?), updated_at = ? WHERE board_id = ? AND doc_id = ?",
    ).run(i.d, i.d.length, boardId, Date.now(), boardId, c.doc_id);
  }
  return true;
}
