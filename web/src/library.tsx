// The user's decrypted view of folders and boards, and every operation that has to
// (re)encrypt something: create, rename, move, share, revoke (key rotation), duplicate.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Entry, type RawGrant, type RawItem, type Role, type User } from "./api.ts";
import { useKeys, useUser } from "./auth.tsx";
import {
  AAD,
  boxText,
  fromB64,
  newSymKey,
  randomId,
  sealKey,
  unboxText,
  unsealKey,
  unwrapKey,
  wrapKey,
  seal,
  type KeyPair,
  type SymKey,
} from "./crypto.ts";
import { checkContact, listMachines, pinContact } from "./vault.ts";
import { decryptEntry, decryptFile, encryptEntry, encryptPreview, reencryptFile } from "./board/boardCrypto.ts";

export type Node = Omit<RawItem, "encName" | "keyWrap"> & {
  name: string;
  key: SymKey | null;
  role: Role;
  /** Reached through a grant on this very item. */
  direct: boolean;
  /** Its parent is not visible to us: a top-level entry (own root or shared with us). */
  root: boolean;
  grantedBy: string | null;
};

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export async function decryptTree(user: User, keys: KeyPair, items: RawItem[], grants: RawGrant[]): Promise<Map<string, Node>> {
  const raw = new Map(items.map((i) => [i.id, i]));
  const grantOf = new Map(grants.map((g) => [g.itemId, g]));
  const out = new Map<string, Node>();
  const pending = new Map<string, Promise<Node>>();

  const resolve = (id: string): Promise<Node> => {
    let p = pending.get(id);
    if (p) return p;
    p = (async () => {
      const it = raw.get(id)!;
      const grant = grantOf.get(id);
      const parent = it.parentId && raw.has(it.parentId) ? await resolve(it.parentId) : null;
      let key: SymKey | null = null;
      try {
        if (grant) key = await unsealKey(keys, grant.wrappedKey, AAD.grant(id, user.id));
        else if (parent?.key && it.keyWrap) key = await unwrapKey(parent.key, it.keyWrap, AAD.wrap(id, it.parentId!));
      } catch {
        key = null;
      }
      let name = "⚠ illisible";
      if (key) name = await unboxText(key, it.encName, AAD.name(id)).catch(() => "⚠ illisible");
      let role: Role = grant?.role ?? parent?.role ?? "viewer";
      if (grant && parent && RANK[parent.role] > RANK[grant.role]) role = parent.role;
      const { encName: _n, keyWrap: _k, ...rest } = it;
      const node: Node = { ...rest, name, key, role, direct: !!grant, root: !parent, grantedBy: grant?.grantedBy ?? null };
      out.set(id, node);
      return node;
    })();
    pending.set(id, p);
    return p;
  };

  await Promise.all(items.map((i) => resolve(i.id)));
  return out;
}

// ---- Context ---------------------------------------------------------------------------

type Library = {
  nodes: Map<string, Node>;
  loading: boolean;
  refresh: () => Promise<void>;
};

const LibraryContext = createContext<Library>({ nodes: new Map(), loading: true, refresh: async () => {} });

export function LibraryProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const keys = useKeys();
  const [nodes, setNodes] = useState<Map<string, Node>>(new Map());
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await api.get<{ items: RawItem[]; grants: RawGrant[] }>("/tree");
    setNodes(await decryptTree(user, keys, r.items, r.grants));
    setLoading(false);
  }, [user, keys]);

  useEffect(() => {
    refresh().catch((e) => {
      console.error(e);
      setLoading(false);
    });
  }, [refresh]);

  const value = useMemo(() => ({ nodes, loading, refresh }), [nodes, loading, refresh]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export const useLibrary = () => useContext(LibraryContext);

/** Children of a folder (or top-level own items for null), trash excluded. */
export function childrenOf(nodes: Map<string, Node>, parentId: string | null, userId: string): Node[] {
  return [...nodes.values()].filter((n) =>
    parentId === null ? n.root && n.ownerId === userId && n.role === "owner" && !n.deletedAt : n.parentId === parentId && !n.deletedAt,
  );
}

export function isInTrash(nodes: Map<string, Node>, n: Node): boolean {
  for (let cur: Node | undefined = n, d = 0; cur && d < 128; cur = cur.parentId ? nodes.get(cur.parentId) : undefined, d++) {
    if (cur.deletedAt) return true;
  }
  return false;
}

export function pathOf(nodes: Map<string, Node>, id: string): Node[] {
  const path: Node[] = [];
  for (let cur = nodes.get(id), d = 0; cur && d < 128; cur = cur.parentId ? nodes.get(cur.parentId) : undefined, d++) path.unshift(cur);
  return path;
}

export const sortNodes = (list: Node[], sort: string) =>
  [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (sort === "name") return a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });

// ---- Operations ------------------------------------------------------------------------

type Ctx = { user: User; keys: KeyPair; nodes: Map<string, Node> };

function keyOf(ctx: Ctx, id: string): SymKey {
  const k = ctx.nodes.get(id)?.key;
  if (!k) throw new Error("Clé indisponible pour cet élément");
  return k;
}

/** Placement of a new/moved item under `parentId`, or at the user's root. */
async function placement(ctx: Ctx, id: string, key: SymKey, parentId: string | null) {
  if (parentId) return { parentId, keyWrap: await wrapKey(keyOf(ctx, parentId), key, AAD.wrap(id, parentId)) };
  return { parentId: null, ownerKey: await sealKey(ctx.keys.pub, key, AAD.grant(id, ctx.user.id)) };
}

export type BoardContent = { elements: any[]; files: Record<string, any>; preview?: string | null };

export async function createItem(ctx: Ctx, kind: "folder" | "board", parentId: string | null, name: string, content?: BoardContent): Promise<string> {
  const id = randomId();
  const key = await newSymKey();
  const board = content
    ? {
        elements: await Promise.all(content.elements.filter((e) => !e.customData?.terminalId).map((e) => encryptEntry(key, id, e))),
        files: Object.fromEntries(
          await Promise.all(Object.entries(content.files ?? {}).map(async ([fid, f]) => [fid, await reencryptFile(null, key, id, fid, f)])),
        ),
        preview: content.preview ? await encryptPreview(key, id, content.preview) : undefined,
      }
    : undefined;
  await api.post("/items", { id, kind, encName: await boxText(key, name, AAD.name(id)), ...(await placement(ctx, id, key, parentId)), board });
  return id;
}

export async function renameItem(ctx: Ctx, id: string, name: string) {
  const key = keyOf(ctx, id);
  await api.patch(`/items/${id}`, { encName: await boxText(key, name, AAD.name(id)) });
}

export async function moveItem(ctx: Ctx, id: string, parentId: string | null) {
  await api.post(`/items/${id}/move`, await placement(ctx, id, keyOf(ctx, id), parentId));
}

export async function fetchBoardContent(key: SymKey, boardId: string): Promise<BoardContent> {
  const c = await api.get<{ elements: Entry[]; files: Record<string, string> }>(`/items/${boardId}/content`);
  const elements = await Promise.all(c.elements.map((e) => decryptEntry(key, boardId, e)));
  const files: Record<string, any> = {};
  for (const [fid, data] of Object.entries(c.files)) files[fid] = await decryptFile(key, boardId, fid, data);
  return { elements, files };
}

export async function duplicateBoard(ctx: Ctx, id: string): Promise<string> {
  const node = ctx.nodes.get(id)!;
  const content = await fetchBoardContent(keyOf(ctx, id), id);
  content.preview = await fetchPreview(keyOf(ctx, id), id).catch(() => null);
  const parent = node.parentId && ctx.nodes.get(node.parentId);
  const target = parent && RANK[parent.role] >= RANK.editor ? parent.id : null;
  return createItem(ctx, "board", target, `${node.name} (copie)`, content);
}

export async function fetchPreview(key: SymKey, boardId: string): Promise<string | null> {
  const r = await api.get<{ preview: string | null }>(`/items/${boardId}/preview`);
  return r.preview ? unboxText(key, r.preview, AAD.preview(boardId)) : null;
}

// ---- Sharing ---------------------------------------------------------------------------

export type Member = { userId: string; role: Role; name: string; email: string; publicKey: string; color: string };

export async function shareItem(ctx: Ctx, id: string, target: { id: string; publicKey: string }, role: Role) {
  const wrappedKey = await sealKey(fromB64(target.publicKey), keyOf(ctx, id), AAD.grant(id, target.id));
  await api.put(`/items/${id}/grants/${target.id}`, { role, wrappedKey });
  await pinContact(ctx.user, ctx.keys, target.id, target.publicKey);
}

export { checkContact };

type RotationSnapshot = {
  snapshotAt: number;
  items: { id: string; kind: string; parentId: string | null; encName: string; keyWrap: string | null; epoch: number }[];
  boards: { id: string; elements: Entry[]; files: Record<string, string>; preview: string | null }[];
  terminals: { id: string; boardId: string; machineId: string; machineOwnerId: string | null; keyForBoard: string; encLabel: string }[];
  grants: { itemId: string; userId: string; role: Role; publicKey: string }[];
};

/**
 * Revokes access and rotates every key below `rootId`: names, wraps, elements, files,
 * previews, grants and terminal keys are all re-encrypted under fresh keys.
 */
export async function revokeAccess(ctx: Ctx, rootId: string, userId: string, onProgress?: (msg: string) => void) {
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress?.("Récupération du contenu chiffré…");
    const snap = await api.get<RotationSnapshot>(`/items/${rootId}/rotation`);
    const root = snap.items.find((i) => i.id === rootId)!;

    // Old keys, re-derived from the snapshot itself (not from a possibly stale cache).
    const oldKeys = new Map<string, SymKey>([[rootId, keyOf(ctx, rootId)]]);
    const children = new Map<string, typeof snap.items>();
    for (const i of snap.items) if (i.parentId) children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
    const queue = [rootId];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const c of children.get(pid) ?? []) {
        if (!oldKeys.has(c.id)) oldKeys.set(c.id, await unwrapKey(oldKeys.get(pid)!, c.keyWrap!, AAD.wrap(c.id, pid)));
        queue.push(c.id);
      }
    }
    const newKeys = new Map<string, SymKey>();
    for (const id of oldKeys.keys()) newKeys.set(id, await newSymKey());

    onProgress?.("Re-chiffrement des noms et des clés…");
    const items = await Promise.all(
      snap.items.map(async (i) => {
        const name = await unboxText(oldKeys.get(i.id)!, i.encName, AAD.name(i.id));
        let keyWrap: string | null = null;
        if (i.id === rootId) {
          if (root.parentId) keyWrap = await wrapKey(keyOf(ctx, root.parentId), newKeys.get(i.id)!, AAD.wrap(i.id, root.parentId));
        } else {
          keyWrap = await wrapKey(newKeys.get(i.parentId!)!, newKeys.get(i.id)!, AAD.wrap(i.id, i.parentId!));
        }
        return { id: i.id, encName: await boxText(newKeys.get(i.id)!, name, AAD.name(i.id)), keyWrap };
      }),
    );

    onProgress?.(`Re-chiffrement de ${snap.boards.length} tableau(x)…`);
    const boards = await Promise.all(
      snap.boards.map(async (b) => {
        const ok = oldKeys.get(b.id)!;
        const nk = newKeys.get(b.id)!;
        const elements = await Promise.all(b.elements.map(async (e) => encryptEntry(nk, b.id, await decryptEntry(ok, b.id, e))));
        const files: Record<string, string> = {};
        for (const [fid, c] of Object.entries(b.files)) files[fid] = await reencryptFile(ok, nk, b.id, fid, c);
        const preview = b.preview ? await boxText(nk, await unboxText(ok, b.preview, AAD.preview(b.id)), AAD.preview(b.id)) : null;
        return { id: b.id, elements, files, preview };
      }),
    );

    onProgress?.("Nouvelles clés pour les membres restants…");
    const grants = [];
    for (const g of snap.grants) {
      if (g.itemId === rootId && g.userId === userId) continue;
      if (g.userId !== ctx.user.id && (await checkContact(ctx.user, ctx.keys, g.userId, g.publicKey)) === "changed") {
        throw new Error("La clé publique d'un membre a changé depuis le partage : rotation annulée par sécurité.");
      }
      const pub = g.userId === ctx.user.id ? ctx.keys.pub : fromB64(g.publicKey);
      grants.push({ itemId: g.itemId, userId: g.userId, wrappedKey: await sealKey(pub, newKeys.get(g.itemId)!, AAD.grant(g.itemId, g.userId)) });
    }

    // Terminals on our own machines get a fresh key; the others are closed by the server.
    const machines = new Map((await listMachines(ctx.keys)).map((m) => [m.id, m]));
    const terminals = [];
    for (const t of snap.terminals) {
      const m = machines.get(t.machineId);
      if (t.machineOwnerId !== ctx.user.id || !m) continue;
      const label = await unboxText(oldKeys.get(t.boardId)!, t.encLabel, AAD.termLabel(t.boardId, t.id)).catch(() => m.name);
      const kt = await newSymKey();
      const nk = newKeys.get(t.boardId)!;
      terminals.push({
        id: t.id,
        keyForBoard: await wrapKey(nk, kt, AAD.termKey(t.boardId, t.id)),
        keyForAgent: await seal(m.pub, kt.raw, AAD.termAgent(t.id)),
        encLabel: await boxText(nk, label, AAD.termLabel(t.boardId, t.id)),
      });
    }

    onProgress?.("Envoi…");
    try {
      await api.post(`/items/${rootId}/revoke`, { userId, snapshotAt: snap.snapshotAt, items, boards, grants, terminals });
      return;
    } catch (e: any) {
      if (e?.status !== 409 || attempt === 2) throw e;
    }
  }
}

export function useLibraryCtx(): Ctx {
  const user = useUser();
  const keys = useKeys();
  const { nodes } = useLibrary();
  return { user, keys, nodes };
}

