import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Moon, Sun } from "lucide-react";
import { api } from "../api.ts";
import { Logo, useTheme } from "../components/ui.tsx";
import "../landing/landing.css";
import "./privacy.css";

type Config = { contactEmail?: string | null; legalName?: string | null };

export function Privacy() {
  const { theme, toggle } = useTheme();
  const [cfg, setCfg] = useState<Config>({});

  useEffect(() => {
    api.get<Config>("/config").then(setCfg).catch(() => {});
  }, []);

  return (
    <div className="lp">
      <header className="lp-top">
        <Link to="/" className="lp-brand lp-hand">
          <Logo size={34} />
          Excalibash
        </Link>
        <nav className="lp-nav">
          <button className="lp-icon-btn" onClick={toggle} aria-label={theme === "dark" ? "Thème clair" : "Thème sombre"}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </nav>
      </header>

      <main className="priv">
        <h1 className="lp-hand">Confidentialité</h1>

        <h2 className="lp-hand">Qui gère cette instance</h2>
        <p>{cfg.legalName || "L'administrateur de cette instance"} héberge ce serveur et en est responsable. Excalibash est un logiciel auto-hébergé : chaque instance a son propre administrateur.</p>

        <h2 className="lp-hand">Ce que le serveur stocke</h2>
        <ul>
          <li>Ton adresse email et ton nom affiché.</li>
          <li>La structure de tes dossiers et qui partage quoi avec qui.</li>
          <li>Les dates de création et de modification, et la taille des données.</li>
          <li>Les adresses IP, dans les journaux du serveur.</li>
        </ul>

        <h2 className="lp-hand">Ce que le serveur ne peut pas lire</h2>
        <p>
          Les noms des tableaux et des dossiers, les dessins, les images, les aperçus, le contenu des terminaux et les pages web des tunnels sont chiffrés dans ton
          navigateur avant d'être envoyés. Le serveur et son administrateur ne voient que des données chiffrées. Si tu perds ton mot de passe et ta clé de
          récupération, personne ne peut les récupérer.
        </p>

        <h2 className="lp-hand">Cookies</h2>
        <p>Un seul cookie : celui de ta session. Il est HttpOnly et sert uniquement à te garder connecté. Pas de traceur, pas de publicité.</p>

        <h2 className="lp-hand">Tes droits</h2>
        <ul>
          <li>Tu peux exporter un tableau depuis l'éditeur.</li>
          <li>
            Tu peux supprimer ton compte à tout moment dans <Link to="/account">Mon compte</Link>. La suppression est définitive.
          </li>
        </ul>

        <h2 className="lp-hand">Contact</h2>
        <p>
          Pour signaler un abus ou exercer tes droits,{" "}
          {cfg.contactEmail ? (
            <>
              écris à <a href={`mailto:${cfg.contactEmail}`}>{cfg.contactEmail}</a>.
            </>
          ) : (
            "contacte l'administrateur de cette instance."
          )}
        </p>
      </main>
    </div>
  );
}
