import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useKeys } from "../auth.tsx";
import { listMachines, type Machine } from "../vault.ts";
import {
  OPEN_SESSIONS_WARNING,
  classify,
  fetchLatestRelease,
  hasUpdateCap,
  isOutdated,
  sessionsText,
  updateMachine,
  runLimited,
  type LatestRelease,
  type UpdateProgress,
} from "../agentUpdate.ts";
import { needsUpdate } from "../agentCaps.ts";
import { Modal } from "./ui.tsx";
import { UpdateHowTo, useUpdateCommand } from "./AgentOutdated.tsx";

/** The release published on this instance (null while loading), refreshed from time to time. */
export function useLatestRelease(everyMs = 60_000): LatestRelease | null {
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchLatestRelease().then((l) => {
        if (alive) setLatest(l);
      });
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everyMs]);
  return latest;
}

export const NOT_CONFIGURED = "mise à jour automatique non configurée sur cette instance";

/** « Mettre à jour (1.0.0 → 2.0.0) » */
export function updateLabel(m: Pick<Machine, "agentVersion">, latest: LatestRelease | null): string {
  return m.agentVersion && latest?.version ? `Mettre à jour (${m.agentVersion} → ${latest.version})` : "Mettre à jour";
}

/** Why the one-click update is not possible for this machine (null: it is). */
export function disabledReason(m: Machine, latest: LatestRelease | null): string | null {
  if (!latest?.signed) return NOT_CONFIGURED;
  if (!hasUpdateCap(m)) return "cet agent est trop ancien pour se mettre à jour seul : utilise la commande manuelle";
  if (!m.online) return "machine hors ligne";
  if (!isOutdated(m, latest)) return "l'agent est déjà à la dernière version publiée";
  return null;
}

export function statusText(p: UpdateProgress): string {
  switch (p.kind) {
    case "running":
      return `en cours · ${p.msg}`;
    case "restarting":
    case "waiting":
      return "redémarre";
    case "done":
      return `réussi · ${p.version}`;
    case "failed":
      return `échec : ${p.reason}`;
  }
}

const isBusy = (p?: UpdateProgress) => !!p && (p.kind === "running" || p.kind === "restarting" || p.kind === "waiting");

/** The one-click button of a machine (Machines page) and its confirmation / progress dialog. */
export function MachineUpdate({ machine, latest, onChanged }: { machine: Machine; latest: LatestRelease | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const reason = disabledReason(machine, latest);
  const show = isOutdated(machine, latest ?? { version: null, signed: false }) || needsUpdate(machine.agentCaps);
  if (!machine.lastSeen || !show) return null;
  return (
    <>
      <button
        className="btn btn-sm btn-primary"
        data-testid="update-agent"
        disabled={!!reason}
        title={reason ? `Indisponible : ${reason}` : "Télécharge la version signée, remplace l'agent et le redémarre"}
        onClick={() => setOpen(true)}
      >
        <RefreshCw size={16} /> {updateLabel(machine, latest)}
      </button>
      {open && latest && <UpdateDialog machines={[machine]} latest={latest} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

/**
 * Confirmation, then progress, of the update of one or several machines (at most 3 at a time).
 * `boardId`: set on a board, where machines linked to it are used under that board.
 */
export function UpdateDialog({
  machines,
  latest,
  boardId,
  onClose,
  onChanged,
}: {
  machines: Machine[];
  latest: LatestRelease;
  boardId?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const keys = useKeys();
  const command = useUpdateCommand();
  const [progress, setProgress] = useState<Record<string, UpdateProgress>>({});
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const rows = machines.map((m) => {
    const kind = classify(m, latest);
    const todo = kind === "outdated";
    return { m, kind, todo };
  });
  const todo = rows.filter((r) => r.todo);
  const sessions = todo.reduce((n, r) => n + (r.m.openSessions ?? 0), 0);

  const list = useCallback(() => listMachines(keys), [keys]);
  const start = async () => {
    setStarted(true);
    setRunning(true);
    await runLimited(todo, 3, async ({ m }) => {
      await updateMachine(m, {
        boardId,
        expected: latest.version!,
        list,
        onProgress: (p) => alive.current && setProgress((prev) => ({ ...prev, [m.id]: p })),
      });
    });
    if (alive.current) setRunning(false);
    onChanged();
  };

  const label = (r: (typeof rows)[number]): { text: string; tone: "ok" | "warn" | "bad" | "idle" } => {
    const p = progress[r.m.id];
    if (p) return { text: statusText(p), tone: p.kind === "done" ? "ok" : p.kind === "failed" ? "bad" : "warn" };
    switch (r.kind) {
      case "uptodate":
        return { text: "à jour", tone: "ok" };
      case "outdated":
        return { text: "à mettre à jour", tone: "warn" };
      case "manual":
        return { text: "manuel requis", tone: "bad" };
      case "offline":
        return { text: "hors ligne : à mettre à jour plus tard", tone: "idle" };
      default:
        return { text: "version inconnue", tone: "idle" };
    }
  };

  const single = machines.length === 1;
  const manualNeeded = rows.some((r) => r.kind === "manual");
  return (
    <Modal onClose={() => !running && onClose()} width={640}>
      <div data-testid="update-dialog">
        <h2 className="display">{single ? `Mettre à jour l'agent de « ${machines[0].name} »` : "Mettre à jour les agents"}</h2>
        <p style={{ color: "var(--text-2)" }}>
          Chaque agent télécharge la version <b>{latest.version}</b> publiée sur cette instance, vérifie sa signature avec la clé intégrée à son programme, puis redémarre.
          Le serveur ne fait que distribuer les fichiers : il ne peut pas faire exécuter autre chose.
        </p>
        <div className="update-rows" style={{ margin: "12px 0" }}>
          {rows.map((r) => {
            const l = label(r);
            return (
              <div className="row" key={r.m.id} data-testid={`update-row-${r.m.id}`} style={{ alignItems: "flex-start" }}>
                <span className={`dot ${l.tone === "ok" ? "on" : l.tone === "bad" ? "warn" : ""}`} />
                <div className="grow">
                  <div className="title">{r.m.name}</div>
                  <div className="sub">
                    Agent {r.m.agentVersion || "?"}
                    {r.todo && ` → ${latest.version}`}
                    {r.todo && (r.m.openSessions ?? 0) > 0 && ` · ${sessionsText(r.m.openSessions ?? 0)}`}
                  </div>
                </div>
                <div className="sub" data-testid="update-status" style={{ textAlign: "right", maxWidth: 260, color: l.tone === "bad" ? "var(--danger)" : undefined }}>
                  {isBusy(progress[r.m.id]) && <Loader2 size={13} className="spin" style={{ marginRight: 4 }} />}
                  {l.text}
                </div>
              </div>
            );
          })}
        </div>
        {!started && todo.length > 0 && (
          <p className="inline-error" role="alert" data-testid="update-warning" style={{ margin: "8px 0" }}>
            {OPEN_SESSIONS_WARNING} <b>{sessionsText(sessions).replace("Aucun shell n'est ouvert sur cette machine.", "Aucun shell ouvert.")}</b>
          </p>
        )}
        {manualNeeded && (
          <>
            <p style={{ marginTop: 10 }}>Certains agents sont trop anciens pour se mettre à jour seuls.</p>
            <UpdateHowTo command={command} />
          </>
        )}
        <div className="modal-actions">
          <button className="btn" disabled={running} onClick={onClose}>
            {started ? "Fermer" : "Annuler"}
          </button>
          {!started && (
            <button className="btn btn-primary" data-testid="update-confirm" disabled={todo.length === 0} onClick={() => void start()}>
              Mettre à jour{todo.length > 1 ? ` (${todo.length})` : ""}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
