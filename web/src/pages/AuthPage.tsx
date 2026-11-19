import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Download, KeyRound, Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { api, type User } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { login, recover, register, unlock, type Session } from "../account.ts";
import { Logo, copyText } from "../components/ui.tsx";

type Status = { needsSetup: boolean; registrationOpen: boolean };
type Mode = "login" | "register" | "recover";

export function AuthPage({ mode }: { mode: Mode }) {
  const { user, keys, signedIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invite = params.get("invite");
  const [status, setStatus] = useState<Status | null>(null);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", confirm: "", recoveryKey: "" });
  const [pending, setPending] = useState<(Session & { recoveryKey: string }) | null>(null);

  useEffect(() => {
    api.get<Status>("/auth/status").then(setStatus).catch(() => {});
    if (invite) api.get<{ valid: boolean }>(`/auth/invite/${encodeURIComponent(invite)}`).then((r) => setInviteValid(r.valid)).catch(() => setInviteValid(false));
  }, [invite]);

  const next = params.get("next") || "/";
  if (pending) {
    return (
      <RecoveryKeyScreen
        recoveryKey={pending.recoveryKey}
        email={pending.user.email}
        onDone={() => {
          signedIn(pending.user, pending.keys);
          navigate(next, { replace: true });
        }}
      />
    );
  }
  if (user && keys) return <Navigate to={next} replace />;
  if (status?.needsSetup && mode === "login") return <Navigate to="/register" replace />;

  const setup = !!status?.needsSetup;
  const canRegister = setup || status?.registrationOpen || inviteValid;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if ((mode === "register" || mode === "recover") && form.password !== form.confirm) {
      setError("Les deux mots de passe ne correspondent pas");
      return;
    }
    setBusy(true);
    try {
      if (mode === "register") {
        setPending(await register({ email: form.email, name: form.name, password: form.password, invite }));
      } else if (mode === "recover") {
        const s = await recover(form.email, form.recoveryKey, form.password);
        signedIn(s.user, s.keys);
        navigate("/", { replace: true });
      } else {
        const s = await login(form.email, form.password);
        signedIn(s.user, s.keys);
        navigate(next, { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });

  const title = setup ? "Bienvenue !" : mode === "register" ? "Créer un compte" : mode === "recover" ? "Récupération" : "Connexion";
  const hint = setup
    ? "Crée le compte administrateur. Tes données sont chiffrées dans ton navigateur : même l'admin du serveur ne peut pas les lire."
    : mode === "register"
      ? "Tableaux + terminaux, chiffrés de bout en bout."
      : mode === "recover"
        ? "Entre ta clé de récupération pour définir un nouveau mot de passe sans rien perdre."
        : "Content de te revoir sur Excalibash.";

  return (
    <div className="auth">
      <div className="auth-card">
        <Logo size={52} />
        <h1 className="display">{title}</h1>
        <p className="hint">{hint}</p>
        {mode === "register" && status && !canRegister ? (
          <p className="form-error" style={{ marginTop: 20 }}>
            {invite ? "Cette invitation est invalide ou expirée." : "Les inscriptions sont fermées. Demande une invitation à un administrateur."}
          </p>
        ) : (
          <form onSubmit={submit}>
            {mode === "register" && (
              <label className="field">
                Nom
                <input className="input" required autoComplete="name" {...field("name")} />
              </label>
            )}
            <label className="field">
              Email
              <input className="input" type="email" required autoComplete="email" autoFocus {...field("email")} />
            </label>
            {mode === "recover" && (
              <label className="field">
                Clé de récupération
                <input className="input mono" required placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} {...field("recoveryKey")} />
              </label>
            )}
            <label className="field">
              {mode === "recover" ? "Nouveau mot de passe" : "Mot de passe"}
              <input
                className="input"
                type="password"
                required
                minLength={mode === "login" ? undefined : 10}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                {...field("password")}
              />
            </label>
            {mode !== "login" && (
              <label className="field">
                Confirmation
                <input className="input" type="password" required minLength={10} autoComplete="new-password" {...field("confirm")} />
              </label>
            )}
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary" disabled={busy} style={{ height: 44 }}>
              {busy ? (
                <>
                  <Loader2 size={16} className="spin" /> {mode === "login" ? "Déchiffrement des clés…" : "Génération des clés…"}
                </>
              ) : mode === "register" ? (
                "Créer le compte"
              ) : mode === "recover" ? (
                "Redéfinir le mot de passe"
              ) : (
                "Se connecter"
              )}
            </button>
          </form>
        )}
        {!setup && (
          <div className="hint" style={{ marginTop: 18, textAlign: "center", display: "grid", gap: 6 }}>
            {mode !== "login" && (
              <span>
                Déjà un compte ? <Link to="/login" className="link">Se connecter</Link>
              </span>
            )}
            {mode === "login" && status?.registrationOpen && (
              <span>
                Pas de compte ? <Link to="/register" className="link">S'inscrire</Link>
              </span>
            )}
            {mode === "login" && (
              <span>
                Mot de passe oublié ? <Link to="/recover" className="link">Utiliser ma clé de récupération</Link>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RecoveryKeyScreen({ recoveryKey, email, onDone }: { recoveryKey: string; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const download = () => {
    const text = `Excalibash — clé de récupération\nCompte : ${email}\nServeur : ${location.origin}\n\n${recoveryKey}\n\nGarde-la hors ligne. Sans elle, un mot de passe oublié = données perdues.\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "excalibash-cle-de-recuperation.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="auth">
      <div className="auth-card" style={{ width: "min(520px, 100%)" }}>
        <KeyRound size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Ta clé de récupération</h1>
        <p className="hint">
          Tes données sont chiffrées avec ton mot de passe. Personne, pas même l'administrateur, ne peut le réinitialiser. Si tu l'oublies, cette clé est
          <b> le seul moyen</b> de récupérer ton compte. Elle ne sera plus jamais affichée.
        </p>
        <div className="codebox" style={{ marginTop: 18, fontSize: 15, textAlign: "center", padding: "16px 44px" }}>
          {recoveryKey}
          <button className="btn btn-ghost btn-icon btn-sm" title="Copier" onClick={() => copyText(recoveryKey)}>
            <KeyRound size={15} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn" onClick={download}>
            <Download size={16} /> Télécharger (.txt)
          </button>
        </div>
        <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, fontSize: 14, fontWeight: 600 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Je l'ai rangée en lieu sûr (gestionnaire de mots de passe, papier…)
        </label>
        <button className="btn btn-primary" style={{ marginTop: 18, width: "100%", height: 44 }} disabled={!saved} onClick={onDone}>
          <ShieldCheck size={18} /> Continuer
        </button>
      </div>
    </div>
  );
}

/** Signed in (cookie) but this browser does not hold the decrypted private key. */
export function UnlockScreen({ user }: { user: User }) {
  const { setKeys, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <LockKeyhole size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Déverrouiller</h1>
        <p className="hint">
          Bonjour {user.name}. Entre ton mot de passe pour déchiffrer tes clés sur cet appareil.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setKeys(await unlock(user, password));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <label className="field">
            Mot de passe
            <input className="input" type="password" required autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy} style={{ height: 44 }}>
            {busy ? <Loader2 size={16} className="spin" /> : "Déverrouiller"}
          </button>
        </form>
        <p className="hint" style={{ marginTop: 16, textAlign: "center" }}>
          <button className="link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => logout()}>
            Changer de compte
          </button>
        </p>
      </div>
    </div>
  );
}
