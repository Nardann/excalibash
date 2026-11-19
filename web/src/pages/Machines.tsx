import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Copy, Fingerprint, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { useKeys } from "../auth.tsx";
import { createMachine, listMachines, renameMachine, type Machine } from "../vault.ts";
import { Modal, confirmDialog, copyText, toast } from "../components/ui.tsx";

type Enrollment = Awaited<ReturnType<typeof createMachine>> & { name: string };

export function Machines() {
  const keys = useKeys();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  const load = useCallback(() => {
    listMachines(keys).then(setMachines).catch(toast.error);
  }, [keys]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const remove = async (m: Machine) => {
    const ok = await confirmDialog({
      title: "Supprimer la machine ?",
      text: `« ${m.name} » sera déconnectée et tous ses terminaux disparaîtront des tableaux. Sa clé ne sera plus jamais acceptée.`,
      confirm: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.del(`/machines/${m.id}`).catch(toast.error);
    load();
  };

  const rename = async (m: Machine) => {
    const name = prompt("Nom de la machine", m.name);
    if (!name?.trim()) return;
    await renameMachine(keys, m.id, name.trim()).catch(toast.error);
    load();
  };

  return (
    <>
      <h1 className="page-title display">Machines</h1>
      <p className="page-sub">
        Chaque machine fait tourner un agent qui ouvre des shells pour tes tableaux. Sa clé est générée dans ton navigateur : le serveur relaie le trafic des
        terminaux sans pouvoir le lire.
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3>Mes machines</h3>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            <Plus size={16} strokeWidth={2.5} /> Ajouter une machine
          </button>
        </div>
        {machines === null ? (
          <div className="row">Chargement…</div>
        ) : machines.length === 0 ? (
          <div className="row" style={{ color: "var(--text-2)" }}>
            Aucune machine pour l'instant. Ajoute-en une pour ouvrir des terminaux.
          </div>
        ) : (
          machines.map((m) => (
            <div className="row" key={m.id}>
              <span className={`dot ${m.online ? "on" : ""}`} title={m.online ? "En ligne" : "Hors ligne"} />
              <Server size={18} style={{ color: "var(--muted)" }} />
              <div className="grow">
                <div className="title">{m.name}</div>
                <div className="sub">
                  {m.online
                    ? `En ligne · ${[m.hostname, m.os && m.arch ? `${m.os}/${m.arch}` : null].filter(Boolean).join(" · ")}`
                    : m.lastSeen
                      ? `Vue ${formatDistanceToNow(m.lastSeen, { addSuffix: true, locale: fr })}`
                      : "Jamais connectée"}
                </div>
                <div className="sub mono" title="Empreinte de la clé de l'agent : elle s'affiche aussi dans ses logs au démarrage">
                  <Fingerprint size={11} /> {m.fingerprint}
                </div>
              </div>
              <button className="btn btn-sm btn-icon" title="Renommer" onClick={() => rename(m)}>
                <Pencil size={16} />
              </button>
              <button className="btn btn-sm btn-icon" title="Supprimer" style={{ color: "var(--danger)" }} onClick={() => remove(m)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))
        )}
      </div>

      {adding && (
        <AddMachine
          onClose={() => setAdding(false)}
          onCreated={(e) => {
            setAdding(false);
            setEnrollment(e);
            load();
          }}
        />
      )}
      {enrollment && <EnrollmentModal enrollment={enrollment} onClose={() => setEnrollment(null)} />}
    </>
  );
}

function AddMachine({ onClose, onCreated }: { onClose: () => void; onCreated: (e: Enrollment) => void }) {
  const keys = useKeys();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose}>
      <h2 className="display">Nouvelle machine</h2>
      <p>Donne-lui un nom (il est chiffré). On génère ensuite sa clé et la commande à lancer dessus.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onCreated({ ...(await createMachine(keys, name.trim())), name: name.trim() });
          } catch (err) {
            toast.error(err);
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Nom
          <input className="input" autoFocus required placeholder="ex. laptop, vps-prod, raspberry" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            Créer
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EnrollmentModal({ enrollment, onClose }: { enrollment: Enrollment; onClose: () => void }) {
  const base = `curl -fsSL ${enrollment.server}/install.sh | sh -s -- --token ${enrollment.token} --key ${enrollment.privateKey}`;
  const manual = `EXCALIBASH_TOKEN=${enrollment.token} EXCALIBASH_KEY=${enrollment.privateKey} ./excalibash-agent --server ${enrollment.server}`;
  return (
    <Modal onClose={onClose} width={680}>
      <h2 className="display">Connecte « {enrollment.name} »</h2>
      <p>
        Lance cette commande sur la machine (Linux ou macOS). Elle contient la <b>clé privée</b> de l'agent, générée dans ton navigateur : elle n'a jamais été
        envoyée au serveur et ne sera plus jamais affichée.
      </p>
      <Code text={base} />
      <p style={{ marginTop: 16 }}>Pour qu'il tourne en arrière-plan et redémarre tout seul (service systemd utilisateur) :</p>
      <Code text={`${base} --service`} />
      <p style={{ marginTop: 16 }}>
        Au démarrage, l'agent affiche l'empreinte de sa clé. Elle doit être : <code className="mono">{enrollment.fingerprint}</code>
      </p>
      <details style={{ marginTop: 8, fontSize: 14, color: "var(--text-2)" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Installation manuelle</summary>
        <p style={{ marginTop: 10 }}>
          Télécharge <code>{enrollment.server}/downloads/excalibash-agent-&lt;linux|darwin&gt;-&lt;amd64|arm64&gt;</code> puis :
        </p>
        <Code text={manual} />
      </details>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          C'est fait
        </button>
      </div>
    </Modal>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="codebox">
      {text}
      <button className="btn btn-ghost btn-icon btn-sm" title="Copier" onClick={() => copyText(text)}>
        <Copy size={15} />
      </button>
    </div>
  );
}
