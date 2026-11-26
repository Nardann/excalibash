// Pure node data (no Excalidraw runtime import): shared by nodes.ts, the exports and their tests.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { TileIcon } from "./personalLibrary.ts";
import type { RemoteTarget } from "../api.ts";

type El = ExcalidrawElement;

/** Last place and size of a window, so it reopens where it was. */
export type Geometry = { x?: number; y?: number; w?: number; h?: number };
export type ShellRef = Geometry & { terminalId: string };
export type WebRef = Geometry & { webId: string };
/** A shared code document (see sharedDoc.ts): `docId` is the id of its Yjs document. */
export type CodeRef = Geometry & { docId: string };
/** A shared notebook document: same shape, its own list and window kind. */
export type NotebookRef = Geometry & { docId: string };
/** 128 random bits, base64url (same rule as the server's). */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Most code windows one node may own (the server caps documents per board at 64). */
export const MAX_CODES = 32;
/** Most notebook windows one node may own. */
export const MAX_NOTEBOOKS = 32;
/** A device reached over Telnet / SSH through an agent: new shells of its icon reopen this target. */
export type RemoteRef = { machineId: string; target: RemoteTarget };
/**
 * `machineId`: the agent machine of the icon, remembered so a new shell can open on it even once
 * all its shells are closed. A device (`remote`) keeps its machine in `remote` instead.
 */
export type NodeData = {
  node: true;
  title?: string | null;
  icon?: TileIcon | null;
  shells: ShellRef[];
  webs?: WebRef[];
  codes?: CodeRef[];
  notebooks?: NotebookRef[];
  remote?: RemoteRef;
  machineId?: string;
  /** Name of that machine, so the icon keeps its label once its last shell is closed. */
  machineName?: string;
};

export const cd = (el: El | null | undefined) => (el?.customData ?? {}) as Record<string, any>;

// Node data comes from the board, which any editor (or an older client) can write: read it through
// one normalizer, so a malformed value can't crash rendering for everyone (strings stay strings,
// lists stay lists of well-formed entries).
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const geometry = (r: Record<string, unknown>): Geometry => {
  const g: Geometry = {};
  for (const k of ["x", "y", "w", "h"] as const) if (num(r[k]) !== undefined) g[k] = num(r[k]);
  return g;
};
function refs<T extends string>(v: unknown, field: T): (Geometry & Record<T, string>)[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r) => r && typeof r === "object" && str(r[field])).map((r) => ({ ...geometry(r), [field]: r[field] }) as Geometry & Record<T, string>);
}
/** Code and notebook windows: strict document ids, no duplicates, at most `max`. */
function docRefs(v: unknown, max: number): CodeRef[] {
  const seen = new Set<string>();
  const out: CodeRef[] = [];
  for (const r of refs(v, "docId")) {
    if (!DOC_ID_RE.test(r.docId) || seen.has(r.docId)) continue;
    seen.add(r.docId);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}
const KINDS_OK = ["telnet", "ssh", "raw"];
const bool = (v: unknown) => v === true;
/** A jump host as stored on the board (any editor could have written it): plain fields only. */
function hopRef(h: any) {
  if (!h || typeof h !== "object" || !str(h.host) || !Number.isInteger(h.port)) return undefined;
  return {
    host: h.host as string,
    port: h.port as number,
    ...(str(h.user) !== undefined ? { user: h.user as string } : {}),
    ...(bool(h.legacyKex) ? { legacyKex: true } : {}),
    ...(bool(h.legacyHostKey) ? { legacyHostKey: true } : {}),
    ...(bool(h.legacyCiphers) ? { legacyCiphers: true } : {}),
    // Never "hostKeyCheck: off" from the board: the form does not show it, so an editor could
    // otherwise turn off the host key check of someone else's hop without them seeing it.
  };
}
function remoteRef(v: any): RemoteRef | undefined {
  const t = v?.target;
  if (!str(v?.machineId) || !t || !KINDS_OK.includes(t.kind) || !str(t.host) || !Number.isInteger(t.port)) return undefined;
  const via = Array.isArray(t.via) ? t.via.map(hopRef) : [];
  if (via.length > 8 || via.some((h: unknown) => !h)) return undefined;
  return {
    machineId: v.machineId,
    target: { kind: t.kind, host: t.host, port: t.port, ...(str(t.user) !== undefined ? { user: t.user } : {}), ...(via.length ? { via } : {}) },
  };
}
const normalized = new WeakMap<object, NodeData>();
export const nodeDataOf = (el: El | null | undefined): NodeData | undefined => {
  const raw = cd(el);
  if (!raw.node) return undefined;
  const hit = normalized.get(raw);
  if (hit) return hit;
  const icon = raw.icon && Array.isArray(raw.icon.elements) ? (raw.icon as TileIcon) : null;
  const data: NodeData = {
    node: true,
    title: str(raw.title) ?? null,
    icon,
    shells: refs(raw.shells, "terminalId"),
    webs: refs(raw.webs, "webId"),
    codes: docRefs(raw.codes, MAX_CODES),
    notebooks: docRefs(raw.notebooks, MAX_NOTEBOOKS),
    ...(remoteRef(raw.remote) ? { remote: remoteRef(raw.remote) } : {}),
    ...(str(raw.machineId) ? { machineId: raw.machineId } : {}),
    ...(str(raw.machineName) ? { machineName: raw.machineName } : {}),
  };
  normalized.set(raw, data);
  return data;
};

