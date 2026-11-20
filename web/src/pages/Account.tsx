import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Fingerprint, KeyRound, Loader2, Trash2 } from "lucide-react";
import { api, type User } from "../api.ts";
import { useAuth, useKeys, useUser } from "../auth.tsx";
import { changePassword, forgetKeys } from "../account.ts";
import { deriveAccountKeys, fingerprint } from "../crypto.ts";
import { confirmDialog, copyText, toast } from "../components/ui.tsx";

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

  useEffect(() => {
    fingerprint(keys.pub).then(setFp);
  }, [keys]);

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
