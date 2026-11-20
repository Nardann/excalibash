import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { createItem, useLibraryCtx } from "../library.tsx";
import { toast } from "./ui.tsx";
import "./onboarding.css";

const STEPS = [
  {
    title: "Crée ton premier tableau",
    text: "Un tableau, c'est ton schéma de TP : tu y dessines l'infra et tu y poses tes terminaux.",
    action: "Créer un tableau",
  },
  {
    title: "Branche une machine",
    text: "Dans Machines, choisis « Ajouter avec un code » et lance la commande affichée sur ta VM ou ton serveur.",
    action: "Aller aux machines",
  },
  {
    title: "Travaille à deux",
    text: "Le bouton Partager d'un tableau ou d'un dossier invite ton binôme ou ton prof. Un dossier partagé donne accès à tout son contenu.",
    action: null,
  },
];

export function Onboarding() {
  const ctx = useLibraryCtx();
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ onboarded: boolean }>("/account")
      .then((r) => alive && setShow(r.onboarded === false))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (show) card.current?.focus();
  }, [show]);

  if (!show) return null;
  const s = STEPS[step];
  const last = step === STEPS.length - 1;

  const close = () => {
    setShow(false);
    api.post("/account/onboarded").catch(() => {});
  };

  const act = async () => {
    if (step === 0) {
      setBusy(true);
      try {
        const id = await createItem(ctx, "board", null, "Mon premier TP");
        setStep(1);
        navigate(`/board/${id}`);
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    } else if (step === 1) {
      setStep(2);
      navigate("/machines");
    }
  };

  return (
    <div
      ref={card}
      className="onb"
      role="region"
      aria-label="Guide de démarrage"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="onb-head">
        <h2 className="display">{s.title}</h2>
        <span className="onb-count">
          {step + 1}/{STEPS.length}
        </span>
      </div>
      <div aria-live="polite">
        <p>{s.text}</p>
      </div>
      {s.action && (
        <button className="btn btn-primary onb-do" disabled={busy} onClick={act}>
          {s.action}
        </button>
      )}
      <div className="onb-foot">
        <button className="btn btn-ghost btn-sm" onClick={close}>
          Passer
        </button>
        <button className="btn btn-sm" onClick={() => (last ? close() : setStep(step + 1))}>
          {last ? "Terminer" : "Suivant"}
        </button>
      </div>
    </div>
  );
}
