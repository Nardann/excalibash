import { db } from "./db.ts";
import { agentHooks, isMachineOnline, sendAgent } from "./terminals.ts";
import { broadcastToBoard } from "./hub.ts";

// Web tunnels relay end-to-end encrypted HTTP between a viewer's browser (service worker on the
// proxy origin) and an agent. The server never sees requests or responses: it only forwards
// {rid, ts, d} frames to the machine and the encrypted answer back.

type Tunnel = {
  id: string;
  boardId: string;
  machineId: string;
  createdBy: string | null;
  keyForBoard: string;
  keyForAgent: string;
  encLabel: string;
};

export type TunnelInfo = Omit<Tunnel, "keyForAgent"> & { machineOwnerId: string | null; online: boolean };

const tunnels = new Map<string, Tunnel>();

type Row = { id: string; board_id: string; machine_id: string; created_by: string | null; key_for_board: string; key_for_agent: string; enc_label: string };
for (const r of db.prepare("SELECT * FROM tunnels").all() as Row[]) {
  tunnels.set(r.id, {
    id: r.id,
    boardId: r.board_id,
    machineId: r.machine_id,
    createdBy: r.created_by,
    keyForBoard: r.key_for_board,
    keyForAgent: r.key_for_agent,
    encLabel: r.enc_label,
  });
}

function info(t: Tunnel): TunnelInfo {
  const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(t.machineId) as { owner_id: string } | undefined;
  const { keyForAgent: _k, ...rest } = t;
  return { ...rest, machineOwnerId: owner?.owner_id ?? null, online: isMachineOnline(t.machineId) };
}

const openOnAgent = (t: Tunnel) => sendAgent(t.machineId, { t: "web.open", id: t.id, key: t.keyForAgent });

export function listBoardTunnels(boardId: string): TunnelInfo[] {
  return [...tunnels.values()].filter((t) => t.boardId === boardId).map(info);
}

export function tunnelsOfBoards(boardIds: Set<string>): TunnelInfo[] {
  return [...tunnels.values()].filter((t) => boardIds.has(t.boardId)).map(info);
}

export function tunnelExists(id: string): boolean {
  return tunnels.has(id);
}

export function createTunnel(t: Tunnel): TunnelInfo {
  db.prepare(
    "INSERT INTO tunnels (id, board_id, machine_id, created_by, key_for_board, key_for_agent, enc_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(t.id, t.boardId, t.machineId, t.createdBy, t.keyForBoard, t.keyForAgent, t.encLabel, Date.now());
  tunnels.set(t.id, t);
  openOnAgent(t);
  const i = info(t);
  broadcastToBoard(t.boardId, { t: "web", web: i });
  return i;
}

export function closeTunnel(boardId: string, id: string): void {
  const t = tunnels.get(id);
  if (!t || t.boardId !== boardId) return;
  dropTunnels([id]);
}

export function dropTunnels(ids: Iterable<string>): void {
  for (const id of ids) {
    const t = tunnels.get(id);
    if (!t) continue;
    sendAgent(t.machineId, { t: "web.close", id });
    tunnels.delete(id);
    db.prepare("DELETE FROM tunnels WHERE id = ?").run(id);
    broadcastToBoard(t.boardId, { t: "web.gone", id });
  }
}

export function dropBoardTunnels(boardId: string): void {
  dropTunnels([...tunnels.values()].filter((t) => t.boardId === boardId).map((t) => t.id));
}

export function dropMachineTunnels(machineId: string): void {
  dropTunnels([...tunnels.values()].filter((t) => t.machineId === machineId).map((t) => t.id));
}

/** New keys after a rotation; the agent switches over and old keys stop working. */
export function rekeyTunnel(id: string, keyForBoard: string, keyForAgent: string, encLabel: string): void {
  const t = tunnels.get(id);
  if (!t) return;
  Object.assign(t, { keyForBoard, keyForAgent, encLabel });
  db.prepare("UPDATE tunnels SET key_for_board = ?, key_for_agent = ?, enc_label = ? WHERE id = ?").run(keyForBoard, keyForAgent, encLabel, id);
  openOnAgent(t);
}

// ---- Relay --------------------------------------------------------------------

const RELAY_TIMEOUT = 65_000;
const pending = new Map<string, { machineId: string; resolve: (d: string | null) => void; timer: NodeJS.Timeout }>();

/** Forwards one encrypted request; resolves with the encrypted response, or null (offline / timeout). */
export function relay(id: string, rid: string, ts: number, d: string): Promise<string | null> {
  const t = tunnels.get(id);
  if (!t || !isMachineOnline(t.machineId)) return Promise.resolve(null);
  const key = `${id}/${rid}`;
  if (pending.has(key)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      resolve(null);
    }, RELAY_TIMEOUT);
    pending.set(key, { machineId: t.machineId, resolve, timer });
    if (!sendAgent(t.machineId, { t: "http", id, rid, ts, d })) {
      clearTimeout(timer);
      pending.delete(key);
      resolve(null);
    }
  });
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "http.res" || typeof msg.d !== "string") return;
  const key = `${msg.id}/${msg.rid}`;
  const p = pending.get(key);
  if (!p || p.machineId !== machineId) return;
  clearTimeout(p.timer);
  pending.delete(key);
  p.resolve(msg.d);
});

agentHooks.hello.push((machineId) => {
  for (const t of tunnels.values()) if (t.machineId === machineId) openOnAgent(t);
  for (const t of tunnels.values()) if (t.machineId === machineId) broadcastToBoard(t.boardId, { t: "web", web: info(t) });
});
