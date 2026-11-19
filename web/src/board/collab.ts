import { CaptureUpdateAction, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, Collaborator, SocketId, BinaryFiles, AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { Entry, Role, TerminalInfo, WebInfo, WebTarget } from "../api.ts";
import { AAD, box, boxJson, boxText, newSymKey, randomId, toB64, unbox, unboxJson, unboxText, unwrapKey, utf8, wrapKey, type SymKey } from "../crypto.ts";
import { decryptEntry, decryptFile, decryptPointer, encryptEntry, encryptFile, encryptPointer } from "./boardCrypto.ts";

export type Peer = { id: string; userId: string; name: string; color: string; role: Role };
export type ConnState = "connecting" | "online" | "reconnecting" | "closed";

type TermListener = {
  onReplay: (data: Uint8Array) => void;
  onData: (data: Uint8Array) => void;
};

type Chunk = { gen: string; seq: number; d: string };

type Events = {
  init: (msg: { you: Peer }) => void;
  peers: (peers: Peer[]) => void;
  state: (state: ConnState) => void;
  /** 4404 deleted, 4403 access lost, 4409 keys rotated, 4410 rights changed. */
  closed: (code: number) => void;
  terminals: () => void;
  localChange: () => void;
  error: (message: string) => void;
};

const SEND_INTERVAL = 50;
const POINTER_INTERVAL = 50;

export const terminalIdOf = (el: { customData?: Record<string, any> } | null | undefined): string | undefined =>
  el?.customData?.terminalId;

/**
 * One live, end-to-end encrypted connection to a board. The server only ever sees
 * element ids/versions and ciphertext.
 */
export class BoardSession {
  readonly boardId: string;
  readonly key: SymKey;
  readonly role: Role;
  private epoch: number;
  private ws: WebSocket | null = null;
  private api: ExcalidrawImperativeAPI | null = null;
  private pendingInit: any = null;
  private retries = 0;
  private disposed = false;
  private reconnectTimer: number | undefined;
  /** Incoming messages are decrypted asynchronously but applied strictly in order. */
  private inbox: Promise<void> = Promise.resolve();

  private syncedVersions = new Map<string, number>();
  private syncedFiles = new Set<string>();
  private sendTimer: number | undefined;
  private sending = false;
  private lastPointer = 0;
  private pointerTimer: number | undefined;

  state: ConnState = "connecting";
  you: Peer | null = null;
  peers = new Map<string, Peer>();
  private collaborators = new Map<SocketId, Collaborator>();

  terminals = new Map<string, TerminalInfo & { label: string }>();
  /** Web tunnels of the board, with their decrypted target. */
  webs = new Map<string, WebInfo & { target: WebTarget | null }>();
  private webKeys = new Map<string, Promise<SymKey>>();
  private pendingWebs = new Map<string, { resolve: (w: WebInfo) => void; reject: (e: Error) => void }>();
  private termKeys = new Map<string, Promise<SymKey>>();
  private termListeners = new Map<string, Set<TermListener>>();
  /** Last output sequence accepted per terminal, to drop replayed or reordered chunks. */
  private termSeq = new Map<string, { gen: string; seq: number }>();
  /** Replays we asked for: anything else is ignored (it would reset the replay protection). */
  private awaitingReplay = new Set<string>();
  /** Resolvers waiting for a terminal's current gen, which keystrokes are bound to. */
  private genWaiters = new Map<string, (() => void)[]>();
  private pendingCreates = new Map<string, { resolve: (t: TerminalInfo) => void; reject: (e: Error) => void }>();
  /** Input frames: sender id + strictly increasing counter, checked by the agent. */
  private readonly sender = randomId().slice(0, 12);
  private inputCounter = 0;
  private outbox: Promise<void> = Promise.resolve();

  private listeners: { [K in keyof Events]: Set<Events[K]> } = {
    init: new Set(),
    peers: new Set(),
    state: new Set(),
    closed: new Set(),
    terminals: new Set(),
    localChange: new Set(),
    error: new Set(),
  };

  constructor(boardId: string, key: SymKey, epoch: number, role: Role) {
    this.boardId = boardId;
    this.key = key;
    this.epoch = epoch;
    this.role = role;
    this.connect();
  }

  get canEdit() {
    return this.role !== "viewer";
  }

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>) {
    for (const fn of this.listeners[event]) (fn as (...a: Parameters<Events[K]>) => void)(...args);
  }

  setApi(api: ExcalidrawImperativeAPI | null) {
    this.api = api;
    if (api && this.pendingInit) {
      const msg = this.pendingInit;
      this.pendingInit = null;
      this.enqueue(() => this.applyInit(msg));
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.sendTimer);
    this.ws?.close();
  }

  // ---- Connection --------------------------------------------------------------

  private setState(s: ConnState) {
    this.state = s;
    this.emit("state", s);
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?board=${encodeURIComponent(this.boardId)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      this.enqueue(() => this.onMessage(msg));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.disposed) return;
      this.ws = null;
      this.peers.clear();
      this.collaborators.clear();
      this.api?.updateScene({ collaborators: new Map() });
      this.emit("peers", []);
      if (ev.code >= 4400 && ev.code < 4500) {
        this.setState("closed");
        this.emit("closed", ev.code);
        return;
      }
      this.setState("reconnecting");
      const delay = Math.min(30_000, 500 * 2 ** this.retries++) * (0.75 + Math.random() / 2);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private enqueue(fn: () => Promise<void> | void) {
    this.inbox = this.inbox.then(fn).catch((e) => console.error("[excalibash]", e));
  }

  private send(msg: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private async onMessage(msg: any) {
    switch (msg.t) {
      case "init":
        this.retries = 0;
        this.you = msg.you;
        this.epoch = msg.epoch;
        this.peers = new Map(msg.peers.map((p: Peer) => [p.id, p]));
        await this.setTerminals(msg.terminals);
        await this.setWebs(msg.webs ?? []);
        this.emit("peers", [...this.peers.values()]);
        this.emit("init", msg);
        if (this.api) await this.applyInit(msg);
        else this.pendingInit = msg;
        break;
      case "scene":
        await this.applyRemoteElements(msg.elements);
        break;
      case "files":
        await this.applyRemoteFiles(msg.files);
        break;
      case "rekey":
        this.emit("closed", 4409);
        break;
      case "peer.join":
        this.peers.set(msg.peer.id, msg.peer);
        this.emit("peers", [...this.peers.values()]);
        break;
      case "peer.leave":
        this.peers.delete(msg.id);
        this.collaborators.delete(msg.id as SocketId);
        this.api?.updateScene({ collaborators: new Map(this.collaborators) });
        this.emit("peers", [...this.peers.values()]);
        break;
      case "pointer": {
        const p = await decryptPointer(this.key, this.boardId, msg.c).catch(() => null);
        if (!p) return;
        this.collaborators.set(msg.id as SocketId, {
          id: msg.userId,
          socketId: msg.id as SocketId,
          pointer: p.pointer,
          button: p.button,
          selectedElementIds: p.selectedElementIds,
          username: msg.name,
          color: { background: msg.color, stroke: msg.color },
        });
        this.api?.updateScene({ collaborators: new Map(this.collaborators) });
        break;
      }
      case "term":
        await this.setTerminals([msg.terminal], true);
        break;
      case "web":
        await this.setWebs([msg.web], true);
        break;
      case "web.created":
        await this.setWebs([msg.web], true);
        this.pendingWebs.get(msg.reqId)?.resolve(msg.web);
        this.pendingWebs.delete(msg.reqId);
        break;
      case "web.gone":
        this.webs.delete(msg.id);
        this.emit("terminals");
        break;
      case "term.gone":
        this.terminals.delete(msg.id);
        this.emit("terminals");
        break;
      case "term.created": {
        await this.setTerminals([msg.terminal], true);
        this.pendingCreates.get(msg.reqId)?.resolve(msg.terminal);
        this.pendingCreates.delete(msg.reqId);
        break;
      }
      case "term.replay": {
        const ls = this.termListeners.get(msg.id);
        if (!ls?.size || !this.awaitingReplay.delete(msg.id)) return;
        this.termSeq.delete(msg.id);
        const parts: Uint8Array[] = [];
        for (const c of msg.chunks as Chunk[]) {
          const d = await this.decryptOutput(msg.id, c);
          if (d) parts.push(d);
        }
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        for (const l of ls) l.onReplay(all);
        break;
      }
      case "term.data": {
        const ls = this.termListeners.get(msg.id);
        if (!ls?.size) return;
        const data = await this.decryptOutput(msg.id, msg);
        if (data) for (const l of ls) l.onData(data);
        break;
      }
      case "term.error":
        this.emit("error", `Terminal : ${msg.message}`);
        break;
      case "error":
        if (msg.reqId && this.pendingCreates.has(msg.reqId)) {
          this.pendingCreates.get(msg.reqId)!.reject(new Error(msg.message));
          this.pendingCreates.delete(msg.reqId);
        } else if (msg.reqId && this.pendingWebs.has(msg.reqId)) {
          this.pendingWebs.get(msg.reqId)!.reject(new Error(msg.message));
          this.pendingWebs.delete(msg.reqId);
        } else this.emit("error", msg.message);
        break;
    }
  }

  // ---- Scene sync --------------------------------------------------------------

  private async applyInit(msg: any) {
    const remote = msg.elements as Entry[];
    this.syncedVersions = new Map(remote.map((e) => [e.id, e.v]));
    await this.applyRemoteElements(remote, true);
    this.syncedFiles = new Set(Object.keys(msg.files ?? {}));
    await this.applyRemoteFiles(msg.files ?? {});
    this.setState("online");
    if (this.canEdit) this.queueSend();
    for (const id of this.termListeners.keys()) {
      this.awaitingReplay.add(id);
      this.send({ t: "term.sub", id });
    }
  }

  private async applyRemoteElements(entries: Entry[], initial = false) {
    const api = this.api;
    if (!api) return;
    const elements: OrderedExcalidrawElement[] = [];
    for (const e of entries) {
      try {
        elements.push(await decryptEntry(this.key, this.boardId, e));
      } catch {
        console.warn("[excalibash] élément rejeté (déchiffrement/authentification)", e.id);
        continue;
      }
      if (initial || (this.syncedVersions.get(e.id) ?? -1) < e.v) this.syncedVersions.set(e.id, e.v);
    }
    const restored = restoreElements(elements, null) as any;
    const reconciled = reconcileElements(api.getSceneElementsIncludingDeleted() as OrderedExcalidrawElement[], restored, api.getAppState() as AppState);
    api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
  }

  private async applyRemoteFiles(files: Record<string, string>) {
    const out: BinaryFiles = {};
    for (const [id, c] of Object.entries(files)) {
      this.syncedFiles.add(id);
      try {
        out[id] = await decryptFile(this.key, this.boardId, id, c);
      } catch {
        console.warn("[excalibash] fichier rejeté", id);
      }
    }
    if (Object.keys(out).length) this.api?.addFiles(Object.values(out));
  }

  /** Called from Excalidraw's onChange. */
  handleChange(elements: readonly OrderedExcalidrawElement[], files: BinaryFiles) {
    if (this.state !== "online" || !this.canEdit) return;
    if (elements.some((e) => (this.syncedVersions.get(e.id) ?? -1) < e.version)) this.queueSend();
    const newFiles = Object.keys(files).filter((id) => !this.syncedFiles.has(id));
    if (newFiles.length) {
      for (const id of newFiles) this.syncedFiles.add(id);
      void (async () => {
        const out: Record<string, string> = {};
        for (const id of newFiles) out[id] = await encryptFile(this.key, this.boardId, id, files[id]);
        this.send({ t: "files", epoch: this.epoch, files: out });
      })();
    }
  }

  private queueSend() {
    if (this.sendTimer) return;
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = undefined;
      void this.flushElements();
    }, SEND_INTERVAL);
  }

  private async flushElements() {
    const api = this.api;
    if (!api || this.state !== "online" || this.sending) return;
    const changed: OrderedExcalidrawElement[] = [];
    for (const e of api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[]) {
      const prev = this.syncedVersions.get(e.id);
      if ((prev ?? -1) >= e.version) continue;
      if (e.isDeleted && prev !== undefined) {
        const data = e.customData as Record<string, any> | undefined;
        const tid = terminalIdOf(e);
        // A standalone terminal deleted here ends its shell (undo shows a "relaunch" button). A
        // node's window is only hidden; deleting the node itself ends all of its shells.
        if (tid && !data?.nodeId) this.closeTerminal(tid);
        if (data?.webId && !data?.nodeId) this.closeWeb(data.webId);
        if (data?.node) {
          for (const sh of data.shells ?? []) this.closeTerminal(sh.terminalId);
          for (const w of data.webs ?? []) this.closeWeb(w.webId);
        }
      }
      changed.push(e);
    }
    if (!changed.length) return;
    this.sending = true;
    try {
      const entries = await Promise.all(changed.map((e) => encryptEntry(this.key, this.boardId, e)));
      if (this.send({ t: "scene", epoch: this.epoch, elements: entries })) {
        for (const e of changed) this.syncedVersions.set(e.id, Math.max(this.syncedVersions.get(e.id) ?? -1, e.version));
        this.emit("localChange");
      }
    } finally {
      this.sending = false;
    }
    // Edits made while encrypting go out in the next batch.
    if ((api.getSceneElementsIncludingDeleted() as readonly OrderedExcalidrawElement[]).some((e) => (this.syncedVersions.get(e.id) ?? -1) < e.version)) {
      this.queueSend();
    }
  }

  handlePointer(payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "up" | "down" }) {
    const sendIt = async () => {
      this.lastPointer = performance.now();
      const c = await encryptPointer(this.key, this.boardId, {
        pointer: payload.pointer,
        button: payload.button,
        selectedElementIds: this.api?.getAppState().selectedElementIds ?? {},
      });
      this.send({ t: "pointer", c });
    };
    clearTimeout(this.pointerTimer);
    if (performance.now() - this.lastPointer >= POINTER_INTERVAL) void sendIt();
    else this.pointerTimer = window.setTimeout(() => void sendIt(), POINTER_INTERVAL);
  }

  // ---- Terminals ---------------------------------------------------------------

  private async setTerminals(list: TerminalInfo[], merge = false) {
    if (!merge) this.terminals.clear();
    for (const t of list) {
      const prev = this.terminals.get(t.id);
      if (!prev || prev.keyForBoard !== t.keyForBoard) {
        this.termKeys.set(t.id, unwrapKey(this.key, t.keyForBoard, AAD.termKey(this.boardId, t.id)));
      }
      const label = prev && prev.encLabel === t.encLabel ? prev.label : await unboxText(this.key, t.encLabel, AAD.termLabel(this.boardId, t.id)).catch(() => "Terminal");
      this.terminals.set(t.id, { ...t, label });
    }
    this.emit("terminals");
  }

  private async decryptOutput(id: string, c: Chunk): Promise<Uint8Array | null> {
    const kp = this.termKeys.get(id);
    if (!kp) return null;
    const last = this.termSeq.get(id);
    if (last && last.gen === c.gen && c.seq <= last.seq) return null;
    try {
      const data = await unbox(await kp, c.d, AAD.termOut(id, c.gen, c.seq));
      if (last?.gen !== c.gen) this.termSeq.set(id, { gen: c.gen, seq: c.seq });
      else last.seq = c.seq;
      for (const wake of this.genWaiters.get(id)?.splice(0) ?? []) wake();
      return data;
    } catch {
      return null;
    }
  }

  async createTerminal(machine: { id: string; name: string; auth: SymKey }, cols: number, rows: number): Promise<TerminalInfo> {
    const id = randomId();
    const kt = await newSymKey();
    const frame = {
      id,
      machineId: machine.id,
      cols,
      rows,
      keyForBoard: await wrapKey(this.key, kt, AAD.termKey(this.boardId, id)),
      // Boxed under the owner-only machine auth key: the agent refuses keys anyone else could forge.
      keyForAgent: await box(machine.auth, kt.raw, AAD.termAgent(id)),
      encLabel: await boxText(this.key, machine.name, AAD.termLabel(this.boardId, id)),
    };
    const reqId = randomId();
    return new Promise((resolve, reject) => {
      if (!this.send({ t: "term.create", reqId, ...frame })) {
        reject(new Error("Pas connecté au serveur"));
        return;
      }
      this.pendingCreates.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingCreates.delete(reqId)) reject(new Error("Le serveur ne répond pas"));
      }, 10_000);
    });
  }

  // ---- Web tunnels --------------------------------------------------------------

  private async setWebs(list: WebInfo[], merge = false) {
    if (!merge) this.webs.clear();
    for (const w of list) {
      const prev = this.webs.get(w.id);
      if (!prev || prev.keyForBoard !== w.keyForBoard) this.webKeys.set(w.id, unwrapKey(this.key, w.keyForBoard, AAD.webKey(this.boardId, w.id)));
      const target =
        prev && prev.encLabel === w.encLabel ? prev.target : await unboxJson<WebTarget>(this.key, w.encLabel, AAD.webLabel(this.boardId, w.id)).catch(() => null);
      this.webs.set(w.id, { ...w, target });
    }
    this.emit("terminals");
  }

  /** The tunnel key, for handing to the proxy origin's service worker. */
  async webKey(id: string): Promise<string | null> {
    const k = this.webKeys.get(id);
    return k ? toB64((await k).raw) : null;
  }

  /**
   * A tunnel to `target` on one of our machines. The target is sealed with the key under the
   * owner-only machine auth key, so neither the server nor anyone else can redirect it.
   */
  async createWeb(machine: { id: string; name: string; auth: SymKey }, target: Omit<WebTarget, "machine">): Promise<WebInfo> {
    const id = randomId();
    const kw = await newSymKey();
    const full: WebTarget = { ...target, machine: machine.name };
    const frame = {
      id,
      machineId: machine.id,
      keyForBoard: await wrapKey(this.key, kw, AAD.webKey(this.boardId, id)),
      keyForAgent: await boxJson(machine.auth, { k: toB64(kw.raw), url: target.url, insecure: target.insecure }, AAD.webAgent(id)),
      encLabel: await boxJson(this.key, full, AAD.webLabel(this.boardId, id)),
    };
    const reqId = randomId();
    return new Promise((resolve, reject) => {
      if (!this.send({ t: "web.create", reqId, ...frame })) {
        reject(new Error("Pas connecté au serveur"));
        return;
      }
      this.pendingWebs.set(reqId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingWebs.delete(reqId)) reject(new Error("Le serveur ne répond pas"));
      }, 10_000);
    });
  }

  closeWeb(id: string) {
    this.send({ t: "web.close", id });
  }

  subscribeTerminal(id: string, listener: TermListener): () => void {
    let set = this.termListeners.get(id);
    if (!set) this.termListeners.set(id, (set = new Set()));
    set.add(listener);
    this.awaitingReplay.add(id);
    this.send({ t: "term.sub", id });
    return () => {
      set!.delete(listener);
      if (!set!.size) this.termListeners.delete(id);
    };
  }

  /** Keystrokes are encrypted in order: each frame waits for the previous one. */
  terminalInput(id: string, data: string | Uint8Array) {
    if (!this.canEdit) return;
    const bytes = typeof data === "string" ? utf8(data) : data;
    this.outbox = this.outbox
      .then(async () => {
        const kp = this.termKeys.get(id);
        if (!kp) return;
        const gen = await this.currentGen(id);
        if (!gen) return;
        const k = ++this.inputCounter;
        const ts = Date.now();
        const d = await box(await kp, bytes, AAD.termIn(id, gen, this.sender, k, ts));
        this.send({ t: "term.input", id, s: this.sender, k, ts, d });
      })
      .catch((e) => console.error("[excalibash]", e));
  }

  /** The agent announces each new gen (shell start, rekey, reconnect); wait briefly for it. */
  private async currentGen(id: string): Promise<string | undefined> {
    const known = this.termSeq.get(id)?.gen;
    if (known) return known;
    await new Promise<void>((resolve) => {
      const list = this.genWaiters.get(id) ?? [];
      list.push(resolve);
      this.genWaiters.set(id, list);
      setTimeout(resolve, 5000);
    });
    return this.termSeq.get(id)?.gen;
  }

  resizeTerminal(id: string, cols: number, rows: number) {
    if (this.canEdit) this.send({ t: "term.resize", id, cols, rows });
  }

  closeTerminal(id: string) {
    this.send({ t: "term.close", id });
  }

  restartTerminal(id: string) {
    this.send({ t: "term.restart", id });
  }
}
