import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Fingerprint, Loader2, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { api, type Role } from "../api.ts";
import { fingerprint, fromB64 } from "../crypto.ts";
import { checkContact, revokeAccess, shareItem, useLibrary, useLibraryCtx, type Member, type Node } from "../library.tsx";
import { Avatar, Modal, confirmDialog, copyText, toast } from "./ui.tsx";

const ROLE_LABEL: Record<Role, string> = { owner: "Propriétaire", editor: "Peut modifier", viewer: "Lecture seule" };

type Candidate = { id: string; name: string; email: string; publicKey: string; fingerprint: string; check: "new" | "match" | "changed" };

export function ShareModal({ node, onClose }: { node: Node; onClose: () => void }) {
  const ctx = useLibraryCtx();
  const { refresh } = useLibrary();
  const owner = node.ownerId === ctx.user.id;
  const [members, setMembers] = useState<(Member & { fingerprint: string })[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ grants: Member[] }>(`/items/${node.id}/grants`);
    setMembers(await Promise.all(r.grants.map(async (g) => ({ ...g, fingerprint: await fingerprint(fromB64(g.publicKey)) }))));
  }, [node.id]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setCandidate(null);
    setOverride(false);
    try {
      const { user } = await api.get<{ user: Omit<Candidate, "fingerprint" | "check"> }>(`/auth/lookup?email=${encodeURIComponent(email.trim())}`);
      if (user.id === ctx.user.id) throw new Error("C'est toi !");
      setCandidate({
        ...user,
        fingerprint: await fingerprint(fromB64(user.publicKey)),
        check: await checkContact(ctx.user, ctx.keys, user.id, user.email, user.publicKey),
      });
    } catch (err) {
      toast.error(err);
    }
  };

  const share = async () => {
    if (!candidate) return;
    setBusy("share");
    try {
      await shareItem(ctx, node.id, candidate, role, candidate.check === "changed" && override);
      toast(`Partagé avec ${candidate.name}`);
      setCandidate(null);
      setEmail("");
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (m: Member, next: Role) => {
    setBusy(m.userId);
    try {
      await shareItem(ctx, node.id, { id: m.userId, email: m.email, publicKey: m.publicKey }, next);
      await load();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (m: Member) => {
    const ok = await confirmDialog({
      title: `Retirer ${m.name} ?`,
      text: `Son accès est coupé et toutes les clés de « ${node.name} » (et de son contenu) sont renouvelées puis re-chiffrées dans ton navigateur. Les terminaux qui ne tournent pas sur tes machines seront fermés.`,
      confirm: "Retirer et renouveler les clés",
      danger: true,
    });
    if (!ok) return;
    setBusy(m.userId);
    try {
      await revokeAccess(ctx, node.id, m.userId, (msg) => setBusy(`${m.userId}:${msg}`));
      toast(`${m.name} n'a plus accès — clés renouvelées`);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const progress = busy?.includes(":") ? busy.split(":").slice(1).join(":") : null;

  return (
    <Modal onClose={onClose} width={600}>
      <h2 className="display">Partager « {node.name} »</h2>
      <p>
        {node.kind === "folder" ? "Tout ce que contient ce dossier, sous-dossiers compris, est partagé avec les mêmes droits. " : ""}
        La clé est chiffrée pour la clé publique de chaque membre : le serveur ne peut pas la lire. Les éditeurs peuvent aussi
        <b> taper dans les terminaux</b>.
      </p>

      {owner && (
        <form onSubmit={lookup} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input className="input" type="email" required placeholder="email@exemple.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="editor">Peut modifier</option>
            <option value="viewer">Lecture seule</option>
          </select>
          <button className="btn">Chercher</button>
        </form>
      )}

      {candidate && (
        <div className={`verify ${candidate.check === "changed" ? "danger" : ""}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={candidate.name} color="var(--brand)" />
            <div style={{ flex: 1 }}>
              <b>{candidate.name}</b>
              <div className="sub">{candidate.email}</div>
            </div>
          </div>
          <div className="fp">
            <Fingerprint size={14} /> {candidate.fingerprint}
          </div>
          {candidate.check === "changed" ? (
            <p className="warn">
              <AlertTriangle size={14} /> La clé de cette personne a <b>changé</b> depuis ton dernier partage. Ça peut être une réinitialisation de son compte… ou
              une tentative d'interception. Vérifie l'empreinte avec elle (en vrai, par téléphone…) avant de continuer.
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
              {busy === "share" ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Partager ({ROLE_LABEL[role].toLowerCase()})
            </button>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 8 }}>
        {members === null ? (
          <div className="row">Chargement…</div>
        ) : (
          members.map((m) => (
            <div className="row" key={m.userId}>
              <Avatar name={m.name} color={m.color} />
              <div className="grow">
                <div className="title">
                  {m.name} {m.userId === ctx.user.id && <span className="badge">toi</span>}
                </div>
                <div className="sub mono" title="Empreinte de sa clé publique">
                  {m.email} · {m.fingerprint.slice(0, 19)}…
                </div>
                {busy?.startsWith(`${m.userId}:`) && (
                  <div className="sub" style={{ color: "var(--brand)" }}>
                    <Loader2 size={11} className="spin" /> {progress}
                  </div>
                )}
              </div>
              {owner && m.role !== "owner" ? (
                <>
                  <select className="select" style={{ height: 32 }} value={m.role} disabled={!!busy} onChange={(e) => changeRole(m, e.target.value as Role)}>
                    <option value="editor">Peut modifier</option>
                    <option value="viewer">Lecture seule</option>
                  </select>
                  <button className="btn btn-sm btn-icon" title="Retirer l'accès" style={{ color: "var(--danger)" }} disabled={!!busy} onClick={() => revoke(m)}>
                    <UserMinus size={16} />
                  </button>
                </>
              ) : (
                <span className="badge">{ROLE_LABEL[m.role]}</span>
              )}
            </div>
          ))
        )}
      </div>
      {!node.direct && node.role !== "owner" && <p style={{ marginTop: 12 }}>Tu as accès via un dossier parent partagé.</p>}

      <div className="modal-actions">
        <button className="btn" onClick={() => copyText(`${location.origin}/${node.kind === "board" ? "board" : "folder"}/${node.id}`)}>
          <Copy size={16} /> Copier le lien
        </button>
        <button className="btn btn-primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
