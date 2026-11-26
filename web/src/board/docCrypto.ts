// Shared documents at rest: what the server stores is ciphertext of Yjs updates and snapshots,
// boxed under the board key. This module re-encrypts a document for a key rotation.
import * as Y from "yjs";
import { AAD, box, fromB64, toB64, unbox, type SymKey } from "../crypto.ts";

/** A document as GET /items/:id/docs returns it. */
export type StoredDoc = { doc: string; epoch: number; snap: string | null; snapSeq: number; seq: number; ups: { seq: number; d: string }[] };
/** A document as the rotation sends it back: one fresh snapshot, valid up to `upto` (the last seq read). */
export type RotatedDoc = { doc: string; upto: number; d: string };

/**
 * Decrypts the snapshot and every update with the old key, merges them into one Yjs state and
 * boxes it as a snapshot under the new key and epoch. Anything that fails to authenticate aborts
 * the rotation: silently dropping part of someone's document would be worse.
 */
export async function reencryptDoc(boardId: string, d: StoredDoc, oldKey: SymKey, newKey: SymKey, newEpoch: number): Promise<RotatedDoc> {
  const aad = AAD.doc(boardId, d.doc, d.epoch);
  const ydoc = new Y.Doc();
  try {
    if (d.snap) Y.applyUpdate(ydoc, await unbox(oldKey, d.snap, aad));
    for (const u of d.ups) Y.applyUpdate(ydoc, await unbox(oldKey, u.d, aad));
    return { doc: d.doc, upto: d.seq, d: await box(newKey, Y.encodeStateAsUpdate(ydoc), AAD.doc(boardId, d.doc, newEpoch)) };
  } finally {
    ydoc.destroy();
  }
}

/** Base64url helpers re-exported for callers that handle raw updates (tests, tools). */
export { fromB64, toB64 };
