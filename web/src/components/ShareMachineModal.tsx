// Sharing one of the user's machines: with people directly (they can open shells and sites on it
// from any of their boards), and through boards (the editors of a board where the machine has a
// shell or a site can use it there). See docs/SECURITY.md, « Partage de machines ».
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Fingerprint, LayoutDashboard, Loader2, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { api } from "../api.ts";
import { useKeys, useUser } from "../auth.tsx";
import { fingerprint, fromB64 } from "../crypto.ts";
import { useLibrary } from "../library.tsx";
import { checkContact, machineShares, setShareBoards, shareMachine, unshareMachine, type Machine, type MachineShare } from "../vault.ts";
import { Avatar, Modal, Switch, confirmDialog, toast } from "./ui.tsx";

type Found = { id: string; name: string; email?: string; publicKey: string; color: string };
type Candidate = Found & { fingerprint: string; check: "new" | "match" | "changed" };

export function ShareMachineModal({ machine, onClose, onChanged }: { machine: Machine; onClose: () => void; onChanged?: () => void }) {
  const user = useUser();
  const keys = useKeys();
  const { nodes } = useLibrary();
  const [shares, setShares] = useState<(MachineShare & { fingerprint: string })[] | null>(null);
  const [boards, setBoards] = useState<string[]>([]);
  const [viaBoards, setViaBoards] = useState(!!machine.shareBoards);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await machineShares(machine.id);
    setShares(await Promise.all(r.shares.map(async (s) => ({ ...s, fingerprint: await fingerprint(fromB64(s.publicKey)) }))));
    setBoards(r.boards);
  }, [machine.id]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  const toggleBoards = async (on: boolean) => {
    if (
      !on &&
      boards.length &&
      !(await confirmDialog({
        title: "Ne plus partager par les tableaux ?",
        text: `${boards.length > 1 ? `Les ${boards.length} tableaux liés perdent` : "Le tableau lié perd"} l'accès à « ${machine.name} » : les shells et les sites que d'autres y ont ouverts sur cette machine sont fermés.`,
        confirm: "Désactiver",
        danger: true,
      }))
    )
      return;
    setBusy("boards");
    try {
      await setShareBoards(machine.id, on);
      setViaBoards(on);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setCandidate(null);
    setResults(null);
    setOverride(false);
    try {
      const { users } = await api.get<{ users: Found[] }>(`/auth/lookup?q=${encodeURIComponent(query.trim())}`);
      setResults(users.filter((u) => u.id !== user.id));
      if (users.length && users.every((u) => u.id === user.id)) throw new Error("C'est toi !");
    } catch (err) {
      toast.error(err);
    }
  };

  const pick = async (u: Found) => {
    try {
      setCandidate({ ...u, fingerprint: await fingerprint(fromB64(u.publicKey)), check: await checkContact(user, keys, u.id, u.email, u.publicKey) });
      setResults(null);
    } catch (err) {
      toast.error(err);
    }
  };

  const share = async () => {
    if (!candidate) return;
    setBusy("share");
    try {
      await shareMachine(user, keys, machine, candidate, candidate.check === "changed" && override);
      toast(`« ${machine.name} » partagée avec ${candidate.name}`);
      setCandidate(null);
      setQuery("");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (s: MachineShare) => {
    const ok = await confirmDialog({
      title: `Retirer ${s.name} ?`,
      text: `${s.name} ne pourra plus ouvrir de shell ni de site sur « ${machine.name} », et ceux qu'il ou elle y a ouverts sont fermés. Sa copie de la clé de la machine n'est pas effaçable à distance : pour une coupure complète, supprime la machine puis appaire-la de nouveau.`,
      confirm: "Retirer",
      danger: true,
    });
    if (!ok) return;
    setBusy(s.userId);
    try {
      await unshareMachine(machine.id, s.userId);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const boardName = (id: string) => nodes.get(id)?.name ?? "Tableau";

  return (
    <Modal onClose={onClose} width={600}>
      <h2 className="display">Partager « {machine.name} »</h2>
      <p>
        Les personnes qui ont accès à la machine peuvent y ouvrir des shells, des sessions Telnet / SSH et des sites, <b>avec les droits du compte de l'agent</b>.
        Sa clé est chiffrée pour elles : le serveur ne peut pas la lire.
      </p>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row">
          <LayoutDashboard size={18} style={{ color: "var(--muted)" }} />
          <div className="grow">
            <div className="title">Partager via les tableaux</div>
            <div className="sub">
              Quand tu ouvres un shell ou un site sur cette machine dans un tableau partagé, ses éditeurs peuvent l'utiliser depuis ce tableau.
            </div>
          </div>
          {busy === "boards" ? <Loader2 size={16} className="spin" /> : <Switch on={viaBoards} onChange={toggleBoards} label="Partager via les tableaux" />}
        </div>
        {viaBoards &&
          boards.map((id) => (
            <div className="row" key={id} style={{ paddingLeft: 42 }}>
              <div className="grow sub">Liée à « {boardName(id)} »</div>
            </div>
          ))}
      </div>

      <form onSubmit={lookup} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="input"
          required
          minLength={2}
          placeholder="Nom ou email"
          aria-label="Nom ou email"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResults(null);
          }}
        />
        <button className="btn">Chercher</button>
      </form>

      {results && !candidate && (
        <div className="panel" style={{ marginBottom: 12 }}>
          {results.length === 0 ? (
            <div className="row sub">
              Aucun compte trouvé. La personne n'est peut-être pas trouvable par son nom : demande-lui son email (ou qu'elle active « Trouvable par mon email »).
            </div>
          ) : (
            results.map((u) => (
              <button type="button" className="row" key={u.id} style={{ width: "100%", textAlign: "left" }} onClick={() => pick(u)}>
                <Avatar name={u.name} color={u.color} />
                <div className="grow">
                  <div className="title">{u.name}</div>
                  {u.email && <div className="sub">{u.email}</div>}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {candidate && (
        <div className={`verify ${candidate.check === "changed" ? "danger" : ""}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={candidate.name} color="var(--brand)" />
            <div style={{ flex: 1 }}>
              <b>{candidate.name}</b>
              {candidate.email && <div className="sub">{candidate.email}</div>}
            </div>
          </div>
          <div className="fp">
            <Fingerprint size={14} /> {candidate.fingerprint}
          </div>
          {candidate.check === "changed" ? (
            <p className="warn">
              <AlertTriangle size={14} /> La clé de cette personne a <b>changé</b> depuis ton dernier partage. Vérifie l'empreinte avec elle avant de continuer.
            </p>
          ) : candidate.check === "match" ? (
            <p className="ok">
              <ShieldCheck size={14} /> Même clé que lors de vos précédents partages.
            </p>
          ) : (
            <p className="sub" style={{ margin: "6px 0 0" }}>
              Premier partage avec cette personne : pour une sécurité maximale, comparez cette empreinte avec celle affichée dans son onglet « Mon compte ».
            </p>
          )}
          {candidate.check === "changed" && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, marginTop: 8 }}>
              <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> J'ai vérifié l'empreinte avec cette personne
            </label>
          )}
          <div className="modal-actions" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => setCandidate(null)}>
              Annuler
            </button>
            <button className="btn btn-primary" disabled={busy === "share" || (candidate.check === "changed" && !override)} onClick={share}>
              {busy === "share" ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Partager la machine
            </button>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 8 }}>
        {shares === null ? (
          <div className="row">Chargement…</div>
        ) : shares.length === 0 ? (
          <div className="row sub">Partagée avec personne directement.</div>
        ) : (
          shares.map((s) => (
            <div className="row" key={s.userId}>
              <Avatar name={s.name} color={s.color} />
              <div className="grow">
                <div className="title">{s.name}</div>
                <div className="sub mono" title="Empreinte de sa clé publique">
                  {s.email} · {s.fingerprint.slice(0, 19)}…
                </div>
              </div>
              <button className="btn btn-sm btn-icon" title="Retirer l'accès" style={{ color: "var(--danger)" }} disabled={!!busy} onClick={() => revoke(s)}>
                {busy === s.userId ? <Loader2 size={16} className="spin" /> : <UserMinus size={16} />}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
