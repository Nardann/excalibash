// Runs the cells of a shared notebook on the kernel session of its machine, for every participant.
//
// The kernel is a "jupyter" terminal: ONE session, ONE kernel, shared by everybody who has the key of
// the terminal. Every client parses the same output stream (LineSplitter / parseEvent), but a run has
// exactly one executor, the client whose user clicked "run":
//   - it sends {"op":"exec","id":"<cellId>:<random>","code"} and, in the same Y transaction, sets
//     cell.running = id and clears the outputs (beginRun);
//   - only it (the id is in its local `execs` map) writes the events of that id into the cell's
//     outputs, batched every 80 ms and in pieces small enough for one document update, and ends the
//     run on `done` (execution_count, running removed);
//   - it advertises its in-flight ids in its awareness state (`execs`).
// If the executor leaves mid-run, any editor that sees a cell `running` under an id that is in nobody's
// awareness for 5 s finalizes it once the kernel is idle (or the `done` of that id went by): the count is
// recorded and `running` removed. Output events produced after the executor left are not recorded.
// Pure TypeScript (timers only): the same code runs in the window and in the e2e scenario.
import type * as Y from "yjs";
import { LineSplitter, encodeOp, parseEvent, type KernelEvent, type KernelState } from "./kernelProtocol.ts";
import { applyKernelEvents, beginRun, cellViews, cutAt, eventWeight, findCell, finishRun, newWriteState, type WriteState } from "./notebookDoc.ts";

/** What the runner needs from the board session: the sealed terminal stream of the kernel. */
export type TermPort = {
  subscribe(term: string, l: { onReplay(data: Uint8Array): void; onData(data: Uint8Array): void }): () => void;
  input(term: string, data: Uint8Array): void;
};
export type AwarenessLike = {
  getStates(): Map<number, any>;
  setLocalStateField(field: string, value: unknown): void;
};

export type KernelStatus = KernelState | "absent";
export type RunResult = { ok: true; execId: string } | { ok: false; reason: string };

const FLUSH_MS = 80;
/** Serialized size of the events written in one transaction: one document update must stay under 380 KiB. */
const BATCH_BUDGET = 160 * 1024;
const INPUT_CHUNK = 48 * 1024;
const ORPHAN_MS = 5000;
const SWEEP_MS = 1500;

type Exec = { cellId: string; st: WriteState; queue: KernelEvent[]; timer?: ReturnType<typeof setTimeout> };

const enc = new TextEncoder();

export class NotebookRunner {
  status: KernelStatus = "absent";
  /** The bridge's last fatal message (kernel missing, ipykernel not installed…). */
  fatal: string | null = null;
  term: string | null = null;
  private ydoc: Y.Doc;
  private port: TermPort;
  private awareness: AwarenessLike | undefined;
  private canEdit: boolean;
  private execs = new Map<string, Exec>();
  private foreignDone = new Map<string, number | null>();
  private orphanSince = new Map<string, number>();
  private splitter = new LineSplitter();
  private off: (() => void) | null = null;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<() => void>();
  private destroyed = false;

  constructor(ydoc: Y.Doc, port: TermPort, o: { awareness?: AwarenessLike; canEdit: boolean }) {
    this.ydoc = ydoc;
    this.port = port;
    this.awareness = o.awareness;
    this.canEdit = o.canEdit;
    if (o.canEdit) this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
  }

  /** Called when the status or the pending runs change. */
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** The ids of the runs this client executes. */
  get localRuns(): string[] {
    return [...this.execs.keys()];
  }

  /** Follows the kernel session `term` (or none). The stream is replayed first: every client sees the same events. */
  attach(term: string | null) {
    if (this.destroyed || term === this.term) return;
    this.off?.();
    this.off = null;
    this.term = term;
    this.splitter = new LineSplitter();
    if (term) this.fatal = null;
    this.status = term ? "idle" : "absent";
    if (term) {
      this.off = this.port.subscribe(term, {
        onReplay: (d) => {
          this.splitter = new LineSplitter();
          this.consume(d);
        },
        onData: (d) => this.consume(d),
      });
    }
    this.emit();
  }

  private consume(data: Uint8Array) {
    for (const line of this.splitter.push(data)) {
      const ev = parseEvent(line);
      if (ev) this.handle(ev);
    }
  }

  private handle(ev: KernelEvent) {
    switch (ev.ev) {
      case "status":
        this.status = ev.state;
        this.emit();
        return;
      case "fatal":
        this.status = "dead";
        this.fatal = typeof ev.error === "string" ? ev.error.slice(0, 500) : "Noyau arrêté";
        this.emit();
        return;
      case "ready":
      case "log":
      case "pong":
      case "complete":
      case "inspect":
        return;
    }
    const id = (ev as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const ex = this.execs.get(id);
    if (ex) {
      ex.queue.push(ev);
      this.schedule(id, ex);
    } else if (ev.ev === "done") {
      this.foreignDone.set(id, typeof ev.count === "number" ? ev.count : null);
      if (this.foreignDone.size > 500) this.foreignDone.delete(this.foreignDone.keys().next().value!);
    }
  }

  // ---- executor side ---------------------------------------------------------------------------------------------

  private schedule(id: string, ex: Exec) {
    if (ex.timer) return;
    ex.timer = setTimeout(() => {
      ex.timer = undefined;
      this.flush(id, ex);
    }, FLUSH_MS);
  }

  /** The next events, as many as fit the budget; a big stream text is cut and its rest stays queued. */
  private take(ex: Exec): KernelEvent[] {
    const batch: KernelEvent[] = [];
    let used = 0;
    while (ex.queue.length) {
      const ev = ex.queue[0];
      const w = eventWeight(ev);
      if (used + w > BATCH_BUDGET && batch.length) break;
      if (ev.ev === "stream" && used + w > BATCH_BUDGET) {
        const n = cutAt(ev.text, Math.max(1, BATCH_BUDGET - used - 64));
        if (n < ev.text.length) {
          batch.push({ ...ev, text: ev.text.slice(0, n) });
          ex.queue[0] = { ...ev, text: ev.text.slice(n) };
          break;
        }
      }
      batch.push(ex.queue.shift()!);
      used += w;
    }
    return batch;
  }

  private flush(id: string, ex: Exec) {
    if (!this.execs.has(id)) return;
    const batch = this.take(ex);
    let finished = false;
    try {
      finished = applyKernelEvents(this.ydoc, ex.cellId, id, batch, ex.st);
    } catch (e) {
      console.error("[excalibash]", e);
    }
    const still = findCell(this.ydoc, ex.cellId)?.running === id;
    if (finished || !still) return this.forget(id);
    if (ex.queue.length) this.schedule(id, ex);
  }

  private forget(id: string) {
    const ex = this.execs.get(id);
    if (ex?.timer) clearTimeout(ex.timer);
    this.execs.delete(id);
    this.publish();
    this.emit();
  }

  private publish() {
    this.awareness?.setLocalStateField("execs", [...this.execs.keys()]);
  }

  /** Sends one request line to the kernel session, in pieces (a terminal frame is limited). */
  private send(line: string) {
    if (!this.term) return;
    const bytes = enc.encode(line);
    for (let i = 0; i < bytes.length; i += INPUT_CHUNK) this.port.input(this.term, bytes.subarray(i, i + INPUT_CHUNK));
  }

  /** Runs a cell on the shared kernel; this client becomes its executor. */
  run(cellId: string): RunResult {
    if (!this.canEdit) return { ok: false, reason: "Lecture seule" };
    if (!this.term || this.status === "absent") return { ok: false, reason: "Aucun noyau : démarre-le d'abord" };
    if (this.status === "dead") return { ok: false, reason: "Le noyau est arrêté : redémarre-le" };
    const cell = findCell(this.ydoc, cellId);
    if (!cell) return { ok: false, reason: "Cellule introuvable" };
    const execId = `${cellId.slice(0, 36)}:${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`;
    let line: string;
    try {
      line = encodeOp({ op: "exec", id: execId, code: cell.source.toString() });
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? "Requête refusée" };
    }
    // The state of a run is registered before anything goes out: its first events can't be missed.
    this.execs.set(execId, { cellId, st: newWriteState(), queue: [] });
    const begun = beginRun(this.ydoc, cellId, execId);
    if (!begun.ok) {
      this.execs.delete(execId);
      return begun;
    }
    this.publish();
    this.send(line);
    this.emit();
    return { ok: true, execId };
  }

  /** Runs the given cells one after the other (the kernel queues them); returns how many were sent. */
  runMany(cellIds: string[]): number {
    let n = 0;
    for (const id of cellIds) {
      const r = this.run(id);
      if (r.ok) n++;
      else if (!/déjà en cours|Seules les cellules/.test(r.reason)) break;
    }
    return n;
  }

  interrupt(): boolean {
    if (!this.canEdit || !this.term) return false;
    this.send(encodeOp({ op: "interrupt" }));
    return true;
  }

  restart(): boolean {
    if (!this.canEdit || !this.term) return false;
    this.send(encodeOp({ op: "restart" }));
    return true;
  }

  /** The kernel session ended (terminal exited or removed): this client's runs end with an error. */
  terminalGone() {
    if (this.status !== "dead") {
      this.status = "dead";
      this.emit();
    }
    for (const [id, ex] of [...this.execs]) {
      const evs: KernelEvent[] = [
        { ev: "error", id, ename: "KernelStopped", evalue: "le noyau s'est arrêté", traceback: [] },
        { ev: "done", id, count: null, status: "error" },
      ];
      try {
        applyKernelEvents(this.ydoc, ex.cellId, id, evs, ex.st);
      } catch (e) {
        console.error("[excalibash]", e);
      }
      this.forget(id);
    }
  }

  // ---- everybody: finalize the runs whose executor is gone ----------------------------------------------------------

  private hasAwareExec(id: string): boolean {
    for (const [, s] of this.awareness?.getStates() ?? []) if (Array.isArray(s?.execs) && s.execs.includes(id)) return true;
    return false;
  }

  /** One pass of the orphan check (also called by tests). */
  sweep(now = Date.now()) {
    if (this.destroyed || !this.canEdit) return;
    const live = new Set<string>();
    for (const c of cellViews(this.ydoc)) {
      const id = c.running;
      if (!id || this.execs.has(id)) continue;
      live.add(id);
      const since = this.orphanSince.get(id) ?? now;
      this.orphanSince.set(id, since);
      if (now - since < ORPHAN_MS || this.hasAwareExec(id)) continue;
      const done = this.foreignDone.has(id);
      // Without a `done` the run only counts as lost when the kernel has nothing left to do.
      if (done || this.status !== "busy") {
        finishRun(this.ydoc, id, done ? this.foreignDone.get(id) : undefined);
        this.orphanSince.delete(id);
      }
    }
    for (const id of [...this.orphanSince.keys()]) if (!live.has(id)) this.orphanSince.delete(id);
  }

  destroy() {
    this.destroyed = true;
    this.off?.();
    this.off = null;
    clearInterval(this.sweeper);
    for (const ex of this.execs.values()) if (ex.timer) clearTimeout(ex.timer);
    this.execs.clear();
    try {
      this.awareness?.setLocalStateField("execs", []);
    } catch {
      /* the awareness is already gone */
    }
    this.listeners.clear();
  }
}
