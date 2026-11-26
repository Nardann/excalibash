import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Wrench, X } from "lucide-react";
import type { MachineCheck } from "./schemaRun.ts";
import type { EndResult, Finding } from "./schemaCheck.ts";

export type SchemaReport = { running: boolean; machines: MachineCheck[]; remote: string[] };

/** Short description of a cable end for the list: what is drawn there. */
const endName = (label: (cableId: string, end: EndResult["end"]) => string, r: EndResult) => label(r.cableId, r.end);

/** Side panel: what differs between the diagram and the machines, with quick fixes. Ephemeral. */
export function SchemaPanel({
  report,
  editor,
  labelOf,
  onFix,
  onRecheck,
  onClose,
}: {
  report: SchemaReport;
  editor: boolean;
  /** Text naming a cable end ("eth1 10.0.0.1/24"). */
  labelOf: (cableId: string, end: EndResult["end"]) => string;
  onFix: (r: EndResult, f: Finding) => void;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const problems = report.machines.reduce((n, m) => n + (m.ends?.reduce((k, e) => k + e.findings.length, 0) ?? 0), 0);
  return (
    <aside className="dock schema-panel" aria-label="Vérification du schéma">
      <div className="dock-head">
        <CheckCircle2 size={15} />
        Vérifier le schéma
        <button title="Revérifier" disabled={report.running} onClick={onRecheck}>
          <RefreshCw size={15} className={report.running ? "spin" : undefined} />
        </button>
        <button title="Fermer" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="dock-body schema-body">
        {report.running && (
          <div className="history-empty">
            <Loader2 size={16} className="spin" />
          </div>
        )}
        {!report.running && report.machines.length === 0 && <div className="history-empty">Aucune machine avec l'agent à vérifier : les câbles avec une interface ou une IP doivent aboutir sur une machine ouverte dans ce tableau.</div>}
        {!report.running && report.machines.length > 0 && (
          <div className="schema-summary">{problems ? `${problems} écart${problems > 1 ? "s" : ""} entre le schéma et les machines` : "Le schéma correspond aux machines."}</div>
        )}
        {report.machines.map((m) => (
          <section key={m.machineId} className="schema-machine">
            <h4>{m.name}</h4>
            {m.error && (
              <div className="schema-item err">
                <AlertTriangle size={13} /> {m.error}
              </div>
            )}
            {m.ends?.map((r) =>
              r.findings.length ? (
                r.findings.map((f, i) => (
                  <div key={`${r.key}:${i}`} className="schema-item">
                    <AlertTriangle size={13} />
                    <span>
                      <b>{endName(labelOf, r)}</b> : {f.message}
                    </span>
                    {editor && f.fix && (
                      <button className="btn btn-sm" disabled={report.running} title="Modifie le schéma (annulable avec Ctrl+Z)" onClick={() => onFix(r, f)}>
                        <Wrench size={12} /> Corriger le schéma : {f.fix.label}
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <div key={r.key} className="schema-item ok">
                  <CheckCircle2 size={13} /> <b>{endName(labelOf, r)}</b> : ok
                </div>
              ),
            )}
            {!!m.extra?.length && (
              <details className="schema-extra">
                <summary>
                  Sur la machine, pas sur le schéma ({m.extra.length})
                </summary>
                {m.extra.map((x) => (
                  <div key={`${x.iface}:${x.addr}`}>
                    {x.iface} {x.addr}
                  </div>
                ))}
              </details>
            )}
          </section>
        ))}
        {report.remote.length > 0 && (
          <div className="schema-note">
            {report.remote.join(", ")} : Telnet / SSH, ignoré. Vérification possible seulement sur les machines avec l'agent.
          </div>
        )}
      </div>
    </aside>
  );
}
