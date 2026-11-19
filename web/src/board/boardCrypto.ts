import type { Entry } from "../api.ts";
import { AAD, box, boxJson, boxText, unbox, unboxJson, utf8, type SymKey } from "../crypto.ts";

/** Element → {id, version, versionNonce in clear (for merging), everything else encrypted}. */
export async function encryptEntry(key: SymKey, boardId: string, el: any): Promise<Entry> {
  return { id: el.id, v: el.version, n: el.versionNonce, c: await boxJson(key, el, AAD.element(boardId, el.id, el.version, el.versionNonce)) };
}

export async function decryptEntry(key: SymKey, boardId: string, e: Entry): Promise<any> {
  const el = await unboxJson(key, e.c, AAD.element(boardId, e.id, e.v, e.n));
  // The clear metadata is what the server merges on: it must match the sealed element.
  if (el.id !== e.id || el.version !== e.v || el.versionNonce !== e.n) throw new Error("élément incohérent");
  return el;
}

export const encryptFile = (key: SymKey, boardId: string, fileId: string, file: unknown) => box(key, utf8(JSON.stringify(file)), AAD.file(boardId, fileId));

export async function decryptFile(key: SymKey, boardId: string, fileId: string, data: string): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await unbox(key, data, AAD.file(boardId, fileId))));
}

/** Encrypts a plain file object, or re-encrypts a ciphertext from `oldKey`. */
export async function reencryptFile(oldKey: SymKey | null, key: SymKey, boardId: string, fileId: string, data: unknown): Promise<string> {
  const file = oldKey ? await decryptFile(oldKey, boardId, fileId, data as string) : data;
  return encryptFile(key, boardId, fileId, file);
}

export const encryptPointer = (key: SymKey, boardId: string, p: unknown) => boxJson(key, p, AAD.pointer(boardId));
export const decryptPointer = (key: SymKey, boardId: string, c: string) => unboxJson(key, c, AAD.pointer(boardId));
export const encryptPreview = (key: SymKey, boardId: string, svg: string) => boxText(key, svg, AAD.preview(boardId));
