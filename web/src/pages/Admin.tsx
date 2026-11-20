import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Ban, Link2, Lock, RotateCcw, Search, Shield, Trash2 } from "lucide-react";
import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import "./admin.css";
import { Avatar, Modal, Switch, confirmDialog, copyText, toast } from "../components/ui.tsx";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: number;
  color: string;
  createdAt: number;
  emailVerified: boolean;
  suspended: boolean;
  lastSeenAt: number | null;
  boards: number;
  folders: number;
  items: number;
  machines: number;
  machinesOnline: number;
  terminals: number;
  storageBytes: number;
  storage: { boards: number; images: number; previews: number; library: number; other: number };
};
type Stats = {
  accounts: number;
  verified: number;
  pending: number;
  suspended: number;
  storageBytes: number;
  dbFileBytes: number;
  machinesOnline: number;
  machines: number;
  openBoards: number;
  signupsLast7Days: number;
};
type Invite = { id: string; note: string | null; expiresAt: number; createdAt: number; usedBy: string | null };
type Data = { users: AdminUser[]; invites: Invite[]; stats: Stats; registrationOpen: boolean };
type Sort = "storage" | "seen" | "created";

function bytes(n: number): string {
  if (n < 1000) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

const ago = (t: number) => formatDistanceToNow(t, { addSuffix: true, locale: fr });

export function Admin() {
  const me = useUser();
  const [data, setData] = useState<Data | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("created");

  const load = useCallback(() => {
    api.get<Data>("/admin").then(setData).catch(toast.error);
  }, []);
  useEffect(load, [load]);

  const users = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.users ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    const key = (u: AdminUser) => (sort === "storage" ? u.storageBytes : sort === "seen" ? (u.lastSeenAt ?? 0) : u.createdAt);
    return list.sort((a, b) => key(b) - key(a));
  }, [data, query, sort]);

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

  const toggleSuspend = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: u.suspended ? `Réactiver ${u.name} ?` : `Suspendre ${u.name} ?`,
      text: u.suspended
        ? "La personne pourra de nouveau se connecter."
        : "La personne est déconnectée tout de suite et ne peut plus se connecter. Ses données restent intactes.",
      confirm: u.suspended ? "Réactiver" : "Suspendre",
      danger: !u.suspended,
    });
    if (!ok) return;
    await api.patch(`/admin/users/${u.id}`, { suspended: !u.suspended }).catch(toast.error);
    load();
  };

  const remove = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: `Supprimer ${u.name} ?`,
      text: `Son compte, ses ${u.items} élément(s) (${bytes(u.storageBytes)}) et ses ${u.machines} machine(s) seront supprimés définitivement. Tu ne peux pas lire ces données : seulement les effacer.`,
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

      {data && (
        <p className="admin-summary">
          <b>{data.stats.accounts}</b> comptes ({data.stats.verified} vérifiés
          {data.stats.pending > 0 && `, ${data.stats.pending} en attente`}
          {data.stats.suspended > 0 && `, ${data.stats.suspended} suspendus`}) · <b>{bytes(data.stats.storageBytes)}</b> de données chiffrées ·{" "}
          base {bytes(data.stats.dbFileBytes)} · <b>{data.stats.machinesOnline}</b>/{data.stats.machines} machines en ligne ·{" "}
          <b>{data.stats.openBoards}</b> tableau(x) ouvert(s) · <b>{data.stats.signupsLast7Days}</b> inscription(s) sur 7 jours
        </p>
      )}

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
          <div className="admin-tools">
            <label className="admin-search">
              <Search size={15} />
              <input className="input" placeholder="Nom ou email" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier par">
              <option value="created">Plus récents</option>
              <option value="seen">Dernière activité</option>
              <option value="storage">Stockage</option>
            </select>
          </div>
        </div>
        <p className="admin-note">Tu vois des tailles et des dates, jamais le contenu.</p>
        {users.map((u) => (
          <div className={`row admin-user${u.suspended ? " is-suspended" : ""}`} key={u.id}>
            <Avatar name={u.name} color={u.color} />
            <div className="grow">
              <div className="title">
                {u.name} {!!u.isAdmin && <span className="badge">admin</span>}
                {!u.emailVerified && <span className="badge">non vérifié</span>}
                {u.suspended && <span className="badge admin-badge-off">suspendu</span>}
              </div>
              <div className="sub">{u.email}</div>
            </div>
            <dl className="admin-facts">
              <div>
                <dt>Inscrit</dt>
                <dd>{ago(u.createdAt)}</dd>
              </div>
              <div>
                <dt>Activité</dt>
                <dd>{u.lastSeenAt ? ago(u.lastSeenAt) : "jamais"}</dd>
              </div>
              <div
                title={`Tableaux ${bytes(u.storage.boards)} · images ${bytes(u.storage.images)} · aperçus ${bytes(u.storage.previews)} · bibliothèque ${bytes(u.storage.library)} · autre ${bytes(u.storage.other)}`}
              >
                <dt>Stockage</dt>
                <dd>{bytes(u.storageBytes)}</dd>
              </div>
              <div>
                <dt>Machines</dt>
                <dd>
                  {u.machinesOnline}/{u.machines} en ligne
                </dd>
              </div>
            </dl>
            {u.id !== me.id && (
              <div className="admin-actions">
                <button className="btn btn-sm btn-icon" title={u.suspended ? "Réactiver" : "Suspendre"} onClick={() => toggleSuspend(u)}>
                  {u.suspended ? <RotateCcw size={16} /> : <Ban size={16} />}
                </button>
                <button className="btn btn-sm btn-icon" title={u.isAdmin ? "Retirer admin" : "Rendre admin"} onClick={() => toggleAdmin(u)}>
                  <Shield size={16} />
                </button>
                <button className="btn btn-sm btn-icon" style={{ color: "var(--danger)" }} title="Supprimer le compte" onClick={() => remove(u)}>
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
        ))}
        {data && users.length === 0 && <p className="admin-note">Aucun compte ne correspond.</p>}
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
