// Garbage collection of shared documents: when a code or notebook window is removed for good (its
// icon deleted, or the window closed, not merely hidden), the editor who did it asks the server to
// delete the document (`doc.del`). A notebook also ends its kernel session.
import { DOC_ID_RE } from "./nodeData.ts";
import { kernelTermOf } from "./notebookDoc.ts";
import { openSharedDoc, type DocHost } from "./sharedDoc.ts";

export type DocRef = { doc: string; notebook: boolean };

/** The document ids of a node's `codes` / `notebooks` list (board data: read defensively). */
export function docIds(list: unknown, notebook: boolean): DocRef[] {
  if (!Array.isArray(list)) return [];
  const out: DocRef[] = [];
  for (const r of list) {
    const doc = r && typeof r === "object" ? (r as { docId?: unknown }).docId : undefined;
    if (typeof doc === "string" && DOC_ID_RE.test(doc) && !out.some((o) => o.doc === doc)) out.push({ doc, notebook });
  }
  return out;
}

/** What discarding needs from the board session (BoardSession implements it). */
export type GcHost = DocHost & {
  docDelete(doc: string): boolean;
  closeTerminal(id: string): void;
  terminals: Map<string, { label: string }>;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deletes the documents on the server. A notebook's kernel session (named by its metadata) is closed
 * first, only if it really is a kernel session. The deletion waits a moment so that the window that
 * was showing the document has let go of it and sends nothing more.
 */
export async function discardDocs(host: GcHost, refs: DocRef[], delayMs = 1000): Promise<void> {
  if (!host.canEdit || !refs.length) return;
  for (const ref of refs) {
    try {
      if (ref.notebook) {
        const d = openSharedDoc(host, ref.doc);
        try {
          const synced = await Promise.race([d.synced.then(() => true), wait(4000).then(() => false)]);
          const term = synced ? kernelTermOf(d.ydoc) : null;
          if (term && host.terminals.get(term)?.label.startsWith("Noyau Jupyter ")) host.closeTerminal(term);
        } finally {
          d.destroy();
        }
      }
    } catch (e) {
      console.error("[excalibash]", e);
    }
  }
  await wait(delayMs);
  for (const ref of refs) host.docDelete(ref.doc);
}
