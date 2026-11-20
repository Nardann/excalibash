import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Globe, Lock, Moon, Network, Server, Sun, TerminalSquare, Users } from "lucide-react";
import { api } from "../api.ts";
import { Logo, useTheme } from "../components/ui.tsx";
import { HeroDiagram } from "./HeroDiagram.tsx";
import { RArrow, REllipse, SketchBox } from "./rough.tsx";
import "./landing.css";

type Status = { needsSetup: boolean; registrationOpen: boolean };

const STEPS = [
  { title: "Dessine la topologie", text: "Switch, VLAN, serveurs : tu prends tes icônes réseau dans la bibliothèque Excalidraw et tu traces les liens." },
  { title: "Branche tes machines", text: "Une commande sur chaque VM ou serveur et l'agent se connecte, même derrière le NAT de l'école." },
  { title: "Ouvre les shells sur le schéma", text: "Un clic sur l'icône d'un serveur et son terminal s'ouvre à côté. Plusieurs shells par machine si tu veux." },
  { title: "Partage avec ton binôme", text: "Il voit le schéma et les terminaux en direct, et tape dans le même shell. Ton prof aussi, en lecture seule." },
];

const FEATURES: { icon: ReactNode; title: string; text: string }[] = [
  {
    icon: <TerminalSquare size={22} strokeWidth={1.8} />,
    title: "De vrais shells sur le schéma",
    text: "vim, htop, ssh vers les autres machines : un terminal complet, dans une fenêtre que tu poses où tu veux. Fini les douze fenêtres PuTTY.",
  },
  {
    icon: <Network size={22} strokeWidth={1.8} />,
    title: "Ton schéma, tes icônes",
    text: "Chaque machine est une icône de ta bibliothèque avec son nom et son IP. Tu déplaces les fenêtres, l'icône reste à sa place.",
  },
  {
    icon: <Globe size={22} strokeWidth={1.8} />,
    title: "Les interfaces web des machines",
    text: "Proxmox, Centreon ou la page du routeur s'ouvrent depuis le tableau, ou en grand dans un onglet. Aucun port à ouvrir.",
  },
  {
    icon: <Users size={22} strokeWidth={1.8} />,
    title: "À deux sur le même terminal",
    text: "Dessin, curseurs et shells partagés en temps réel. Un dossier partagé avec le prof, et tous ses sous-dossiers suivent.",
  },
  {
    icon: <Lock size={22} strokeWidth={1.8} />,
    title: "Chiffré de bout en bout",
    text: "Schémas, frappes et pages web sont chiffrés dans ton navigateur. Le serveur ne voit que du bruit, l'admin non plus.",
  },
  {
    icon: <Server size={22} strokeWidth={1.8} />,
    title: "Sur ton serveur, pas chez un autre",
    text: "Un docker compose up suffit. L'agent tient en un binaire pour Linux et macOS, installé en une commande.",
  },
];

export function Landing() {
  const { theme, toggle } = useTheme();
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    api.get<Status>("/auth/status").then(setStatus).catch(() => {});
  }, []);

  const canRegister = !!status && (status.needsSetup || status.registrationOpen);

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
          {canRegister && (
            <Link to="/register" className="btn lp-btn-quiet">
              Créer un compte
            </Link>
          )}
          <Link to="/login" className="btn btn-primary">
            Se connecter
          </Link>
        </nav>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-text">
            <h1 className="lp-hand">Ton schéma de TP devient ta console.</h1>
            <p className="lp-lead">
              Dessine ton infra comme sur Excalidraw, pose tes machines dessus et ouvre un shell en un clic. Ton binôme tape dans le même terminal, à côté de toi ou
              depuis chez lui.
            </p>
            <div className="lp-actions">
              <Link to={canRegister ? "/register" : "/login"} className="btn btn-primary lp-btn-big">
                {canRegister ? "Créer un compte" : "Se connecter"}
              </Link>
              <a href="#seance" className="lp-link-quiet">
                Voir une séance de TP
              </a>
            </div>
          </div>
          <HeroDiagram />
        </section>

        <section className="lp-section" id="seance">
          <h2 className="lp-hand">Une séance de TP, sans jongler entre les fenêtres</h2>
          <ol className="lp-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="lp-step">
                <div className="lp-step-num">
                  <svg viewBox="0 0 56 56" aria-hidden>
                    <REllipse cx={28} cy={28} w={48} h={46} seed={90 + i} opts={{ fill: "#ffe58a", fillStyle: "solid", roughness: 1.4 }} />
                  </svg>
                  <span className="lp-hand">{i + 1}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <svg className="lp-step-arrow" viewBox="0 0 120 40" aria-hidden>
                    <RArrow points={[[6, 26], [60, 8 + (i % 2) * 18], [112, 22]]} seed={100 + i} opts={{ roughness: 1.2 }} />
                  </svg>
                )}
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="lp-section">
          <h2 className="lp-hand">Ce qu'il y a dans la boîte</h2>
          <div className="lp-grid">
            {FEATURES.map((f, i) => (
              <article key={f.title} className="lp-feature">
                <SketchBox seed={200 + i * 13} className="lp-feature-frame" />
                <div className="lp-feature-icon">
                  <svg viewBox="0 0 48 48" aria-hidden>
                    <REllipse cx={24} cy={24} w={44} h={40} seed={300 + i} opts={{ fill: "#ffe58a", fillStyle: "solid", roughness: 1.4, stroke: "#e9c94f", strokeWidth: 1 }} />
                  </svg>
                  {f.icon}
                </div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-final">
          <SketchBox seed={777} className="lp-final-frame" opts={{ fill: "#ffe58a", fillStyle: "hachure", hachureGap: 10, roughness: 1.5 }} />
          <h2 className="lp-hand">Le prochain TP peut commencer dans cinq minutes.</h2>
          <p>Crée ton compte, branche une VM, dessine. Ton binôme te rejoint avec un lien.</p>
          <div className="lp-actions lp-actions-center">
            <Link to={canRegister ? "/register" : "/login"} className="btn btn-primary lp-btn-big">
              {canRegister ? "Créer un compte" : "Se connecter"}
            </Link>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <span className="lp-hand">Excalibash</span>
        <span>Pour les TP de réseaux et d'informatique. Auto-hébergé, chiffré de bout en bout.</span>
        <Link to="/confidentialite">Confidentialité</Link>
        <Link to="/login">Se connecter</Link>
      </footer>
    </div>
  );
}
