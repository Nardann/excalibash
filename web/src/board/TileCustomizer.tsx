import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import type { LibraryItems } from "@excalidraw/excalidraw/types";
import { useKeys, useUser } from "../auth.tsx";
import { Modal, toast, useTheme } from "../components/ui.tsx";
import { iconUrl, loadLibrary, onLibraryUpdate, type TileIcon } from "./personalLibrary.ts";

export type TilePatch = { title: string | null; icon: TileIcon | null };

function IconPreview({ icon }: { icon: TileIcon }) {
  const { theme } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    iconUrl(icon, theme === "dark").then(setUrl).catch(() => setUrl(null));
  }, [icon, theme]);
  return url ? <img src={url} alt="" draggable={false} /> : <span className="spin-dot" />;
}

/** Picks the tile icon from the personal Excalidraw library and sets its label. */
export function TileCustomizer(p: {
  machineLabel: string;
  title: string | null;
  icon: TileIcon | null;
  onSave: (patch: TilePatch, collapse: boolean) => void;
  onClose: () => void;
  /** Node icons are always visible: no "save and reduce". */
  node?: boolean;
}) {
  const user = useUser();
  const keys = useKeys();
  const [items, setItems] = useState<LibraryItems | null>(null);
  const [title, setTitle] = useState(p.title ?? "");
  const [icon, setIcon] = useState<TileIcon | null>(p.icon);

  useEffect(() => {
    const load = () => loadLibrary(user, keys).then(setItems).catch(toast.error);
    load();
    return onLibraryUpdate(load);
  }, [user, keys]);

  const save = (collapse: boolean) => {
    p.onSave({ title: title.trim() || null, icon }, collapse);
    p.onClose();
  };
  const selectedKey = icon ? JSON.stringify(icon.elements.map((e) => e.id)) : null;

  return (
    <Modal onClose={p.onClose} width={620}>
      <h2 className="display">{p.node ? "Icône de la machine" : "Tuile du terminal"}</h2>
      <p>
        {p.node
          ? "Cette icône représente la machine dans ton schéma réseau : elle reste en place, un clic dessus ouvre ses shells. "
          : "Fermé, le terminal s'affiche comme cette tuile : place-la dans ton schéma réseau, un clic dessus ouvre le shell. "}
        L'icône et le libellé sont chiffrés avec le tableau.
      </p>
      <label className="field">
        Libellé (une ligne par information, ex. nom puis IP)
        <textarea className="input" rows={2} placeholder={p.machineLabel} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <div className="field" style={{ marginTop: 14 }}>
        Icône (depuis ta bibliothèque personnelle)
        <div className="icon-grid">
          <button className={`icon-choice ${!icon ? "selected" : ""}`} title="Icône par défaut" onClick={() => setIcon(null)}>
            <Monitor size={34} strokeWidth={1.6} />
            <span>Par défaut</span>
          </button>
          {items?.map((it) => {
            const candidate = { elements: it.elements };
            const key = JSON.stringify(it.elements.map((e) => e.id));
            return (
              <button key={it.id} className={`icon-choice ${key === selectedKey ? "selected" : ""}`} title={it.name ?? "Élément de bibliothèque"} onClick={() => setIcon(candidate)}>
                <IconPreview icon={candidate} />
                {it.name && <span>{it.name}</span>}
              </button>
            );
          })}
        </div>
        {items?.length === 0 && (
          <p className="sub" style={{ margin: "8px 0 0", fontWeight: 500 }}>
            Ta bibliothèque est vide. Dans l'éditeur, ouvre <b>Bibliothèque</b> (en haut à droite) : sélectionne un dessin puis « Ajouter à la bibliothèque », importe un
            fichier <code>.excalidrawlib</code>, ou parcours les bibliothèques publiques (serveurs, switchs, réseau…).
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={p.onClose}>
          Annuler
        </button>
        <button className={`btn ${p.node ? "btn-primary" : ""}`} onClick={() => save(false)}>
          Enregistrer
        </button>
        {!p.node && (
          <button className="btn btn-primary" onClick={() => save(true)}>
            Enregistrer et réduire
          </button>
        )}
      </div>
    </Modal>
  );
}
