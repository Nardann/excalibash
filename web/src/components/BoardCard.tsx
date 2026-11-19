import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Check, Clock, Eye, Folder, PenTool, TerminalSquare, Users } from "lucide-react";
import { fetchPreview, type Node } from "../library.tsx";
import { DRAG_TYPE } from "./Layout.tsx";

const previewCache = new Map<string, { at: number; svg: string | null }>();

/** Fetches and decrypts a board thumbnail once it scrolls into view. */
function usePreview(node: Node) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(() => {
    const c = previewCache.get(node.id);
    return c && c.at >= node.updatedAt ? c.svg : null;
  });
  useEffect(() => {
    if (node.kind !== "board" || !node.key) return;
    const cached = previewCache.get(node.id);
    if (cached && cached.at >= node.updatedAt) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        fetchPreview(node.key!, node.id)
          .then((s) => {
            previewCache.set(node.id, { at: node.updatedAt, svg: s });
            setSvg(s);
          })
          .catch(() => {});
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [node.id, node.key, node.kind, node.updatedAt]);
  return { ref, svg };
}

type Props = {
  node: Node;
  childCount?: number;
  selected: boolean;
  selecting: boolean;
  draggableIds: () => string[];
  onOpen: () => void;
  onToggleSelect: (shift: boolean) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  onDropItems?: (ids: string[]) => void;
  meId: string;
};

export function ItemCard({ node, childCount, selected, selecting, draggableIds, onOpen, onToggleSelect, onContextMenu, onRename, onDropItems, meId }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.name);
  const [dropping, setDropping] = useState(false);
  const { ref, svg } = usePreview(node);
  const trashed = !!node.deletedAt;
  const canEdit = node.role !== "viewer" && !trashed;

  // Rendered through <img> so SVG coming from other users can never run script.
  const previewUrl = useMemo(() => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null), [svg]);

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== node.name) onRename(name);
  };

  const folder = node.kind === "folder";

  return (
    <div
      ref={ref}
      className={`card ${folder ? "folder-card" : ""} ${selected ? "selected" : ""} ${trashed ? "trashed" : ""} ${dropping ? "drop-target" : ""}`}
      draggable={!trashed && !editing && canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(draggableIds()));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (!folder || !onDropItems || !canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (raw && onDropItems) onDropItems((JSON.parse(raw) as string[]).filter((id) => id !== node.id));
      }}
      onClick={(e) => {
        if (editing) return;
        if (selecting || e.metaKey || e.ctrlKey || e.shiftKey) onToggleSelect(e.shiftKey);
        else if (!trashed) onOpen();
      }}
      onContextMenu={onContextMenu}
    >
      <div className="card-thumb">
        {folder ? (
          <div className="folder-icon">
            <Folder size={56} strokeWidth={1.4} />
            {childCount !== undefined && <span>{childCount}</span>}
          </div>
        ) : previewUrl ? (
          <img src={previewUrl} alt="" loading="lazy" draggable={false} />
        ) : (
          <div className="empty">
            <PenTool size={30} strokeWidth={1.5} />
          </div>
        )}
        <div className="card-badges">
          {node.terminals > 0 && (
            <span className="badge live" title="Terminaux actifs">
              <TerminalSquare size={12} /> {node.terminals}
            </span>
          )}
          {node.shares > 0 && node.ownerId === meId && (
            <span className="badge" title="Partagé">
              <Users size={12} /> {node.shares}
            </span>
          )}
          {node.role === "viewer" && (
            <span className="badge" title="Lecture seule">
              <Eye size={12} /> Lecture
            </span>
          )}
        </div>
        <button
          className="card-check"
          aria-label={selected ? "Désélectionner" : "Sélectionner"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(e.shiftKey);
          }}
        >
          {selected && <Check size={14} strokeWidth={3} />}
        </button>
      </div>
      <div className="card-body">
        <h3
          className="card-title"
          title={node.name}
          onDoubleClick={(e) => {
            if (!canEdit) return;
            e.stopPropagation();
            setDraft(node.name);
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            node.name
          )}
        </h3>
        <div className="card-meta">
          <Clock size={11} />
          {trashed
            ? `supprimé ${formatDistanceToNow(node.deletedAt!, { addSuffix: true, locale: fr })}`
            : formatDistanceToNow(node.updatedAt, { addSuffix: true, locale: fr })}
          {node.ownerId !== meId && (
            <>
              <span className="sep">·</span> {node.ownerName}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
