export type User = { id: string; email: string; name: string; isAdmin: boolean; color: string; publicKey: string };

export type Role = "owner" | "editor" | "viewer";

/** Item as stored by the server: everything sensitive is ciphertext. */
export type RawItem = {
  id: string;
  kind: "folder" | "board";
  parentId: string | null;
  ownerId: string;
  ownerName: string;
  encName: string;
  keyWrap: string | null;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  shares: number;
  terminals: number;
};

export type RawGrant = { itemId: string; role: Role; wrappedKey: string; grantedBy: string | null };

export type RawMachine = {
  id: string;
  encName: string;
  encPub: string;
  encAuth: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  lastSeen: number | null;
  online: boolean;
};

/** Element as the server sees it: merge metadata + ciphertext. */
export type Entry = { id: string; v: number; n: number; c: string };

export type TerminalInfo = {
  id: string;
  boardId: string;
  machineId: string;
  machineOwnerId: string | null;
  status: "starting" | "running" | "exited" | "offline";
  exitCode: number | null;
  cols: number;
  rows: number;
  createdBy: string | null;
  keyForBoard: string;
  encLabel: string;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
