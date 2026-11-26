import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { db } from "./db.ts";
import { sha256 } from "./auth.ts";
import { config } from "./config.ts";
import { broadcastToBoard } from "./hub.ts";

// The server only relays terminal traffic: keys, input and output are all
// encrypted between browsers and agents (see docs/SECURITY.md).

type Status = "starting" | "running" | "exited";

type Chunk = { gen: string; seq: number; d: string };

type Term = {
  id: string;
  boardId: string;
  machineId: string;
  createdBy: string | null;
  cols: number;
  rows: number;
  status: Status;
  exitCode: number | null;
  keyForBoard: string;
  keyForAgent: string;
  encLabel: string;
  scrollback: Chunk[];
  scrollbackLen: number;
};

type Agent = { ws: WebSocket; machineId: string; alive: boolean };

export type TerminalInfo = {
  id: string;
  boardId: string;
  machineId: string;
  machineOwnerId: string | null;
  status: Status | "offline";
  exitCode: number | null;
  cols: number;
  rows: number;
  createdBy: string | null;
  keyForBoard: string;
  encLabel: string;
};

const terms = new Map<string, Term>();
const agents = new Map<string, Agent>();

type TermRow = {
  id: string;
  board_id: string;
  machine_id: string;
  created_by: string | null;
  cols: number;
  rows: number;
  status: Status;
  exit_code: number | null;
  key_for_board: string;
  key_for_agent: string;
  enc_label: string;
};

for (const r of db.prepare("SELECT * FROM terminals").all() as TermRow[]) {
  terms.set(r.id, {
    id: r.id,
    boardId: r.board_id,
    machineId: r.machine_id,
    createdBy: r.created_by,
    cols: r.cols,
    rows: r.rows,
    status: r.status,
    exitCode: r.exit_code,
    keyForBoard: r.key_for_board,
    keyForAgent: r.key_for_agent,
    encLabel: r.enc_label,
    scrollback: [],
    scrollbackLen: 0,
  });
}

function machineOwner(id: string): string | null {
  const row = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(id) as { owner_id: string } | undefined;
  return row?.owner_id ?? null;
}

export function isMachineOnline(id: string): boolean {
  return agents.has(id);
}

function info(t: Term): TerminalInfo {
  return {
    id: t.id,
    boardId: t.boardId,
    machineId: t.machineId,
    machineOwnerId: machineOwner(t.machineId),
    status: t.status !== "exited" && !agents.has(t.machineId) ? "offline" : t.status,
    exitCode: t.exitCode,
    cols: t.cols,
    rows: t.rows,
    createdBy: t.createdBy,
    keyForBoard: t.keyForBoard,
    encLabel: t.encLabel,
  };
}

function persist(t: Term): void {
  db.prepare("UPDATE terminals SET cols = ?, rows = ?, status = ?, exit_code = ?, key_for_board = ?, key_for_agent = ?, enc_label = ? WHERE id = ?").run(
    t.cols,
    t.rows,
    t.status,
    t.exitCode,
    t.keyForBoard,
    t.keyForAgent,
    t.encLabel,
    t.id,
  );
}

function announce(t: Term): void {
  broadcastToBoard(t.boardId, { t: "term", terminal: info(t) });
}

/** Extra agent message handlers (web tunnels). */
type AgentHooks = {
  hello: ((machineId: string) => void)[];
  message: ((machineId: string, msg: any) => void)[];
  disconnect: ((machineId: string) => void)[];
};
export const agentHooks: AgentHooks = { hello: [], message: [], disconnect: [] };

export function sendAgent(machineId: string, msg: object): boolean {
  const a = agents.get(machineId);
  if (!a || a.ws.readyState !== WebSocket.OPEN) return false;
  a.ws.send(JSON.stringify(msg));
  return true;
}

function appendScrollback(t: Term, chunk: Chunk): void {
  t.scrollback.push(chunk);
  t.scrollbackLen += chunk.d.length;
  while (t.scrollbackLen > config.scrollbackBytes && t.scrollback.length > 1) {
    t.scrollbackLen -= t.scrollback.shift()!.d.length;
  }
}

function resetScrollback(t: Term): void {
  t.scrollback = [];
  t.scrollbackLen = 0;
}

const clampCols = (n: number) => Math.max(10, Math.min(500, Math.floor(n) || 80));
const clampRows = (n: number) => Math.max(3, Math.min(200, Math.floor(n) || 24));

function openOnAgent(t: Term): void {
  sendAgent(t.machineId, { t: "open", id: t.id, cols: t.cols, rows: t.rows, key: t.keyForAgent });
}

// ---- API used by board rooms and the item API ---------------------------------

export function listBoardTerminals(boardId: string): TerminalInfo[] {
  return [...terms.values()].filter((t) => t.boardId === boardId).map(info);
}

export function terminalExists(id: string): boolean {
  return terms.has(id) || !!db.prepare("SELECT 1 FROM terminals WHERE id = ?").get(id);
}

export function createTerminal(o: {
  id: string;
  boardId: string;
  machineId: string;
  userId: string;
  cols: number;
  rows: number;
  keyForBoard: string;
  keyForAgent: string;
  encLabel: string;
}): TerminalInfo {
  const t: Term = {
    id: o.id,
    boardId: o.boardId,
    machineId: o.machineId,
    createdBy: o.userId,
    cols: clampCols(o.cols),
    rows: clampRows(o.rows),
    status: "starting",
    exitCode: null,
    keyForBoard: o.keyForBoard,
    keyForAgent: o.keyForAgent,
    encLabel: o.encLabel,
    scrollback: [],
    scrollbackLen: 0,
  };
  db.prepare(
    `INSERT INTO terminals (id, board_id, machine_id, created_by, cols, rows, status, key_for_board, key_for_agent, enc_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(t.id, t.boardId, t.machineId, o.userId, t.cols, t.rows, t.status, t.keyForBoard, t.keyForAgent, t.encLabel, Date.now());
  terms.set(t.id, t);
  openOnAgent(t);
  announce(t);
  return info(t);
}

function boardTerm(boardId: string, id: string): Term | undefined {
  const t = terms.get(id);
  return t && t.boardId === boardId ? t : undefined;
}

export function terminalInput(boardId: string, id: string, frame: { s: string; k: number; ts: number; d: string }): void {
  const t = boardTerm(boardId, id);
  if (t && t.status === "running") sendAgent(t.machineId, { t: "input", id, ...frame });
}

/** The machine running a live terminal of this board (file transfers are relayed to it), if any. */
export function terminalMachine(boardId: string, id: string): string | undefined {
  const t = boardTerm(boardId, id);
  return t && t.status === "running" ? t.machineId : undefined;
}

/** The machine a terminal belongs to, whatever its board. */
export function terminalMachineOf(id: string): string | undefined {
  return terms.get(id)?.machineId;
}

export function terminalResize(boardId: string, id: string, cols: number, rows: number): void {
  const t = boardTerm(boardId, id);
  if (!t) return;
  cols = clampCols(cols);
  rows = clampRows(rows);
  if (cols === t.cols && rows === t.rows) return;
  t.cols = cols;
  t.rows = rows;
  persist(t);
  sendAgent(t.machineId, { t: "resize", id, cols, rows });
  announce(t);
}

export function terminalClose(boardId: string, id: string): void {
  const t = boardTerm(boardId, id);
  if (!t || t.status === "exited") return;
  sendAgent(t.machineId, { t: "close", id });
  t.status = "exited";
  persist(t);
  announce(t);
}

export function terminalRestart(boardId: string, id: string): void {
  const t = boardTerm(boardId, id);
  if (!t || t.status !== "exited") return;
  t.status = "starting";
  t.exitCode = null;
  resetScrollback(t);
  persist(t);
  openOnAgent(t);
  announce(t);
}

export function terminalReplay(boardId: string, id: string): Chunk[] | undefined {
  return boardTerm(boardId, id)?.scrollback;
}

/** Kills and forgets terminals (board deleted, key rotation that could not re-key them). */
export function dropTerminals(ids: Iterable<string>): void {
  for (const id of ids) {
    const t = terms.get(id);
    if (!t) continue;
    if (t.status !== "exited") sendAgent(t.machineId, { t: "close", id });
    terms.delete(id);
    db.prepare("DELETE FROM terminals WHERE id = ?").run(id);
  }
}

export function dropBoardTerminals(boardId: string): void {
  dropTerminals([...terms.values()].filter((t) => t.boardId === boardId).map((t) => t.id));
}

/** New keys after a rotation: the agent switches key, old scrollback becomes unreadable and is dropped. */
export function rekeyTerminal(id: string, keyForBoard: string, keyForAgent: string, encLabel: string): void {
  const t = terms.get(id);
  if (!t) return;
  t.keyForBoard = keyForBoard;
  t.keyForAgent = keyForAgent;
  t.encLabel = encLabel;
  resetScrollback(t);
  persist(t);
  if (t.status !== "exited") sendAgent(t.machineId, { t: "rekey", id, key: keyForAgent });
}

export function terminalsOfBoards(boardIds: Set<string>): TerminalInfo[] {
  return [...terms.values()].filter((t) => boardIds.has(t.boardId)).map(info);
}

export function activeTerminalCount(boardId: string): number {
  let n = 0;
  for (const t of terms.values()) if (t.boardId === boardId && t.status !== "exited") n++;
  return n;
}

/** Kills and forgets the terminals of a machine that match (access to the machine withdrawn). */
export function dropMachineTerminalsWhere(machineId: string, pred: (t: { boardId: string; createdBy: string | null }) => boolean): void {
  const ids: string[] = [];
  for (const t of terms.values()) if (t.machineId === machineId && pred(t)) ids.push(t.id);
  for (const id of ids) {
    const t = terms.get(id)!;
    dropTerminals([id]);
    broadcastToBoard(t.boardId, { t: "term.gone", id });
  }
}

/** Disconnects a deleted machine and forgets its terminals. */
export function dropMachine(machineId: string): void {
  agents.get(machineId)?.ws.close(4000, "machine supprimée");
  for (const t of terms.values()) {
    if (t.machineId !== machineId) continue;
    terms.delete(t.id);
    broadcastToBoard(t.boardId, { t: "term.gone", id: t.id });
  }
}

/** Disconnects the agents of all machines owned by a user (suspended account). */
export function disconnectUserMachines(userId: string): void {
  for (const { id } of db.prepare("SELECT id FROM machines WHERE owner_id = ?").all(userId) as { id: string }[]) {
    agents.get(id)?.ws.close(4403, "compte suspendu");
  }
}

export function disconnectMachine(machineId: string): void {
  agents.get(machineId)?.ws.close(4001, "jeton régénéré");
}

// ---- Agent connections -------------------------------------------------------

export function authenticateAgent(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://x");
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (url.searchParams.get("token") ?? "");
  if (!token) return undefined;
  const row = db
    .prepare("SELECT m.id FROM machines m JOIN users u ON u.id = m.owner_id WHERE m.token_hash = ? AND u.suspended = 0")
    .get(sha256(token)) as { id: string } | undefined;
  return row?.id;
}

export function handleAgent(ws: WebSocket, machineId: string): void {
  agents.get(machineId)?.ws.close(4001, "remplacé par une nouvelle connexion");
  const agent: Agent = { ws, machineId, alive: true };
  agents.set(machineId, agent);
  console.log(`[agent] ${machineId} connecté`);

  ws.on("pong", () => (agent.alive = true));
  // Without a listener, a protocol error (oversized or malformed frame) would throw and stop the process.
  ws.on("error", () => ws.terminate());

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    try {
      onAgentMessage(machineId, msg);
    } catch (e) {
      console.error("[agent]", e);
    }
  });

  ws.on("close", () => {
    if (agents.get(machineId) !== agent) return;
    agents.delete(machineId);
    db.prepare("UPDATE machines SET last_seen = ? WHERE id = ?").run(Date.now(), machineId);
    console.log(`[agent] ${machineId} déconnecté`);
    for (const fn of agentHooks.disconnect) fn(machineId);
    for (const t of terms.values()) if (t.machineId === machineId) announce(t);
  });
}

function onAgentMessage(machineId: string, msg: any): void {
  const t = typeof msg.id === "string" ? terms.get(msg.id) : undefined;
  switch (msg.t) {
    case "hello":
      onHello(machineId, msg);
      for (const fn of agentHooks.hello) fn(machineId);
      break;
    case "http.res":
    case "probe.res":
    case "ws.ack":
    case "ws.data":
    case "ws.close":
    case "file.res":
      for (const fn of agentHooks.message) fn(machineId, msg);
      break;
    case "opened":
      if (t && t.machineId === machineId && t.status !== "running") {
        t.status = "running";
        persist(t);
        announce(t);
      }
      break;
    case "output": {
      if (!t || t.machineId !== machineId || typeof msg.d !== "string" || typeof msg.gen !== "string" || typeof msg.seq !== "number") return;
      const chunk = { gen: msg.gen, seq: msg.seq, d: msg.d };
      appendScrollback(t, chunk);
      broadcastToBoard(t.boardId, { t: "term.data", id: t.id, ...chunk });
      break;
    }
    case "exit":
      if (!t || t.machineId !== machineId) return;
      t.status = "exited";
      t.exitCode = typeof msg.code === "number" ? msg.code : null;
      persist(t);
      announce(t);
      if (typeof msg.error === "string") broadcastToBoard(t.boardId, { t: "term.error", id: t.id, message: msg.error.slice(0, 200) });
      break;
  }
}


function onHello(machineId: string, msg: any): void {
  db.prepare("UPDATE machines SET hostname = ?, os = ?, arch = ?, last_seen = ? WHERE id = ?").run(
    String(msg.hostname ?? "").slice(0, 100),
    String(msg.os ?? "").slice(0, 20),
    String(msg.arch ?? "").slice(0, 20),
    Date.now(),
    machineId,
  );
  const alive = new Set<string>(Array.isArray(msg.sessions) ? msg.sessions : []);
  for (const id of alive) {
    const t = terms.get(id);
    if (!t || t.machineId !== machineId || t.status === "exited") sendAgent(machineId, { t: "close", id });
  }
  for (const t of terms.values()) {
    if (t.machineId !== machineId || t.status === "exited") continue;
    if (alive.has(t.id)) {
      t.status = "running";
      sendAgent(machineId, { t: "resize", id: t.id, cols: t.cols, rows: t.rows });
    } else if (t.status === "starting") {
      openOnAgent(t);
    } else {
      // The PTY died while we were apart (agent or host restarted).
      t.status = "exited";
    }
    persist(t);
    announce(t);
  }
}

setInterval(() => {
  for (const a of agents.values()) {
    if (!a.alive) {
      a.ws.terminate();
      continue;
    }
    a.alive = false;
    a.ws.ping();
    a.ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
  }
}, 20_000).unref();
