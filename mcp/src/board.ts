// One live, end-to-end encrypted connection to a board, mirroring web/src/board/collab.ts
// (same wire protocol) without any UI: decrypted elements, terminal keys, scrollback buffers.
import type { Entry, Role, TerminalInfo } from "../../web/src/api.ts";
import { AAD, box, randomId, unbox, unboxText, unwrapKey, utf8, type SymKey } from "../../web/src/crypto.ts";
import { decryptEntry, encryptEntry } from "../../web/src/board/boardCrypto.ts";
import { cookieHeader, serverUrl } from "./client.ts";

type Chunk = { gen: string; seq: number; d: string };
type Term = TerminalInfo & { label: string };
type Buf = { text: string; total: number; decoder: TextDecoder };

const BUF_CAP = 400_000;
const IDLE_MS = 10 * 60_000;

/** Sender id and counter are per process: the agent checks k is strictly increasing per sender. */
const SENDER = randomId().slice(0, 12);
let inputCounter = 0;

export const CLOSE_REASONS: Record<number, string> = {
  4001: "session terminée : relance « login »",
  4403: "accès à ce tableau perdu",
  4404: "tableau supprimé ou mis à la corbeille",
  4409: "clés du tableau renouvelées (révocation) : réessaie, la connexion sera rouverte",
  4410: "droits modifiés : réessaie",
};

export class BoardConnection {
  readonly boardId: string;
  readonly key: SymKey;
  role: Role;
  epoch = 0;
  elements = new Map<string, any>();
  terminals = new Map<string, Term>();
  closedReason: string | null = null;
  lastUsed = Date.now();

  private ws: WebSocket | null = null;
  private inbox: Promise<void> = Promise.resolve();
  private retries = 0;
  private disposed = false;
  private everInit = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private termKeys = new Map<string, Promise<SymKey>>();
  private bufs = new Map<string, Buf>();
  private seqs = new Map<string, { gen: string; seq: number }>();
  private subscribed = new Set<string>();
  private replayWaiters = new Map<string, () => void>();
  private genWaiters = new Map<string, (() => void)[]>();
  private outbox: Promise<unknown> = Promise.resolve();
  private errors: string[] = [];
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;
  onClosed: (reason: string) => void = () => {};

  constructor(boardId: string, key: SymKey, role: Role) {
    this.boardId = boardId;
    this.key = key;
    this.role = role;
    this.ready = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.ready.catch(() => {});
    this.connect();
    setTimeout(() => this.readyReject(new Error("Le serveur ne répond pas (connexion au tableau).")), 15_000).unref();
  }

  get canEdit() {
    return this.role !== "viewer";
  }

  touch() {
    this.lastUsed = Date.now();
  }

  idleTooLong() {
    return Date.now() - this.lastUsed > IDLE_MS;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  // ---- Connection --------------------------------------------------------------

  private connect() {
    const url = `${serverUrl().replace(/^http/, "ws")}/ws?board=${encodeURIComponent(this.boardId)}`;
    const ws = new (WebSocket as any)(url, { headers: { cookie: cookieHeader() } }) as WebSocket;
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.inbox = this.inbox.then(() => this.onMessage(msg)).catch((e) => void process.stderr.write(`[board] ${e?.message ?? e}\n`));
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws || this.disposed) return;
      this.ws = null;
      if (ev.code >= 4000 && ev.code < 4500) return this.shutdown(CLOSE_REASONS[ev.code] ?? `connexion fermée (code ${ev.code})`);
      if (!this.everInit) return this.shutdown("connexion refusée ou impossible (accès au tableau ? certificat du serveur ?)");
      const delay = Math.min(30_000, 500 * 2 ** this.retries++) * (0.75 + Math.random() / 2);
      this.timer = setTimeout(() => this.connect(), delay);
      this.timer.unref?.();
    };
  }

  private shutdown(reason: string) {
    this.closedReason = reason;
    this.disposed = true;
    this.readyReject(new Error(`Tableau indisponible : ${reason}.`));
    for (const w of this.replayWaiters.values()) w();
    this.onClosed(reason);
  }

  private send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private async onMessage(msg: any) {
    switch (msg.t) {
      case "init": {
        this.retries = 0;
        this.epoch = msg.epoch;
        if (msg.you?.role) this.role = msg.you.role;
        this.elements.clear();
        await this.applyElements(msg.elements ?? []);
        await this.setTerminals(msg.terminals ?? [], false);
        // Scrollback is re-requested after a reconnect.
        this.bufs.clear();
        this.seqs.clear();
        const again = [...this.subscribed];
        this.subscribed.clear();
        for (const id of again) this.requestReplay(id);
        this.everInit = true;
        this.readyResolve();
        break;
      }
      case "scene":
        await this.applyElements(msg.elements ?? []);
        break;
      case "rekey":
        this.shutdown(CLOSE_REASONS[4409]);
        this.ws?.close();
        break;
      case "term":
      case "term.created":
        await this.setTerminals([msg.terminal], true);
        break;
      case "term.gone":
        this.terminals.delete(msg.id);
        break;
      case "term.replay": {
        if (!this.replayWaiters.has(msg.id)) return;
        this.seqs.delete(msg.id);
        const buf: Buf = { text: "", total: 0, decoder: new TextDecoder() };
        this.bufs.set(msg.id, buf);
        for (const c of msg.chunks as Chunk[]) {
          const d = await this.decryptOutput(msg.id, c);
          if (d) this.append(buf, d);
        }
        this.subscribed.add(msg.id);
        this.replayWaiters.get(msg.id)?.();
        this.replayWaiters.delete(msg.id);
        break;
      }
      case "term.data": {
        const buf = this.bufs.get(msg.id);
        if (!buf) return; // no baseline yet: only subscribed terminals are followed
        const d = await this.decryptOutput(msg.id, msg);
        if (d) this.append(buf, d);
        break;
      }
      case "error":
        this.errors.push(String(msg.message ?? "erreur"));
        break;
    }
  }

  private append(buf: Buf, data: Uint8Array) {
    const s = buf.decoder.decode(data, { stream: true });
    buf.total += s.length;
    buf.text += s;
    if (buf.text.length > BUF_CAP) buf.text = buf.text.slice(buf.text.length - BUF_CAP);
  }

  // ---- Scene -------------------------------------------------------------------

  private async applyElements(entries: Entry[]) {
    for (const e of entries) {
      try {
        const el = await decryptEntry(this.key, this.boardId, e);
        const cur = this.elements.get(el.id);
        // Excalidraw's rule, as on the server: higher version wins, then the lower nonce.
        if (!cur || el.version > cur.version || (el.version === cur.version && el.versionNonce < cur.versionNonce)) this.elements.set(el.id, el);
      } catch {
        process.stderr.write(`[board] élément rejeté (authentification) ${e.id}\n`);
      }
    }
  }

  /** Sends one new element exactly like the web client's "scene" message. */
  async addElement(el: any): Promise<void> {
    if (!this.canEdit) throw new Error("Tableau en lecture seule pour ce compte.");
    this.errors.length = 0;
    const entry = await encryptEntry(this.key, this.boardId, el);
    if (!this.send({ t: "scene", epoch: this.epoch, elements: [entry] })) throw new Error("Pas connecté au serveur.");
    await new Promise((r) => setTimeout(r, 400));
    if (this.closedReason) throw new Error(`Tableau indisponible : ${this.closedReason}.`);
    if (this.errors.length) throw new Error(`Refusé par le serveur : ${this.errors[0]}`);
    this.elements.set(el.id, el);
  }

  // ---- Terminals ---------------------------------------------------------------

  private async setTerminals(list: TerminalInfo[], merge: boolean) {
    if (!merge) this.terminals.clear();
    for (const t of list) {
      const prev = this.terminals.get(t.id);
      if (!prev || prev.keyForBoard !== t.keyForBoard) {
        const p = unwrapKey(this.key, t.keyForBoard, AAD.termKey(this.boardId, t.id));
        p.catch(() => {});
        this.termKeys.set(t.id, p);
      }
      const label = prev && prev.encLabel === t.encLabel ? prev.label : await unboxText(this.key, t.encLabel, AAD.termLabel(this.boardId, t.id)).catch(() => "Terminal");
      this.terminals.set(t.id, { ...t, label });
    }
  }

  private async decryptOutput(id: string, c: Chunk): Promise<Uint8Array | null> {
    const kp = this.termKeys.get(id);
    if (!kp) return null;
    const last = this.seqs.get(id);
    if (last && last.gen === c.gen && c.seq <= last.seq) return null; // replayed or reordered
    try {
      const data = await unbox(await kp, c.d, AAD.termOut(id, c.gen, c.seq));
      if (last?.gen !== c.gen) this.seqs.set(id, { gen: c.gen, seq: c.seq });
      else last.seq = c.seq;
      for (const wake of this.genWaiters.get(id)?.splice(0) ?? []) wake();
      return data;
    } catch {
      return null;
    }
  }

  private requestReplay(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.replayWaiters.set(id, resolve);
      if (!this.send({ t: "term.sub", id })) {
        this.replayWaiters.delete(id);
        return reject(new Error("Pas connecté au serveur."));
      }
      setTimeout(() => {
        if (this.replayWaiters.delete(id)) reject(new Error("Le serveur n'a pas renvoyé l'historique du terminal."));
      }, 8000).unref();
    });
  }

  /** Subscribes once (replay, then live output) and returns the terminal's buffer. */
  private async follow(id: string): Promise<Buf> {
    await this.ready;
    if (!this.terminals.has(id)) throw new Error("Terminal inconnu sur ce tableau.");
    if (!this.termKeys.has(id)) throw new Error("Clé du terminal indisponible.");
    if (!this.subscribed.has(id)) await this.requestReplay(id);
    const buf = this.bufs.get(id);
    if (!buf) throw new Error("Historique du terminal indisponible.");
    return buf;
  }

  async scrollback(id: string): Promise<string> {
    return (await this.follow(id)).text;
  }

  /** Types `text` and returns the output that arrives during `waitMs`. */
  async typeInto(id: string, text: string, waitMs: number): Promise<string> {
    if (!this.canEdit) throw new Error("Rôle lecteur : saisie impossible dans ce tableau.");
    const buf = await this.follow(id);
    const kp = this.termKeys.get(id)!;
    const mark = buf.total;
    const job = this.outbox.then(async () => {
      let gen = this.seqs.get(id)?.gen;
      if (!gen) {
        await new Promise<void>((resolve) => {
          const l = this.genWaiters.get(id) ?? [];
          l.push(resolve);
          this.genWaiters.set(id, l);
          setTimeout(resolve, 5000).unref();
        });
        gen = this.seqs.get(id)?.gen;
      }
      if (!gen) throw new Error("Le terminal n'a pas encore annoncé sa session (hors ligne ?).");
      const k = ++inputCounter;
      const ts = Date.now();
      const d = await box(await kp, utf8(text), AAD.termIn(id, gen, SENDER, k, ts));
      if (!this.send({ t: "term.input", id, s: SENDER, k, ts, d })) throw new Error("Pas connecté au serveur.");
    });
    this.outbox = job.catch(() => {});
    await job;
    await new Promise((r) => setTimeout(r, waitMs));
    const got = buf.total - mark;
    return got <= 0 ? "" : buf.text.slice(Math.max(0, buf.text.length - got));
  }
}

