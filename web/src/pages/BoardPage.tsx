import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, newElementWith, useHandleLibrary } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, NonDeleted, ExcalidrawEmbeddableElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { ArrowLeft, Check, Cloud, CloudOff, Eye, Loader2, Lock, Moon, Plus, Server, Share2, Sun, TerminalSquare } from "lucide-react";
import { useKeys, useUser } from "../auth.tsx";
import { BoardSession, terminalIdOf, type ConnState, type Peer } from "../board/collab.ts";
import { TerminalEmbed } from "../board/TerminalEmbed.tsx";
import { savePreview } from "../board/files.ts";
import { isInTrash, renameItem, useLibrary, useLibraryCtx, type Node } from "../library.tsx";
import { listMachines, type Machine } from "../vault.ts";
import { ShareModal } from "../components/ShareModal.tsx";
import { libraryAdapter, type TileIcon } from "../board/personalLibrary.ts";
import type { TilePatch } from "../board/TileCustomizer.tsx";
import { Avatar, Menu, toast, useTheme } from "../components/ui.tsx";

const TERMINAL_LINK = "https://excalibash.local/terminal/";
const TERM_W = 760;
const TERM_H = 440;
const TILE = 120;

type TileData = {
  terminalId?: string;
  collapsed?: boolean;
  expanded?: { w: number; h: number };
  tile?: { w: number; h: number };
  title?: string | null;
  icon?: TileIcon | null;
};
const PREVIEW_DELAY = 4000;
const LAST_MACHINE = "eb-last-machine";

export default function BoardPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { nodes, loading } = useLibrary();
  const node = nodes.get(id);

  if (loading) return <div className="board-overlay">Déchiffrement…</div>;
  const error = !node
    ? "Ce tableau n'existe pas ou n'est pas partagé avec toi."
    : node.kind !== "board"
      ? "Ce n'est pas un tableau."
      : isInTrash(nodes, node)
        ? "Ce tableau est dans la corbeille."
        : !node.key
          ? "Impossible de déchiffrer ce tableau avec tes clés."
          : null;
  if (error)
    return (
      <div className="auth">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <h1 className="display">Oups</h1>
          <p className="hint">{error}</p>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => navigate("/")}>
            Retour
          </button>
        </div>
      </div>
    );
  // A new key epoch or role means a fresh session with the new keys.
  return <Editor key={`${node!.id}:${node!.epoch}:${node!.role}`} node={node!} />;
}

function Editor({ node }: { node: Node }) {
  const user = useUser();
  const keys = useKeys();
  const ctx = useLibraryCtx();
  const { refresh } = useLibrary();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const session = useMemo(() => new BoardSession(node.id, node.key!, node.epoch, node.role), [node.id, node.key, node.epoch, node.role]);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [closed, setClosed] = useState<string | null>(null);
  const [termMenu, setTermMenu] = useState<HTMLElement | null>(null);
  const [sharing, setSharing] = useState(false);
  const [terminalSelected, setTerminalSelected] = useState(false);
  const termButton = useRef<HTMLButtonElement>(null);
  const previewTimer = useRef<number | undefined>(undefined);
  const editor = node.role !== "viewer";

  const excalidrawRef = useRef(excalidraw);
  excalidrawRef.current = excalidraw;
  const flushPreview = useCallback(() => {
    previewTimer.current = undefined;
    const x = excalidrawRef.current;
    if (x && editor) savePreview(node.id, node.key!, node.epoch, x.getSceneElements(), x.getFiles()).catch(() => {});
  }, [node.id, node.key, node.epoch, editor]);

  useEffect(() => {
    const offs = [
      session.on("state", setConn),
      session.on("peers", setPeers),
      session.on("error", (m) => toast.error(m)),
      session.on("closed", (code) => {
        if (code === 4409 || code === 4410) {
          // Keys rotated or rights changed: reload the tree, the editor remounts with the new keys.
          toast(code === 4409 ? "Les clés de ce tableau ont été renouvelées" : "Tes droits sur ce tableau ont changé");
          refresh().catch(() => setClosed("Tu n'as plus accès à ce tableau."));
        } else setClosed(code === 4404 ? "Ce tableau a été supprimé." : "Tu n'as plus accès à ce tableau.");
      }),
      session.on("localChange", () => {
        clearTimeout(previewTimer.current);
        previewTimer.current = window.setTimeout(flushPreview, PREVIEW_DELAY);
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      session.dispose();
    };
  }, [session, flushPreview, refresh]);

  useEffect(
    () => () => {
      if (previewTimer.current) {
        clearTimeout(previewTimer.current);
        flushPreview();
      }
    },
    [flushPreview],
  );

  useEffect(() => {
    session.setApi(excalidraw);
  }, [session, excalidraw]);

  // Personal library: loaded/saved encrypted, and "Browse libraries" installs work.
  const adapter = useMemo(() => libraryAdapter(user, keys), [user, keys]);
  useHandleLibrary({
    excalidrawAPI: excalidraw,
    adapter,
    validateLibraryUrl: (url) => new URL(url).origin === "https://libraries.excalidraw.com",
  });

  const addTerminal = useCallback(
    async (machine: Machine) => {
      const x = excalidraw;
      if (!x) return;
      setTermMenu(null);
      try {
        const info = await session.createTerminal(machine, 100, 30);
        localStorage.setItem(LAST_MACHINE, machine.id);
        const st = x.getAppState();
        const zoom = st.zoom.value;
        const cx = -st.scrollX + st.width / 2 / zoom;
        const cy = -st.scrollY + st.height / 2 / zoom;
        const [base] = convertToExcalidrawElements([
          { type: "rectangle", x: cx - TERM_W / 2, y: cy - TERM_H / 2, width: TERM_W, height: TERM_H, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0 },
        ]);
        const element = {
          ...base,
          type: "embeddable",
          link: TERMINAL_LINK + info.id,
          customData: { terminalId: info.id },
          index: null,
          roundness: null,
        } as unknown as ExcalidrawElement;
        x.updateScene({ elements: [...x.getSceneElementsIncludingDeleted(), element], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        const placed = x.getSceneElements().find((e) => e.id === element.id) as NonDeleted<ExcalidrawEmbeddableElement> | undefined;
        if (placed) {
          x.updateScene({
            appState: { selectedElementIds: {}, activeEmbeddable: { element: placed, state: "active" } } as any,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      } catch (e) {
        toast.error(e);
      }
    },
    [excalidraw, session],
  );

  // Alt+T: new terminal on the last machine used (or open the picker).
  useEffect(() => {
    if (!editor) return;
    const onKey = async (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyT" || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const last = localStorage.getItem(LAST_MACHINE);
      const m = (await listMachines(keys)).find((x) => x.id === last && x.online);
      if (m) addTerminal(m);
      else setTermMenu(termButton.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [addTerminal, editor, keys]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      session.handleChange(elements, files);
      if (appState.theme !== theme) toggle();
      const selected = Object.keys(appState.selectedElementIds);
      setTerminalSelected(selected.length === 1 && !!terminalIdOf(elements.find((e) => e.id === selected[0])));
    },
    [session, theme, toggle],
  );

  /**
   * Terminal window ⇄ tile. Everything lives on the element (size + customData: collapsed flag,
   * remembered sizes, label, library icon), so it syncs encrypted to everyone and goes through undo.
   */
  const updateTerminal = useCallback((elementId: string, patch: TilePatch | null, toggle: boolean) => {
    const x = excalidrawRef.current;
    if (!x) return;
    const el = x.getSceneElementsIncludingDeleted().find((e) => e.id === elementId);
    if (!el) return;
    const data = (el.customData ?? {}) as TileData;
    // Never let the canvas draw a frame under the (possibly transparent) tile.
    const frameless = { strokeColor: "transparent", backgroundColor: "transparent" } as const;
    let next = newElementWith(el, { ...frameless, customData: patch ? { ...data, ...patch } : data });
    const collapse = toggle && !data.collapsed;
    if (toggle) {
      const d = next.customData as TileData;
      next = collapse
        ? newElementWith(next, {
            width: d.tile?.w ?? TILE,
            height: d.tile?.h ?? TILE,
            customData: { ...d, collapsed: true, expanded: { w: next.width, h: next.height } },
          })
        : newElementWith(next, {
            width: d.expanded?.w ?? TERM_W,
            height: d.expanded?.h ?? TERM_H,
            customData: { ...d, collapsed: false, tile: { w: next.width, h: next.height } },
          });
    }
    x.updateScene({
      elements: x.getSceneElementsIncludingDeleted().map((e) => (e.id === elementId ? next : e)),
      appState: toggle ? ({ activeEmbeddable: null, selectedElementIds: {} } as any) : undefined,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    if (!toggle || collapse) return;
    // Excalidraw finishes the click and may replace the element object; it tracks the active
    // embeddable by identity, so activate the final instance once the scene has settled.
    setTimeout(() => {
      const current = x.getSceneElements().find((e) => e.id === elementId) as NonDeleted<ExcalidrawEmbeddableElement> | undefined;
      if (current) x.updateScene({ appState: { activeEmbeddable: { element: current, state: "active" } } as any, captureUpdate: CaptureUpdateAction.NEVER });
    }, 60);
  }, []);

  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) => {
      const tid = terminalIdOf(element);
      if (!tid) return null;
      const active = appState.activeEmbeddable?.element.id === element.id && appState.activeEmbeddable.state === "active";
      const data = (element.customData ?? {}) as TileData;
      return (
        <TerminalEmbed
          session={session}
          terminalId={tid}
          active={active}
          collapsed={!!data.collapsed}
          title={data.title}
          icon={data.icon}
          onToggleCollapsed={editor ? () => updateTerminal(element.id, null, true) : undefined}
          onCustomize={editor ? (patch, collapse) => updateTerminal(element.id, patch, collapse && !data.collapsed) : undefined}
        />
      );
    },
    [session, editor, updateTerminal],
  );

  const validateEmbeddable = useCallback((link: string) => (link.startsWith(TERMINAL_LINK) ? true : undefined), []);

  const everyone = useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const p of peers) if (p.userId !== user.id) seen.set(p.userId, p);
    return [...seen.values()];
  }, [peers, user.id]);

  return (
    <div className="board-page">
      <header className="board-header">
        <button className="btn btn-icon btn-sm" title="Retour" onClick={() => navigate(node.parentId ? `/folder/${node.parentId}` : node.ownerId === user.id ? "/" : "/shared")}>
          <ArrowLeft size={18} />
        </button>
        <BoardTitle name={node.name} editable={editor} onRename={(n) => renameItem(ctx, node.id, n).then(refresh).catch(toast.error)} />
        <span className="save-state" title="Chiffré de bout en bout">
          <Lock size={13} />
        </span>
        <ConnBadge state={conn} />
        {!editor && (
          <span className="badge">
            <Eye size={12} /> Lecture seule
          </span>
        )}
        <div className="spacer" />
        <div className="peers">
          {everyone.slice(0, 5).map((p) => (
            <Avatar key={p.userId} name={p.name} color={p.color} title={`${p.name} est sur le tableau${p.role === "viewer" ? " (lecture)" : ""}`} />
          ))}
          {everyone.length > 5 && (
            <div className="avatar" style={{ background: "var(--muted)" }}>
              +{everyone.length - 5}
            </div>
          )}
        </div>
        {editor && (
          <button ref={termButton} className="btn btn-primary btn-sm" title="Nouveau terminal (Alt+T)" onClick={(e) => setTermMenu(termMenu ? null : e.currentTarget)}>
            <TerminalSquare size={16} /> Terminal
          </button>
        )}
        {node.ownerId === user.id && (
          <button className="btn btn-sm" onClick={() => setSharing(true)}>
            <Share2 size={16} /> Partager
          </button>
        )}
        <button className="btn btn-icon btn-sm" title={theme === "dark" ? "Thème clair" : "Thème sombre"} onClick={toggle}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <div className={`board-canvas ${terminalSelected ? "terminal-selected" : ""}`}>
        <Excalidraw
          excalidrawAPI={setExcalidraw}
          theme={theme}
          langCode="fr-FR"
          name={node.name}
          isCollaborating
          viewModeEnabled={!editor}
          onChange={onChange}
          onPointerUpdate={(p) => session.handlePointer(p as any)}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
          onLinkOpen={(element, event) => {
            if (terminalIdOf(element)) event.preventDefault();
          }}
          UIOptions={{ canvasActions: { saveToActiveFile: false, toggleTheme: true, loadScene: editor } }}
        />
        {conn === "connecting" && <div className="board-overlay">Connexion et déchiffrement…</div>}
        {closed && (
          <div className="board-overlay">
            <div style={{ textAlign: "center" }}>
              <p className="display" style={{ fontSize: 28 }}>
                {closed}
              </p>
              <button className="btn btn-primary" onClick={() => navigate("/")}>
                Retour
              </button>
            </div>
          </div>
        )}
      </div>

      {termMenu && <MachinePicker anchor={termMenu} onClose={() => setTermMenu(null)} onPick={addTerminal} />}
      {sharing && <ShareModal node={node} onClose={() => setSharing(false)} />}
    </div>
  );
}

function BoardTitle({ name, editable, onRename }: { name: string; editable: boolean; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (!editing)
    return (
      <button
        className="board-title"
        title={editable ? "Renommer" : name}
        style={editable ? undefined : { cursor: "default" }}
        onClick={() => {
          if (!editable) return;
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    );
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== name) onRename(draft.trim());
  };
  return (
    <input
      className="board-title"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  if (state === "online")
    return (
      <span className="save-state" title="Synchronisé en temps réel, chiffré de bout en bout">
        <Cloud size={14} /> En direct
      </span>
    );
  if (state === "reconnecting")
    return (
      <span className="save-state" style={{ color: "var(--warn)" }} title="Les modifications seront envoyées à la reconnexion">
        <CloudOff size={14} /> Reconnexion…
      </span>
    );
  if (state === "connecting")
    return (
      <span className="save-state">
        <Loader2 size={14} className="spin" /> Connexion…
      </span>
    );
  return null;
}

function MachinePicker({ anchor, onClose, onPick }: { anchor: HTMLElement; onClose: () => void; onPick: (m: Machine) => void }) {
  const keys = useKeys();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  useEffect(() => {
    listMachines(keys).then(setMachines).catch(toast.error);
  }, [keys]);
  const last = localStorage.getItem(LAST_MACHINE);
  return (
    <Menu anchor={anchor} onClose={onClose} align="right">
      <div className="menu-label">Ouvrir un terminal sur…</div>
      {machines === null && (
        <div className="menu-item" style={{ cursor: "default" }}>
          <Loader2 size={16} className="spin" /> Chargement…
        </div>
      )}
      {machines?.length === 0 && (
        <div style={{ padding: "6px 10px 10px", fontSize: 13, color: "var(--text-2)", maxWidth: 260 }}>
          Aucune machine. Ajoute un agent sur une de tes machines pour ouvrir des terminaux (tu ne peux utiliser que les tiennes).
        </div>
      )}
      {machines?.map((m) => (
        <button key={m.id} className="menu-item" disabled={!m.online} onClick={() => onPick(m)} title={m.online ? undefined : "Hors ligne"}>
          <span className={`dot ${m.online ? "on" : ""}`} />
          <span style={{ flex: 1 }}>
            {m.name}
            {m.hostname && <span style={{ color: "var(--muted)", fontSize: 12 }}> · {m.hostname}</span>}
          </span>
          {m.id === last && <Check size={14} style={{ color: "var(--muted)" }} />}
        </button>
      ))}
      <div className="menu-sep" />
      <Link to="/machines" className="menu-item">
        {machines?.length ? <Server size={16} /> : <Plus size={16} />} Gérer les machines
      </Link>
    </Menu>
  );
}
