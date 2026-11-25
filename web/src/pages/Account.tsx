import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Bell, EyeOff, Fingerprint, KeyRound, Loader2, Trash2 } from "lucide-react";
import { api, type User } from "../api.ts";
import { useAuth, useKeys, useUser } from "../auth.tsx";
import { changePassword, forgetKeys } from "../account.ts";
import { deriveAccountKeys, fingerprint } from "../crypto.ts";
import { confirmDialog, copyText, toast } from "../components/ui.tsx";

type NotifyEvent = "itemDeleted" | "itemShared" | "accessRevoked" | "itemTransferred" | "newLogin";
type NotifyPrefs = Record<NotifyEvent, boolean>;

const NOTIFICATIONS: { key: NotifyEvent; title: string; help: string }[] = [
  { key: "itemDeleted", title: "Un tableau ou dossier est supprimé", help: "Quand toi ou quelqu'un d'autre met à la corbeille (ou supprime) un élément auquel tu as accès." },
  { key: "itemShared", title: "On me partage quelque chose", help: "Quand quelqu'un te donne accès à un tableau ou un dossier." },
  { key: "accessRevoked", title: "On me retire un accès", help: "Quand le propriétaire arrête de partager un élément avec toi." },
  { key: "itemTransferred", title: "On me donne un élément", help: "Quand quelqu'un te transfère la propriété d'un tableau ou d'un dossier." },
  { key: "newLogin", title: "Nouvelle connexion à mon compte", help: "À chaque connexion avec ton mot de passe, avec la date et l'adresse IP." },
];

export function Account() {
  const user = useUser();
  const keys = useKeys();
  const { setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [delPw, setDelPw] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [fp, setFp] = useState("");
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [vis, setVis] = useState<{ findableName: boolean; findableEmail: boolean } | null>(null);
  const [notif, setNotif] = useState<{ prefs: NotifyPrefs; emailEnabled: boolean } | null>(null);

  useEffect(() => {
    fingerprint(keys.pub).then(setFp);
  }, [keys]);

  useEffect(() => {
    api
      .get<{ findableName: boolean; findableEmail: boolean; notifications: NotifyPrefs; emailEnabled: boolean }>("/account")
      .then((r) => {
        setVis({ findableName: r.findableName, findableEmail: r.findableEmail });
        setNotif({ prefs: r.notifications, emailEnabled: r.emailEnabled });
      })
      .catch(toast.error);
  }, []);

  const setNotification = async (key: NotifyEvent, on: boolean) => {
    if (!notif) return;
    const prev = notif;
    const prefs = { ...notif.prefs, [key]: on };
    setNotif({ ...notif, prefs });
    try {
      await api.put("/account/notifications", prefs);
      toast(on ? "Notification activée" : "Notification désactivée");
    } catch (err) {
      setNotif(prev);
      toast.error(err);
    }
  };

  const setVisibility = async (next: { findableName: boolean; findableEmail: boolean }) => {
    const prev = vis;
    setVis(next);
    try {
      await api.put("/account/visibility", next);
      toast("Visibilité enregistrée");
    } catch (err) {
      setVis(prev);
      toast.error(err);
    }
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await confirmDialog({
      title: "Supprimer ton compte ?",
      text: "C'est définitif. Tes dossiers disparaissent pour tout le monde, et tes machines sont déconnectées.",
      confirm: "Supprimer mon compte",
      danger: true,
    });
    if (!ok) return;
    setDelBusy(true);
    try {
      const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email: user.email });
      const { authKey } = await deriveAccountKeys(delPw, salt);
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authKey }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? (res.status === 401 || res.status === 403 ? "Mot de passe incorrect" : `Erreur ${res.status}`));
      }
      await forgetKeys();
      await logout();
      navigate("/");
    } catch (err) {
      toast.error(err);
      setDelBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title display">Mon compte</h1>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Fingerprint size={16} /> Empreinte de ma clé
          </h3>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title mono" style={{ fontSize: 15 }}>
              {fp}
            </div>
            <div className="sub">
              Quand quelqu'un te partage un dossier pour la première fois, il voit cette empreinte. Comparez-la (de vive voix, par message…) pour être sûrs que
              personne ne s'est glissé entre vous.
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => copyText(fp)}>
            Copier
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Profil</h3>
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.patch<{ user: User }>("/auth/me", { name });
              setUser(r.user);
              toast("Nom mis à jour");
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <label className="field grow">
            Nom affiché (visible par les personnes avec qui tu partages, et par le serveur)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn" style={{ alignSelf: "flex-end" }}>
            Enregistrer
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <EyeOff size={16} /> Visibilité
          </h3>
        </div>
        <div style={{ padding: 20 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!vis?.findableName}
              disabled={!vis}
              onChange={(e) => vis && setVisibility({ ...vis, findableName: e.target.checked })}
            />
            <span>
              Trouvable par mon nom
              <small>Quelqu'un qui cherche ton nom (début du nom compris) au moment d'un partage te voit dans les résultats, avec ton nom seulement.</small>
            </span>
          </label>
          <label className="check" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={!!vis?.findableEmail}
              disabled={!vis}
              onChange={(e) => vis && setVisibility({ ...vis, findableEmail: e.target.checked })}
            />
            <span>
              Trouvable par mon email
              <small>
                Décoché, taper ton email donne « Aucun compte trouvé », comme si tu n'existais pas. Coché, ton email est aussi montré à qui te trouve.
              </small>
            </span>
          </label>
          <p className="field-help" style={{ margin: "12px 0 0" }}>
            Les personnes qui partagent déjà quelque chose avec toi te trouvent toujours, quels que soient ces réglages.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Bell size={16} /> Notifications par email
          </h3>
        </div>
        <div style={{ padding: 20 }}>
          {notif && !notif.emailEnabled && (
            <p className="field-help" style={{ margin: "0 0 12px" }}>
              Ce serveur n'envoie pas d'emails pour l'instant : tes choix sont enregistrés et serviront dès qu'un administrateur aura configuré l'envoi.
            </p>
          )}
          {NOTIFICATIONS.map((n, i) => (
            <label className="check" key={n.key} style={i ? { marginTop: 12 } : undefined}>
              <input type="checkbox" checked={!!notif?.prefs[n.key]} disabled={!notif} onChange={(e) => setNotification(n.key, e.target.checked)} />
              <span>
                {n.title}
                <small>{n.help}</small>
              </span>
            </label>
          ))}
          <p className="field-help" style={{ margin: "12px 0 0" }}>
            Envoyées à {user.email}. Par défaut, seuls les partages sont annoncés. Les noms des tableaux sont chiffrés : le serveur ne les connaît pas, les emails disent
            seulement de quel type d'élément il s'agit.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <KeyRound size={16} /> Mot de passe
          </h3>
        </div>
        <form
          style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.next !== pw.confirm) return toast.error("Les deux mots de passe ne correspondent pas");
            setBusy(true);
            try {
              await changePassword(user, pw.current, pw.next);
              setPw({ current: "", next: "", confirm: "" });
              toast("Mot de passe changé — les autres appareils sont déconnectés");
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="sub" style={{ margin: 0 }}>
            Ta clé privée est re-chiffrée avec le nouveau mot de passe. Ta clé de récupération reste valable.
          </p>
          <label className="field">
            Mot de passe actuel
            <input className="input" type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </label>
          <label className="field">
            Nouveau mot de passe
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
          <label className="field">
            Confirmation
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : "Changer le mot de passe"}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Trash2 size={16} /> Supprimer mon compte
          </h3>
        </div>
        <form style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }} onSubmit={deleteAccount}>
          <p className="sub" style={{ margin: 0 }}>
            La suppression est définitive. Tes données sont chiffrées avec tes clés : une fois le compte supprimé, elles sont irrécupérables. Les dossiers que tu
            possèdes, même partagés, disparaissent pour tout le monde. Tes machines sont déconnectées.
          </p>
          <label className="field">
            Mot de passe
            <input className="input" type="password" required autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
          </label>
          <button className="btn btn-danger" disabled={delBusy || !delPw}>
            {delBusy ? <Loader2 size={16} className="spin" /> : "Supprimer mon compte"}
          </button>
        </form>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>
        <Link to="/confidentialite">Confidentialité</Link>
      </p>
    </>
  );
}
