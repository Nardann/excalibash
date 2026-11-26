import { useEffect, useRef, useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { History, Loader2, RotateCcw, X } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { SymKey } from "../crypto.ts";
import { fetchVersionContent, fetchVersions, type BoardContent, type VersionInfo } from "../library.tsx";
import { confirmDialog, toast } from "../components/ui.tsx";
import { renderPreview } from "./files.ts";
import { restoreVersion } from "./history.ts";

type Shown = { id: number; content: BoardContent; src: string | null };

/** Side panel: past versions of the board (decrypted here), with a preview and a restore button. */
export function HistoryPanel({ boardId, boardKey, api, editor, onClose }: { boardId: string; boardKey: SymKey; api: ExcalidrawImperativeAPI | null; editor: boolean; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [selected, setSelected] = useState<VersionInfo | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    fetchVersions(boardId).then(setVersions).catch((e) => {
      toast.error(e);
      setVersions([]);
    });
  }, [boardId]);

  const pick = async (v: VersionInfo) => {
    const mine = ++request.current;
    setSelected(v);
    setShown(null);
    setLoading(true);
    try {
      const content = await fetchVersionContent(boardKey, boardId, v.id);
      const svg = await renderPreview(content.elements, content.files).catch(() => null);
      // An <img> data URL: the SVG is never injected into the page.
      if (mine === request.current) setShown({ id: v.id, content, src: svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null });
    } catch (e) {
      if (mine === request.current) toast.error(e);
    } finally {
      if (mine === request.current) setLoading(false);
    }
  };

  const restore = async () => {
    if (!api || !selected || !shown) return;
    const when = format(selected.createdAt, "d MMMM yyyy 'à' HH:mm", { locale: fr });
    const ok = await confirmDialog({
      title: "Restaurer cette version ?",
      text: `Le dessin revient à l'état du ${when}. Les terminaux et sites ouverts ne sont pas touchés, et Ctrl+Z annule la restauration.`,
      confirm: "Restaurer",
    });
    if (!ok) return;
    restoreVersion(api, shown.content.elements, shown.content.files);
    toast(`Version du ${when} restaurée`);
    onClose();
  };

  return (
    <aside className="dock history-panel" aria-label="Historique du tableau">
      <div className="dock-head">
        <History size={15} />
        Historique
        <button title="Fermer" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="dock-body">
        {versions === null && (
          <div className="history-empty">
            <Loader2 size={16} className="spin" />
          </div>
        )}
        {versions?.length === 0 && <div className="history-empty">Aucune version enregistrée pour l'instant. Une version est gardée toutes les quelques minutes de travail et à la fin de chaque session.</div>}
        {versions?.map((v) => (
          <button key={v.id} className={`history-item ${selected?.id === v.id ? "selected" : ""}`} onClick={() => void pick(v)} title={format(v.createdAt, "d MMMM yyyy HH:mm:ss", { locale: fr })}>
            <span>{formatDistanceToNow(v.createdAt, { addSuffix: true, locale: fr })}</span>
            <span className="history-count">
              {v.count} élément{v.count > 1 ? "s" : ""}
            </span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="history-preview">
          {loading && (
            <div className="history-empty">
              <Loader2 size={16} className="spin" />
            </div>
          )}
          {shown && (shown.src ? <img src={shown.src} alt="Aperçu de la version" /> : <div className="history-empty">Rien à afficher (tableau vide).</div>)}
          {shown && editor && (
            <button className="btn btn-primary btn-sm" onClick={() => void restore()}>
              <RotateCcw size={14} /> Restaurer cette version
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
