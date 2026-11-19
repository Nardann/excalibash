import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CaptureUpdateAction, Excalidraw, newElementWith, sceneCoordsToViewportCoords, useHandleLibrary, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, NonDeleted, ExcalidrawEmbeddableElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { ArrowLeft, Check, Cloud, CloudOff, Eye, Loader2, Lock, Maximize2, Minimize2, Moon, Palette, Plus, Server, Share2, Sun, TerminalSquare } from "lucide-react";
import { useKeys, useUser } from "../auth.tsx";
import { BoardSession, terminalIdOf, type ConnState, type Peer } from "../board/collab.ts";
import { TerminalEmbed } from "../board/TerminalEmbed.tsx";
import { savePreview } from "../board/files.ts";
import { isInTrash, renameItem, useLibrary, useLibraryCtx, type Node } from "../library.tsx";
import { listMachines, type Machine } from "../vault.ts";
import { ShareModal } from "../components/ShareModal.tsx";
import { libraryAdapter, type TileIcon } from "../board/personalLibrary.ts";
import { TileCustomizer, type TilePatch } from "../board/TileCustomizer.tsx";
import { Avatar, Menu, toast, useTheme, type MenuAnchor } from "../components/ui.tsx";
import { NodeTile } from "../board/NodeTile.tsx";
import {
  LINK_BASE,
  TERM_H,
  TERM_W,
  activate,
  addShell,
  createNode,
  deactivate,
  deleteElements,
  findEl,
  hideShell,
  nodeDataOf,
  openWindowOf,
  orphanWindows,
  setNodeLook,
  toggleAll,
  toggleShell,
  windowNodeId,
} from "../board/nodes.ts";

const TILE = 120;
/** Height of the terminal's title bar, in scene units (the window is scaled with the zoom). */
const TERM_HEAD = 32;

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
  const [sharing, setSharing] = useState(false);
  const [terminalSelected, setTerminalSelected] = useState(false);
  /** The single selected (not active) terminal: gets a floating toolbar so it can be reduced without typing in it. */
  const [selTerm, setSelTerm] = useState<{
    id: string;
    kind: "node" | "window" | "legacy";
    left: number;
    top: number;
    collapsed: boolean;
    shells: { id: string; open: boolean }[];
  } | null>(null);
  const selTermRef = useRef(selTerm);
  selTermRef.current = selTerm;
  const [customizing, setCustomizing] = useState<string | null>(null);
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

  /** Machine picker: for a brand-new node (header button, Alt+T) or a new shell on a node. */
  const [picker, setPicker] = useState<{ anchor: MenuAnchor; nodeId?: string } | null>(null);
  /** Shell list of a node with several shells, opened by clicking its icon. */
  const [nodeMenu, setNodeMenu] = useState<{ anchor: MenuAnchor; nodeId: string } | null>(null);

  const newShell = useCallback(
    async (machine: Machine, nodeId?: string) => {
      const x = excalidrawRef.current;
      if (!x) return;
      setPicker(null);
      try {
        const info = await session.createTerminal(machine, 100, 30);
        localStorage.setItem(LAST_MACHINE, machine.id);
        if (nodeId && findEl(x, nodeId) && !findEl(x, nodeId)!.isDeleted) addShell(x, nodeId, info.id);
        else createNode(x, info.id);
      } catch (e) {
        toast.error(e);
      }
    },
    [session],
  );

  /** Where to anchor a menu below an element (viewport coordinates). */
  const anchorBelow = useCallback((id: string): MenuAnchor | null => {
    const x = excalidrawRef.current;
    const el = x && findEl(x, id);
    if (!x || !el) return null;
    const p = sceneCoordsToViewportCoords({ sceneX: el.x, sceneY: el.y + el.height }, x.getAppState());
    return { x: p.x, y: p.y + 6 };
  }, []);

  /** Clicking a node's icon: create its first shell, toggle its only shell, or list its shells. */
  const onNodeActivate = useCallback(
    (nodeId: string) => {
      const x = excalidrawRef.current;
      if (!x) return;
      deactivate(x);
      if (!editor) return;
      const data = nodeDataOf(findEl(x, nodeId));
      if (!data) return;
      const anchor = anchorBelow(nodeId);
      if (data.shells.length === 0) anchor && setPicker({ anchor, nodeId });
      else if (data.shells.length === 1) toggleShell(x, nodeId, data.shells[0].terminalId);
      else anchor && setNodeMenu({ anchor, nodeId });
    },
    [editor, anchorBelow],
  );
  const onNodeActivateRef = useRef(onNodeActivate);
  onNodeActivateRef.current = onNodeActivate;

  // Alt+T: new machine node + shell on the last machine used (or open the picker).
  useEffect(() => {
    if (!editor) return;
    const onKey = async (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyT" || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const last = localStorage.getItem(LAST_MACHINE);
      const m = (await listMachines(keys)).find((x) => x.id === last && x.online);
      if (m) newShell(m);
      else if (termButton.current) setPicker({ anchor: termButton.current });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [newShell, editor, keys]);

  /** Alt+R / toolbar / title double-click: the "reduce" action for whatever is selected. */
  const reduce = useCallback((id: string) => {
    const x = excalidrawRef.current;
    const el = x && findEl(x, id);
    if (!x || !el) return;
    if (nodeDataOf(el)) toggleAll(x, id);
    else if (windowNodeId(el)) hideShell(x, id);
    else updateTerminalRef.current?.(id, null, true);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyR" || e.ctrlKey || e.metaKey || !selTermRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      reduce(selTermRef.current.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editor, reduce]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      session.handleChange(elements, files);
      if (appState.theme !== theme) toggle();
      const selected = Object.keys(appState.selectedElementIds);
      const el = selected.length === 1 ? elements.find((e) => e.id === selected[0]) : undefined;
      const tid = terminalIdOf(el);
      const nd = nodeDataOf(el);
      setTerminalSelected(!!tid || !!nd);
      const active = appState.activeEmbeddable?.element.id === el?.id && appState.activeEmbeddable?.state === "active";
      const x = excalidrawRef.current;
      const next =
        el && (tid || nd) && !el.isDeleted && !active && !appState.isResizing && !appState.isRotating
          ? {
              id: el.id,
              kind: nd ? ("node" as const) : windowNodeId(el) ? ("window" as const) : ("legacy" as const),
              left: Math.round((el.x + el.width + appState.scrollX) * appState.zoom.value),
              top: Math.round((el.y + appState.scrollY) * appState.zoom.value),
              collapsed: !!(el.customData as TileData | undefined)?.collapsed,
              shells: nd ? nd.shells.map((s) => ({ id: s.terminalId, open: !!(x && openWindowOf(x, s.terminalId)) })) : [],
            }
          : null;
      setSelTerm((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      // A node was deleted (here or by someone else): its windows go with it.
      if (editor && x) {
        const orphans = orphanWindows(elements);
        if (orphans.length) setTimeout(() => deleteElements(x, orphans), 0);
      }
    },
    [session, theme, toggle, editor],
  );

  /**
   * Standalone (older) terminals: window ⇄ tile on the same element (size + customData: collapsed
   * flag, remembered sizes, label, library icon). Synced encrypted and undoable.
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
    if (toggle && !collapse) activate(x, elementId);
  }, []);

  /** Double-click on a terminal's title bar hides / reduces it, whether active or just selected. */
  const onCanvasDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const x = excalidrawRef.current;
      if (!x || !editor || (e.target as HTMLElement).closest("button")) return;
      const { x: sx, y: sy } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, x.getAppState());
      const hit = [...x.getSceneElements()]
        .reverse()
        .find(
          (el) =>
            terminalIdOf(el) &&
            !(el.customData as TileData).collapsed &&
            sx >= el.x &&
            sx <= el.x + el.width &&
            sy >= el.y &&
            sy <= el.y + TERM_HEAD,
        );
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation(); // keep Excalidraw from treating it as "edit / enter element"
      reduce(hit.id);
    },
    [editor, reduce],
  );

  const updateTerminalRef = useRef(updateTerminal);
  updateTerminalRef.current = updateTerminal;

  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>, appState: AppState) => {
      const active = appState.activeEmbeddable?.element.id === element.id && appState.activeEmbeddable.state === "active";
      const x = excalidrawRef.current;
      const nd = nodeDataOf(element);
      if (nd) {
        return (
          <NodeTile
            session={session}
            shells={nd.shells.map((s) => s.terminalId)}
            openCount={x ? nd.shells.filter((s) => openWindowOf(x, s.terminalId)).length : 0}
            title={nd.title}
            icon={nd.icon}
            active={active}
            onActivate={() => onNodeActivateRef.current(element.id)}
          />
        );
      }
      const tid = terminalIdOf(element);
      if (!tid) return null;
      const nodeId = windowNodeId(element);
      if (nodeId) {
        const owner = nodeDataOf(x ? findEl(x, nodeId) : undefined);
        return (
          <TerminalEmbed
            session={session}
            terminalId={tid}
            active={active}
            collapsed={false}
            title={owner?.title?.split("\n")[0] ?? null}
            onToggleCollapsed={editor ? () => hideShell(excalidrawRef.current!, element.id) : undefined}
            toggleTitle="Masquer (le shell continue, l'icône reste sur le schéma)"
          />
        );
      }
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

  const validateEmbeddable = useCallback((link: string) => (link.startsWith(LINK_BASE) ? true : undefined), []);

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
          <button ref={termButton} className="btn btn-primary btn-sm" title="Nouvelle machine + shell (Alt+T)" onClick={(e) => setPicker(picker ? null : { anchor: e.currentTarget })}>
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

      <div className={`board-canvas ${terminalSelected ? "terminal-selected" : ""}`} onDoubleClickCapture={onCanvasDoubleClick}>
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
            if (terminalIdOf(element) || nodeDataOf(element)) event.preventDefault();
          }}
          UIOptions={{ canvasActions: { saveToActiveFile: false, toggleTheme: true, loadScene: editor } }}
        />
        {selTerm && editor && (
          <div className="term-float" style={{ left: selTerm.left, top: selTerm.top }}>
            {selTerm.kind === "node" ? (
              <>
                {selTerm.shells.map((sh, i) => {
                  const t = session.terminals.get(sh.id);
                  return (
                    <button
                      key={sh.id}
                      className="chip"
                      aria-pressed={sh.open}
                      title={`${sh.open ? "Masquer" : "Ouvrir"} le shell ${i + 1} (${t?.label ?? "?"})`}
                      onClick={() => toggleShell(excalidrawRef.current!, selTerm.id, sh.id)}
                    >
                      <span className={`dot ${t?.status === "running" ? "on" : t?.status === "starting" ? "warn" : ""}`} />
                      <span className="lbl">
                        {i + 1}. {t?.label ?? "shell"}
                      </span>
                    </button>
                  );
                })}
                <button title="Nouveau shell sur cette icône" onClick={() => setPicker({ anchor: anchorBelow(selTerm.id) ?? { x: 0, y: 0 }, nodeId: selTerm.id })}>
                  <Plus size={14} />
                </button>
                <span className="sep" />
                <button title="Icône et libellé" onClick={() => setCustomizing(selTerm.id)}>
                  <Palette size={14} />
                </button>
              </>
            ) : selTerm.kind === "window" ? (
              <button onClick={() => reduce(selTerm.id)} title="Masquer la fenêtre (le shell continue) — Alt+R ou double-clic sur la barre">
                <Minimize2 size={14} /> Masquer
              </button>
            ) : (
              <>
                <button onClick={() => updateTerminal(selTerm.id, null, true)} title={`${selTerm.collapsed ? "Ouvrir le terminal" : "Réduire en tuile"} (Alt+R)`}>
                  {selTerm.collapsed ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
                  {selTerm.collapsed ? "Ouvrir" : "Réduire"}
                </button>
                <button onClick={() => setCustomizing(selTerm.id)} title="Icône et libellé de la tuile">
                  <Palette size={14} />
                </button>
              </>
            )}
          </div>
        )}
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

      {customizing &&
        (() => {
          const x = excalidrawRef.current;
          const el = x?.getSceneElements().find((e) => e.id === customizing);
          const nd = nodeDataOf(el);
          if (nd) {
            const label = (nd.shells[0] && session.terminals.get(nd.shells[0].terminalId)?.label) || "Machine";
            return (
              <TileCustomizer
                node
                machineLabel={label}
                title={nd.title ?? null}
                icon={nd.icon ?? null}
                onSave={(look) => x && setNodeLook(x, customizing, look)}
                onClose={() => setCustomizing(null)}
              />
            );
          }
          const data = (el?.customData ?? {}) as TileData;
          const label = (data.terminalId && session.terminals.get(data.terminalId)?.label) || "Terminal";
          return (
            <TileCustomizer
              machineLabel={label}
              title={data.title ?? null}
              icon={data.icon ?? null}
              onSave={(patch, collapse) => updateTerminal(customizing, patch, collapse && !data.collapsed)}
              onClose={() => setCustomizing(null)}
            />
          );
        })()}
      {picker && <MachinePicker anchor={picker.anchor} onClose={() => setPicker(null)} onPick={(m) => newShell(m, picker.nodeId)} />}
      {nodeMenu && (
        <NodeMenu
          session={session}
          nodeId={nodeMenu.nodeId}
          anchor={nodeMenu.anchor}
          api={excalidrawRef.current}
          onClose={() => setNodeMenu(null)}
          onNewShell={() => {
            setPicker({ anchor: nodeMenu.anchor, nodeId: nodeMenu.nodeId });
            setNodeMenu(null);
          }}
          onCustomize={() => {
            setCustomizing(nodeMenu.nodeId);
            setNodeMenu(null);
          }}
        />
      )}
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

function MachinePicker({ anchor, onClose, onPick }: { anchor: MenuAnchor; onClose: () => void; onPick: (m: Machine) => void }) {
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

/** The shells of a node: open / hide each one, all at once, or add one. */
function NodeMenu(p: {
  session: BoardSession;
  nodeId: string;
  anchor: MenuAnchor;
  api: ExcalidrawImperativeAPI | null;
  onClose: () => void;
  onNewShell: () => void;
  onCustomize: () => void;
}) {
  const api = p.api;
  const data = api ? nodeDataOf(findEl(api, p.nodeId)) : undefined;
  if (!api || !data) return null;
  const anyOpen = data.shells.some((s) => openWindowOf(api, s.terminalId));
  return (
    <Menu anchor={p.anchor} onClose={p.onClose}>
      <div className="menu-label">{data.title?.split("\n")[0] || "Shells"}</div>
      {data.shells.map((sh, i) => {
        const t = p.session.terminals.get(sh.terminalId);
        const open = !!openWindowOf(api, sh.terminalId);
        return (
          <button
            key={sh.terminalId}
            className={`menu-item ${open ? "selected" : ""}`}
            onClick={() => {
              p.onClose();
              toggleShell(api, p.nodeId, sh.terminalId);
            }}
          >
            <span className={`dot ${t?.status === "running" ? "on" : t?.status === "starting" ? "warn" : ""}`} />
            <span style={{ flex: 1 }}>
              Shell {i + 1} · {t?.label ?? "?"}
            </span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{open ? "ouvert" : "masqué"}</span>
          </button>
        );
      })}
      <div className="menu-sep" />
      <button
        className="menu-item"
        onClick={() => {
          p.onClose();
          toggleAll(api, p.nodeId);
        }}
      >
        {anyOpen ? <Minimize2 size={16} /> : <Maximize2 size={16} />} {anyOpen ? "Tout masquer" : "Tout ouvrir"}
      </button>
      <button className="menu-item" onClick={p.onNewShell}>
        <Plus size={16} /> Nouveau shell
      </button>
      <button className="menu-item" onClick={p.onCustomize}>
        <Palette size={16} /> Icône et libellé…
      </button>
    </Menu>
  );
}
