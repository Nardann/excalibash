import { useCallback, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Copy, Fingerprint, RefreshCw, LogOut, Loader2, Pencil, Plus, Server, Trash2, Users } from "lucide-react";
import { api, serverConfig } from "../api.ts";
import { useKeys } from "../auth.tsx";
import {
  approvePairing,
  createMachine,
  listMachines,
  machineShares,
  renameMachine,
  shareMachine,
  unshareMachine,
  type Machine,
  type MachineShare,
} from "../vault.ts";
import { CONFIRM_RE, fingerprint, fromB64, normalizeConfirm } from "../crypto.ts";
import { Modal, Switch, confirmDialog, copyText, toast } from "../components/ui.tsx";
import { ShareMachineModal } from "../components/ShareMachineModal.tsx";
import { UpdateHowTo, useUpdateCommand } from "../components/AgentOutdated.tsx";
import { FEATURES, KNOWN_CAPS, missingCaps, needsUpdate } from "../agentCaps.ts";
import { useUser } from "../auth.tsx";

type Enrollment = Awaited<ReturnType<typeof createMachine>> & { name: string };

export function Machines() {
  const keys = useKeys();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<"code" | "command">("code");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  /** A machine just removed: the command that removes its agent from the machine itself. */
  const [removed, setRemoved] = useState<{ name: string; command: string } | null>(null);
  const [sharing, setSharing] = useState<Machine | null>(null);
  const [updating, setUpdating] = useState<Machine | null>(null);
  const user = useUser();
  const mine = machines?.filter((m) => m.access === "owner") ?? null;
  const sharedWithMe = machines?.filter((m) => m.access === "shared") ?? [];

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
      text: `« ${m.name} » sera déconnectée et tous ses terminaux disparaîtront des tableaux. Sa clé ne sera plus jamais acceptée. Une commande te sera ensuite donnée pour retirer l'agent de la machine elle-même.`,
      confirm: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    const r = await api.del<{ ok: boolean; uninstall?: string }>(`/machines/${m.id}`).catch((e) => (toast.error(e), null));
    if (r?.uninstall) setRemoved({ name: m.name, command: r.uninstall });
    load();
  };

  /** Opens the share dialog of a machine just added (once the list knows it). */
  const shareNew = async (id: string) => {
    const m = (await listMachines(keys).catch(() => [])).find((x) => x.id === id);
    if (m) setSharing(m);
    else toast.error("Machine introuvable");
  };

  const leave = async (m: Machine) => {
    const ok = await confirmDialog({
      title: `Ne plus utiliser « ${m.name} » ?`,
      text: `Tu n'auras plus accès à cette machine de ${m.ownerName ?? "quelqu'un d'autre"}, et les shells et sites que tu y as ouverts seront fermés.`,
      confirm: "Retirer",
      danger: true,
    });
    if (!ok) return;
    await unshareMachine(m.id, user.id).catch(toast.error);
    load();
  };

  const rename = async (m: Machine) => {
    const name = prompt("Nom de la machine", m.name);
    if (!name?.trim()) return;
    await renameMachine(keys, m.id, name.trim()).catch(toast.error);
    // The people it is shared with get the new name too (board links follow on the owner's next visit).
    const { shares } = await machineShares(m.id).catch(() => ({ shares: [] as MachineShare[] }));
    const stale: string[] = [];
    for (const sh of shares) {
      await shareMachine(user, keys, { ...m, name: name.trim() }, { id: sh.userId, email: sh.email, publicKey: sh.publicKey }).catch(() => stale.push(sh.name));
    }
    if (stale.length) toast.error(`Nouveau nom non transmis à ${stale.join(", ")} (clé changée ou erreur) : partage à vérifier.`);
    load();
  };

  return (
    <>
      {removed && (
        <Modal onClose={() => setRemoved(null)} width={600}>
          <h2 className="display">Retirer l'agent de « {removed.name} »</h2>
          <p>
            La machine est supprimée d'Excalibash : son agent est déjà refusé par le serveur. Pour l'effacer aussi de la machine (service de démarrage, programme,
            configuration et clés), lance cette commande dessus :
          </p>
          <Code text={removed.command} />
          <p className="sub" style={{ marginTop: 10 }}>
            Si l'agent a été installé en root (service système), lance-la avec <code>sudo sh</code> à la place de <code>sh</code>.
          </p>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setRemoved(null)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
      <h1 className="page-title display">Machines</h1>
      <p className="page-sub">
        Chaque machine fait tourner un agent qui ouvre des shells pour tes tableaux. Pas de copier-coller sur la machine ? Ajoute-la avec un code court à taper.
        Dans tous les cas, le serveur relaie le trafic des terminaux sans pouvoir le lire.
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3>Mes machines</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm"
              title="Une longue commande avec la clé, si tu peux copier-coller"
              onClick={() => {
                setMethod("command");
                setAdding(true);
              }}
            >
              Par copier-coller
            </button>
            <button
              className="btn btn-primary btn-sm"
              title="Un code court à taper sur la machine"
              onClick={() => {
                setMethod("code");
                setAdding(true);
              }}
            >
              <Plus size={16} strokeWidth={2.5} /> Ajouter avec un code
            </button>
          </div>
        </div>
        {mine === null ? (
          <div className="row">Chargement…</div>
        ) : mine.length === 0 ? (
          <div className="row" style={{ color: "var(--text-2)" }}>
            Aucune machine pour l'instant. Ajoute-en une pour ouvrir des terminaux.
          </div>
        ) : (
          mine.map((m) => (
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
                {m.lastSeen && <AgentVersion m={m} />}
              </div>
              {m.lastSeen && needsUpdate(m.agentCaps) && (
                <button className="btn btn-sm" title="Montre la commande qui met l'agent à jour sur la machine" onClick={() => setUpdating(m)}>
                  <RefreshCw size={16} /> Mettre à jour l'agent
                </button>
              )}
              <button className="btn btn-sm" title="Partager la machine avec d'autres personnes, ou via les tableaux" onClick={() => setSharing(m)}>
                <Users size={16} /> Partager
              </button>
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

      {sharedWithMe.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <h3>Partagées avec moi</h3>
          </div>
          {sharedWithMe.map((m) => (
            <div className="row" key={m.id}>
              <span className={`dot ${m.online ? "on" : ""}`} title={m.online ? "En ligne" : "Hors ligne"} />
              <Server size={18} style={{ color: "var(--muted)" }} />
              <div className="grow">
                <div className="title">{m.name}</div>
                <div className="sub">
                  De {m.ownerName} · {m.online ? `en ligne${m.hostname ? ` · ${m.hostname}` : ""}` : "hors ligne"}
                </div>
                <div className="sub mono" title="Empreinte de la clé de l'agent">
                  <Fingerprint size={11} /> {m.fingerprint}
                </div>
                {m.lastSeen && <AgentVersion m={m} />}
              </div>
              <button className="btn btn-sm btn-icon" title="Ne plus utiliser cette machine" style={{ color: "var(--danger)" }} onClick={() => leave(m)}>
                <LogOut size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      {updating && <UpdateAgentModal machine={updating} onClose={() => setUpdating(null)} />}
      {adding && method === "code" && (
        <PairingModal
          onClose={() => {
            setAdding(false);
            load();
          }}
          onShare={(id) => {
            setAdding(false);
            load();
            void shareNew(id);
          }}
        />
      )}
      {adding && method === "command" && (
        <AddMachine
          onClose={() => setAdding(false)}
          onCreated={(e) => {
            setAdding(false);
            setEnrollment(e);
            load();
          }}
        />
      )}
      {enrollment && (
        <EnrollmentModal
          enrollment={enrollment}
          onClose={() => setEnrollment(null)}
          onShare={() => {
            setEnrollment(null);
            void shareNew(enrollment.id);
          }}
        />
      )}
      {sharing && <ShareMachineModal machine={sharing} onClose={() => setSharing(null)} onChanged={load} />}
    </>
  );
}

/** Pairing with a short code typed on the machine: for consoles without copy-paste. */
function PairingModal({ onClose, onShare }: { onClose: () => void; onShare: (machineId: string) => void }) {
  const keys = useKeys();
  const [pairing, setPairing] = useState<{ code: string; command: string; expiresAt: number } | null>(null);
  const [claim, setClaim] = useState<{ agentPub: string; agentName: string; fingerprint: string } | null>(null);
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [viaBoards, setViaBoards] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .post<{ code: string; command: string; expiresAt: number }>("/machines/pairings")
      .then(setPairing)
      .catch((e) => {
        toast.error(e);
        onClose();
      });
  }, []);

  // Wait for the agent to show up with its key.
  useEffect(() => {
    if (!pairing || claim || done) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const r = await api.get<{ status: string; agentPub: string | null; agentName: string | null }>(`/machines/pairings/${pairing.code}`);
        if (r.status === "claimed" && r.agentPub) {
          setClaim({ agentPub: r.agentPub, agentName: r.agentName ?? "", fingerprint: await fingerprint(fromB64(r.agentPub)) });
          setName(r.agentName || "");
        }
      } catch {
        setPairing(null);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pairing, claim, done]);

  const cancel = async () => {
    if (pairing && !done) await api.del(`/machines/pairings/${pairing.code}`).catch(() => {});
    onClose();
  };

  const approve = async () => {
    if (!pairing || !claim) return;
    setBusy(true);
    try {
      setDone(await approvePairing(keys, pairing.code, claim.agentPub, confirm, name.trim() || claim.agentName || "machine", viaBoards));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <Modal onClose={cancel} width={620}>
      {done ? (
        <>
          <h2 className="display">Machine connectée</h2>
          <p>
            L'agent tourne maintenant sur « {name || claim?.agentName} » et redémarre tout seul. Sa clé privée n'a jamais quitté la machine.
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => onShare(done)}>
              <Users size={16} /> Partager la machine
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        </>
      ) : claim ? (
        <>
          <h2 className="display">Vérifie l'empreinte</h2>
          <p>
            La machine <b>{claim.agentName || "inconnue"}</b> s'est présentée. Compare cette empreinte avec celle affichée sur son écran. Si elle est différente,
            quelqu'un d'autre a utilisé le code : refuse. Recopie ensuite le code de confirmation affiché sous l'empreinte : il ne passe jamais par le serveur.
          </p>
          <div className="pair-fp mono">{claim.fingerprint}</div>
          <label className="field" style={{ marginTop: 16 }}>
            Code de confirmation affiché sur la machine
            <input
              className="input mono"
              value={confirm}
              placeholder="XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <label className="field" style={{ marginTop: 16 }}>
            Nom dans Excalibash (chiffré)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <ShareBoardsField on={viaBoards} onChange={setViaBoards} />
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              Ce n'est pas la même
            </button>
            <button className="btn btn-primary" disabled={busy || !CONFIRM_RE.test(normalizeConfirm(confirm))} onClick={approve}>
              C'est la même
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 className="display">Code à taper sur la machine</h2>
          <p>Sur la machine (console Proxmox, VM sans presse-papiers…), tape cette commande :</p>
          {pairing ? (
            <>
              <div className="codebox pair-cmd">{pairing.command}</div>
              {/^curl -fsSL \S+ \| sh$/.test(pairing.command) && (
                <p className="sub" style={{ margin: "8px 0 0" }}>
                  Pas de curl ? <code>{pairing.command.replace(/^curl -fsSL (\S+) \| sh$/, "wget -qO- $1 | sh")}</code>
                </p>
              )}
              <p style={{ marginTop: 14 }}>
                Code : <b className="pair-code mono">{pairing.code}</b> · valable encore {Math.floor(left / 60)} min {String(left % 60).padStart(2, "0")} s, une seule
                fois.
              </p>
              <p className="sub" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Loader2 size={14} className="spin" /> En attente de la machine…
              </p>
            </>
          ) : (
            <p className="sub">Code expiré. Ferme et recommence.</p>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              Annuler
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function AddMachine({ onClose, onCreated }: { onClose: () => void; onCreated: (e: Enrollment) => void }) {
  const keys = useKeys();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [viaBoards, setViaBoards] = useState(true);
  return (
    <Modal onClose={onClose}>
      <h2 className="display">Nouvelle machine</h2>
      <p>Donne-lui un nom (il est chiffré). On génère ensuite sa clé et la commande à lancer dessus.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onCreated({ ...(await createMachine(keys, name.trim(), viaBoards)), name: name.trim() });
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
        <ShareBoardsField on={viaBoards} onChange={setViaBoards} />
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

function EnrollmentModal({ enrollment, onClose, onShare }: { enrollment: Enrollment; onClose: () => void; onShare: () => void }) {
  const [pin, setPin] = useState<string | null>(null);
  useEffect(() => {
    serverConfig()
      .then((c) => setPin(c.tls?.pin ?? null))
      .catch(() => {});
  }, []);
  // Self-signed instance: curl checks the pinned key instead of a CA (-k skips only the CA check).
  const curl = pin ? `curl -k --pinnedpubkey '${pin}' -fsSL` : "curl -fsSL";
  // Leading space: shells with ignorespace (bash default on most distros, zsh HIST_IGNORE_SPACE) keep it out of history.
  const base = ` ${curl} ${enrollment.server}/install.sh | sh -s -- --token ${enrollment.token} --key ${enrollment.privateKey}`;
  const manual = ` EXCALIBASH_TOKEN=${enrollment.token} EXCALIBASH_KEY=${enrollment.privateKey} ./excalibash-agent --server ${enrollment.server}${pin ? ` --pin '${pin}'` : ""}`;
  return (
    <Modal onClose={onClose} width={680}>
      <h2 className="display">Connecte « {enrollment.name} »</h2>
      <p>
        Lance cette commande sur la machine (Linux ou macOS). Elle contient la <b>clé privée</b> de l'agent, générée dans ton navigateur : elle n'a jamais été
        envoyée au serveur et ne sera plus jamais affichée. L'espace au début évite qu'elle reste dans l'historique du shell.
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
        <button className="btn" onClick={onShare}>
          <Users size={16} /> Partager la machine
        </button>
        <button className="btn btn-primary" onClick={onClose}>
          C'est fait
        </button>
      </div>
    </Modal>
  );
}

/** The "share through boards" choice of a new machine (on by default). */
function ShareBoardsField({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field" style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
      <div style={{ flex: 1 }}>
        Partager via les tableaux
        <div className="sub" style={{ fontWeight: 400 }}>
          Quand tu ouvriras un shell ou un site sur cette machine dans un tableau partagé, ses éditeurs pourront l'utiliser depuis ce tableau. Modifiable ensuite avec « Partager ».
        </div>
      </div>
      <Switch on={on} onChange={onChange} label="Partager via les tableaux" />
    </div>
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

/** The agent's version and, when it lacks something the app can use, a badge. */
function AgentVersion({ m }: { m: Machine }) {
  const old = needsUpdate(m.agentCaps);
  return (
    <div className="sub" data-testid="agent-version">
      Agent {m.agentVersion || "version inconnue"}
      {old && (
        <span className="badge-update" style={{ marginLeft: 8, color: "var(--danger)", fontWeight: 600 }} title={`Manque : ${missingCaps(m.agentCaps).join(", ")}`}>
          à mettre à jour
        </span>
      )}
    </div>
  );
}

function UpdateAgentModal({ machine, onClose }: { machine: Machine; onClose: () => void }) {
  const command = useUpdateCommand();
  const lacking = (Object.keys(FEATURES) as (keyof typeof FEATURES)[]).filter((f) => !FEATURES[f].needs.every((c) => machine.agentCaps?.includes(c)));
  return (
    <Modal onClose={onClose} width={620}>
      <h2 className="display">Mettre à jour l'agent de « {machine.name} »</h2>
      <p>
        {machine.agentCaps?.length
          ? `Cet agent (${machine.agentVersion || "version inconnue"}) ne connaît pas encore : ${lacking.map((f) => FEATURES[f].label).join(", ")}.`
          : "Cet agent date d'avant l'annonce de ses fonctions : la capture réseau, les fichiers et les notebooks ne marcheront pas tant qu'il n'est pas mis à jour."}
      </p>
      <UpdateHowTo command={command} />
      <p style={{ color: "var(--text-2)", fontSize: 13 }}>
        La machine garde son nom, sa clé et ses tableaux : seul le programme est remplacé, puis le service redémarre (les shells en cours sont interrompus). Fonctions connues de cette version : {KNOWN_CAPS.join(", ")}.
      </p>
      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
