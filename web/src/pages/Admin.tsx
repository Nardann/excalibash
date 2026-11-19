import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Link2, Lock, Shield, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import { Avatar, Modal, Switch, confirmDialog, copyText, toast } from "../components/ui.tsx";

type AdminUser = { id: string; email: string; name: string; isAdmin: number; color: string; createdAt: number; items: number; machines: number };
type Invite = { id: string; note: string | null; expiresAt: number; createdAt: number; usedBy: string | null };
type Data = { users: AdminUser[]; invites: Invite[]; registrationOpen: boolean };

export function Admin() {
  const me = useUser();
  const [data, setData] = useState<Data | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<Data>("/admin").then(setData).catch(toast.error);
  }, []);
  useEffect(load, [load]);

  if (!me.isAdmin) return <Navigate to="/" replace />;

  const setRegistration = async (open: boolean) => {
    await api.patch("/admin/settings", { registrationOpen: open }).catch(toast.error);
    load();
  };

  const invite = async () => {
    const note = prompt("Pour qui ? (note facultative, visible des admins)") ?? "";
    try {
      const r = await api.post<{ url: string }>("/admin/invites", { note, days: 7 });
      setInviteUrl(r.url);
      load();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleAdmin = async (u: AdminUser) => {
    await api.patch(`/admin/users/${u.id}`, { isAdmin: !u.isAdmin }).catch(toast.error);
    load();
  };

  const remove = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: `Supprimer ${u.name} ?`,
      text: `Son compte, ses ${u.items} élément(s) et ses ${u.machines} machine(s) seront supprimés définitivement. Tu ne peux pas lire ces données : seulement les effacer.`,
      confirm: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.del(`/admin/users/${u.id}`).catch(toast.error);
    load();
  };

  return (
    <>
      <h1 className="page-title display">Administration</h1>
      <p className="page-sub">
        <Lock size={14} /> Les admins gèrent les comptes, jamais le contenu : impossible de lire, réinitialiser ou se faire passer pour quelqu'un.
      </p>

      <div className="panel">
        <div className="panel-head">
          <h3>Inscriptions</h3>
          <button className="btn btn-primary btn-sm" onClick={invite}>
            <Link2 size={16} /> Créer une invitation
          </button>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title">Inscriptions ouvertes à tous</div>
            <div className="sub">Sinon, il faut un lien d'invitation (usage unique, 7 jours).</div>
          </div>
          {data && <Switch on={data.registrationOpen} onChange={setRegistration} label="Inscriptions ouvertes" />}
        </div>
        {data?.invites.map((i) => (
          <div className="row" key={i.id}>
            <Link2 size={16} style={{ color: "var(--muted)" }} />
            <div className="grow">
              <div className="title">{i.note || "Invitation"}</div>
              <div className="sub">
                {i.usedBy
                  ? `Utilisée par ${i.usedBy}`
                  : i.expiresAt < Date.now()
                    ? "Expirée"
                    : `Expire ${formatDistanceToNow(i.expiresAt, { addSuffix: true, locale: fr })}`}
              </div>
            </div>
            <button
              className="btn btn-sm btn-icon"
              title="Supprimer"
              onClick={async () => {
                await api.del(`/admin/invites/${i.id}`).catch(toast.error);
                load();
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Utilisateurs</h3>
        </div>
        {data?.users.map((u) => (
          <div className="row" key={u.id}>
            <Avatar name={u.name} color={u.color} />
            <div className="grow">
              <div className="title">
                {u.name} {!!u.isAdmin && <span className="badge">admin</span>}
              </div>
              <div className="sub">
                {u.email} · {u.items} élément(s) · {u.machines} machine(s)
              </div>
            </div>
            {u.id !== me.id && (
              <>
                <button className="btn btn-sm btn-icon" title={u.isAdmin ? "Retirer admin" : "Rendre admin"} onClick={() => toggleAdmin(u)}>
                  <Shield size={16} />
                </button>
                <button className="btn btn-sm btn-icon" style={{ color: "var(--danger)" }} title="Supprimer le compte" onClick={() => remove(u)}>
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {inviteUrl && (
        <Modal onClose={() => setInviteUrl(null)}>
          <h2 className="display">Lien d'invitation</h2>
          <p>Envoie-le à la personne : elle choisira son mot de passe et ses clés seront générées chez elle. Usage unique, valable 7 jours.</p>
          <div className="codebox">
            {inviteUrl}
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => copyText(inviteUrl)}>
              <Link2 size={15} />
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setInviteUrl(null)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
