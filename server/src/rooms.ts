import { WebSocket } from "ws";
import { db, isClientId, newId } from "./db.ts";
import type { User } from "./auth.ts";
import { atLeast, getItem, getMachine, machineAccess, type Role } from "./access.ts";
import { rooms, type BoardRoom } from "./hub.ts";
import {
  createTerminal,
  listBoardTerminals,
  terminalClose,
  terminalExists,
  terminalInput,
  terminalReplay,
  terminalResize,
  terminalRestart,
} from "./terminals.ts";
import { closeTunnel, createTunnel, listBoardTunnels, tunnelExists } from "./tunnels.ts";

/** Encrypted element: only the merge metadata is readable by the server. */
type Entry = { id: string; v: number; n: number; c: string };

type Client = { id: string; user: User; role: Role; session?: string };

const SAVE_DELAY = 1500;
const MAX_CIPHERTEXT = 2 * 1024 * 1024;

/** Excalidraw's rule: higher version wins, ties go to the lower versionNonce. */
function isNewer(incoming: Entry, current: Entry | undefined): boolean {
  if (!current) return true;
  if (incoming.v !== current.v) return incoming.v > current.v;
  return incoming.n < current.n;
}

function isEntry(e: any): e is Entry {
  return (
    e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    e.id.length <= 64 &&
    Number.isInteger(e.v) &&
    Number.isInteger(e.n) &&
    typeof e.c === "string" &&
    e.c.length <= MAX_CIPHERTEXT
  );
}

const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

class Room implements BoardRoom {
  readonly boardId: string;
  private epoch: number;
  private elements = new Map<string, Entry>();
  private order: string[] = [];
  private files: Record<string, string>;
  private clients = new Map<WebSocket, Client>();
  private saveTimer: NodeJS.Timeout | undefined;
  private dirtyFiles = false;

  constructor(boardId: string) {
    this.boardId = boardId;
    this.epoch = getItem(boardId)!.key_epoch;
    const row = db.prepare("SELECT elements, files FROM boards WHERE id = ?").get(boardId) as { elements: string; files: string };
    for (const e of JSON.parse(row.elements) as Entry[]) {
      this.elements.set(e.id, e);
      this.order.push(e.id);
    }
    this.files = JSON.parse(row.files);
  }

  broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.clients.keys()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private peer(c: Client) {
    return { id: c.id, userId: c.user.id, name: c.user.name, color: c.user.color, role: c.role };
  }

  join(ws: WebSocket, user: User, role: Role, session?: string): void {
    const client: Client = { id: newId(6), user, role, session };
    this.clients.set(ws, client);
    ws.send(
      JSON.stringify({
        t: "init",
        you: this.peer(client),
        epoch: this.epoch,
        elements: this.order.map((id) => this.elements.get(id)),
        files: this.files,
        terminals: listBoardTerminals(this.boardId),
        webs: listBoardTunnels(this.boardId),
        peers: [...this.clients.values()].filter((c) => c !== client).map((c) => this.peer(c)),
      }),
    );
    this.broadcast(JSON.stringify({ t: "peer.join", peer: this.peer(client) }), ws);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(ws, client, msg);
      } catch (e) {
        console.error("[room]", e);
        ws.send(JSON.stringify({ t: "error", message: "Erreur serveur", reqId: msg.reqId }));
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.broadcast(JSON.stringify({ t: "peer.leave", id: client.id }));
      if (this.clients.size === 0) {
        this.flush();
        if (rooms.get(this.boardId) === this) rooms.delete(this.boardId);
      }
    });
  }

  private onMessage(ws: WebSocket, client: Client, msg: any): void {
    const deny = (message: string) => ws.send(JSON.stringify({ t: "error", reqId: msg.reqId, message }));
    const editor = atLeast(client.role, "editor");

    switch (msg.t) {
      case "scene": {
        if (!editor) return deny("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!Array.isArray(msg.elements)) return;
        const accepted: Entry[] = [];
        for (const e of msg.elements) {
          if (!isEntry(e)) continue;
          const entry: Entry = { id: e.id, v: e.v, n: e.n, c: e.c };
          if (!isNewer(entry, this.elements.get(e.id))) continue;
          if (!this.elements.has(e.id)) this.order.push(e.id);
          this.elements.set(e.id, entry);
          accepted.push(entry);
        }
        if (accepted.length) {
          this.broadcast(JSON.stringify({ t: "scene", elements: accepted }), ws);
          this.scheduleSave();
        }
        break;
      }
      case "files": {
        if (!editor) return deny("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!msg.files || typeof msg.files !== "object") return;
        const added: Record<string, string> = {};
        for (const [id, c] of Object.entries(msg.files)) {
          if (this.files[id] || id.length > 128 || !str(c, 32 * 1024 * 1024)) continue;
          this.files[id] = c;
          added[id] = c;
        }
        if (Object.keys(added).length) {
          this.dirtyFiles = true;
          this.broadcast(JSON.stringify({ t: "files", files: added }), ws);
          this.scheduleSave();
        }
        break;
      }
      case "pointer":
        if (!str(msg.c, 4096)) return;
        this.broadcast(JSON.stringify({ t: "pointer", id: client.id, userId: client.user.id, name: client.user.name, color: client.user.color, c: msg.c }), ws);
        break;
      case "term.create": {
        if (!editor) return deny("Lecture seule");
        const machine = getMachine(String(msg.machineId));
        if (!machine || !machineAccess(client.user.id, machine, this.boardId)) return deny("Cette machine ne t'est pas partagée");
        if (!isClientId(msg.id) || terminalExists(msg.id)) return deny("Identifiant de terminal invalide");
        if (!str(msg.keyForBoard) || !str(msg.keyForAgent) || !str(msg.encLabel)) return deny("Clés manquantes");
        const terminal = createTerminal({
          id: msg.id,
          boardId: this.boardId,
          machineId: machine.id,
          userId: client.user.id,
          cols: Number(msg.cols),
          rows: Number(msg.rows),
          keyForBoard: msg.keyForBoard,
          keyForAgent: msg.keyForAgent,
          encLabel: msg.encLabel,
        });
        ws.send(JSON.stringify({ t: "term.created", reqId: msg.reqId, terminal }));
        break;
      }
      case "web.create": {
        if (!editor) return deny("Lecture seule");
        const machine = getMachine(String(msg.machineId));
        if (!machine || !machineAccess(client.user.id, machine, this.boardId)) return deny("Cette machine ne t'est pas partagée");
        if (!isClientId(msg.id) || tunnelExists(msg.id)) return deny("Identifiant de tunnel invalide");
        if (!str(msg.keyForBoard) || !str(msg.keyForAgent) || !str(msg.encLabel)) return deny("Clés manquantes");
        const web = createTunnel({
          id: msg.id,
          boardId: this.boardId,
          machineId: machine.id,
          createdBy: client.user.id,
          keyForBoard: msg.keyForBoard,
          keyForAgent: msg.keyForAgent,
          encLabel: msg.encLabel,
        });
        ws.send(JSON.stringify({ t: "web.created", reqId: msg.reqId, web }));
        break;
      }
      case "web.close":
        if (editor) closeTunnel(this.boardId, String(msg.id));
        break;
      case "term.sub": {
        const chunks = terminalReplay(this.boardId, String(msg.id));
        if (chunks) ws.send(JSON.stringify({ t: "term.replay", id: msg.id, chunks }));
        break;
      }
      case "term.input":
        if (!editor) return;
        if (str(msg.s, 64) && Number.isSafeInteger(msg.k) && Number.isSafeInteger(msg.ts) && str(msg.d, 256 * 1024)) {
          terminalInput(this.boardId, String(msg.id), { s: msg.s, k: msg.k, ts: msg.ts, d: msg.d });
        }
        break;
      case "term.resize":
        if (editor) terminalResize(this.boardId, String(msg.id), Number(msg.cols), Number(msg.rows));
        break;
      case "term.close":
        if (editor) terminalClose(this.boardId, String(msg.id));
        break;
      case "term.restart":
        if (editor) terminalRestart(this.boardId, String(msg.id));
        break;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
  }

  flush(): void {
    if (!this.saveTimer && !this.dirtyFiles) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const elements = JSON.stringify(this.order.map((id) => this.elements.get(id)));
    if (this.dirtyFiles) {
      db.prepare("UPDATE boards SET elements = ?, files = ? WHERE id = ?").run(elements, JSON.stringify(this.files), this.boardId);
      this.dirtyFiles = false;
    } else {
      db.prepare("UPDATE boards SET elements = ? WHERE id = ?").run(elements, this.boardId);
    }
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(Date.now(), this.boardId);
  }

  kick(userId: string, code: number, reason: string): void {
    for (const [ws, c] of this.clients) if (c.user.id === userId) ws.close(code, reason);
  }

  /** Closes the sockets opened with one session (token hash). */
  kickSession(session: string, code: number, reason: string): void {
    for (const [ws, c] of this.clients) if (c.session === session) ws.close(code, reason);
  }

  /** Disconnects everyone; pending edits are dropped when `discard` (content was replaced). */
  evict(code: number, reason: string, discard = false): void {
    if (discard) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.dirtyFiles = false;
    }
    for (const ws of this.clients.keys()) ws.close(code, reason);
    if (rooms.get(this.boardId) === this) rooms.delete(this.boardId);
  }
}

export function joinBoard(ws: WebSocket, user: User, boardId: string, role: Role, session?: string): void {
  let room = rooms.get(boardId) as Room | undefined;
  if (!room) {
    room = new Room(boardId);
    rooms.set(boardId, room);
  }
  room.join(ws, user, role, session);
}

/** Persists a live room right away (so REST reads see unsaved edits). */
export function flushRoom(boardId: string): void {
  (rooms.get(boardId) as Room | undefined)?.flush();
}

export function evictRoom(boardId: string, code: number, reason: string, discard = false): void {
  (rooms.get(boardId) as Room | undefined)?.evict(code, reason, discard);
}

/** Closes every board socket of a user (e.g. suspended account). */
export function kickUser(userId: string, code: number, reason: string): void {
  for (const r of rooms.values()) (r as Room).kick(userId, code, reason);
}

/** Closes the board sockets opened with a revoked session. */
export function kickSession(session: string, code: number, reason: string): void {
  for (const r of rooms.values()) (r as Room).kickSession(session, code, reason);
}

export function flushAllRooms(): void {
  for (const r of rooms.values()) (r as Room).flush();
}
