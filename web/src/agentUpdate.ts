// One-click agent self-update, the browser side. The request is boxed under the machine auth key
// like a probe (the server relays it blind and cannot forge it); the agent downloads the release
// the maintainer signed offline, checks the signature with the key compiled into it, swaps its
// binary and restarts (agent/update.go). Nothing here can make an agent run anything else.
import { api } from "./api.ts";
import { AAD, boxJson, randomId, unboxJson } from "./crypto.ts";
import type { Machine } from "./vault.ts";

/** GET /api/agent/latest: the newest release published on this instance. */
export type LatestRelease = { version: string | null; signed: boolean };

export const fetchLatestRelease = () => api.get<LatestRelease>("/agent/latest").catch((): LatestRelease => ({ version: null, signed: false }));

// ---- versions (same rules as agent/update.go: semver-ish, no downgrade) ----------------------

function parse(v: string): { core: number[]; pre: string } | null {
  let s = v.trim().replace(/^v/, "");
  const plus = s.indexOf("+");
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : "";
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return { core: [...parts.map(Number), 0, 0, 0].slice(0, 3), pre };
}

function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const an = /^\d+$/.test(as[i]) ? Number(as[i]) : null;
    const bn = /^\d+$/.test(bs[i]) ? Number(bs[i]) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1;
    } else if (an !== null) return -1;
    else if (bn !== null) return 1;
    else if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
  }
  return as.length < bs.length ? -1 : as.length > bs.length ? 1 : 0;
}

/** -1, 0, 1, or null when either side is not a version ("dev", a git hash…). */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  return comparePre(pa.pre, pb.pre);
}

// ---- what can be done with a machine -------------------------------------------------------

export type Updatable =
  | "uptodate" //  nothing to do
  | "outdated" //  can be updated in one click
  | "manual" //    outdated, but the agent cannot update itself: update.sh
  | "offline" //   outdated, but not connected
  | "unknown"; //  version not comparable (dev build…)

export const hasUpdateCap = (m: Pick<Machine, "agentCaps">) => !!m.agentCaps?.includes("update");

/** Whether the machine's agent is older than the release published here. */
export function isOutdated(m: Pick<Machine, "agentVersion">, latest: LatestRelease): boolean {
  if (!latest.signed || !latest.version || !m.agentVersion) return false;
  return compareVersions(m.agentVersion, latest.version) === -1;
}

export function classify(m: Pick<Machine, "agentVersion" | "agentCaps" | "online" | "lastSeen">, latest: LatestRelease): Updatable {
  if (!m.lastSeen || !m.agentVersion) return "unknown";
  if (!latest.signed || !latest.version) return "unknown";
  const c = compareVersions(m.agentVersion, latest.version);
  if (c === null) return "unknown";
  if (c >= 0) return "uptodate";
  if (!hasUpdateCap(m)) return "manual";
  return m.online ? "outdated" : "offline";
}

export const OPEN_SESSIONS_WARNING = "La mise à jour redémarre l'agent : les shells ouverts sur la machine sont interrompus (les tableaux et la machine restent, les terminaux se rouvrent à vide).";

/** « 2 shells ouverts seront interrompus » for the confirmation texts. */
export function sessionsText(n: number): string {
  if (n <= 0) return "Aucun shell n'est ouvert sur cette machine.";
  return `${n} shell${n > 1 ? "s" : ""} ouvert${n > 1 ? "s" : ""} ${n > 1 ? "seront interrompus" : "sera interrompu"}.`;
}

// ---- one update ------------------------------------------------------------------------------

export type UpdateProgress =
  | { kind: "running"; msg: string }
  | { kind: "restarting"; version?: string }
  | { kind: "waiting" } //  the agent restarted: waiting for it to come back with the new version
  | { kind: "done"; version: string }
  | { kind: "failed"; reason: string };

type Frame = { n: number; phase: "check" | "download" | "install" | "restarting" | "error"; msg?: string; version?: string };

/** No frame at all within this time: the agent ignored the request (or is gone). */
const FIRST_FRAME_MS = 20_000;
const IDLE_MS = 150_000;

/**
 * Sends the boxed request and follows the agent's boxed progress frames (one per line of the
 * response). Resolves with the last frame seen, null if there was none.
 */
export async function requestUpdate(machine: Machine, boardId: string | undefined, onFrame: (f: Frame) => void, signal?: AbortSignal): Promise<Frame | null> {
  const rid = randomId();
  const ts = Date.now();
  const d = await boxJson(machine.auth, { op: "update" }, AAD.update(rid, ts));
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener("abort", abort);
  let timer = setTimeout(abort, FIRST_FRAME_MS);
  try {
    const res = await fetch(`/api/machines/${encodeURIComponent(machine.id)}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rid, ts, d, boardId: machine.access === "board" ? boardId : undefined }),
      credentials: "same-origin",
      signal: ctl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `Erreur ${res.status}`);
    }
    if (!res.body) throw new Error("Réponse illisible");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let last: Frame | null = null;
    let lastN = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(abort, IDLE_MS);
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let boxed: string;
        try {
          boxed = JSON.parse(line).d;
        } catch {
          continue;
        }
        // A frame the server altered or replayed from another request does not authenticate: ignored.
        const f = await unboxJson<Frame>(machine.auth, boxed, AAD.updateRes(rid)).catch(() => null);
        if (!f || typeof f.n !== "number" || f.n <= lastN) continue;
        lastN = f.n;
        last = f;
        onFrame(f);
      }
    }
    return last;
  } catch (e) {
    if (ctl.signal.aborted) {
      if (signal?.aborted) throw new Error("Annulé");
      throw new Error("L'agent ne répond pas (trop ancien, hors ligne, ou clé de la machine différente)");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export type Wait = { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };

/** Polls the machines list until the machine is back online with the expected version (or newer). */
export async function waitForVersion(machineId: string, expected: string, list: () => Promise<Machine[]>, w: Wait = {}): Promise<boolean> {
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (w.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    await sleep(w.pollMs ?? 2000);
    const m = (await list().catch(() => [])).find((x) => x.id === machineId);
    if (m?.online && m.agentVersion) {
      const c = compareVersions(m.agentVersion, expected);
      if (c === 0 || c === 1 || m.agentVersion === expected) return true;
    }
  }
  return false;
}

/**
 * The whole update of one machine: request, progress, then waiting for it to come back with the
 * new version. `onProgress` gets every step; the returned value is the final one.
 */
export async function updateMachine(
  machine: Machine,
  o: { boardId?: string; expected: string; list: () => Promise<Machine[]>; onProgress: (p: UpdateProgress) => void; signal?: AbortSignal; wait?: Wait },
): Promise<UpdateProgress> {
  const finish = (p: UpdateProgress) => (o.onProgress(p), p);
  try {
    o.onProgress({ kind: "running", msg: "demande envoyée" });
    let version = o.expected;
    const last = await requestUpdate(
      machine,
      o.boardId,
      (f) => {
        if (f.phase === "error") o.onProgress({ kind: "failed", reason: f.msg ?? "échec" });
        else if (f.phase === "restarting") {
          if (f.version) version = f.version;
          o.onProgress({ kind: "restarting", version: f.version });
        } else o.onProgress({ kind: "running", msg: f.msg ?? f.phase });
      },
      o.signal,
    );
    if (last?.phase === "error") return { kind: "failed", reason: last.msg ?? "échec" };
    if (last?.phase !== "restarting") return finish({ kind: "failed", reason: "connexion perdue avant la fin de la mise à jour" });
    o.onProgress({ kind: "waiting" });
    const back = await waitForVersion(machine.id, version, o.list, o.wait);
    return finish(back ? { kind: "done", version } : { kind: "failed", reason: "l'agent n'est pas revenu avec la nouvelle version au bout de 2 minutes (retour arrière automatique possible)" });
  } catch (e) {
    return finish({ kind: "failed", reason: e instanceof Error ? e.message : String(e) });
  }
}

/** Runs `job` over `items` with at most `limit` at a time; never rejects (jobs report their own failures). */
export async function runLimited<T>(items: T[], limit: number, job: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await job(item).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
