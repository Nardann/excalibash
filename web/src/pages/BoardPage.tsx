import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CaptureUpdateAction, Excalidraw, newElementWith, sceneCoordsToViewportCoords, useHandleLibrary, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, NonDeleted, ExcalidrawEmbeddableElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { ArrowLeft, Cable, Check, Cloud, CloudOff, Download, Eye, Globe, Loader2, Lock, Maximize2, Minimize2, Moon, Palette, Plus, Server, Share2, Spline, Sun, TerminalSquare } from "lucide-react";
import { useKeys, useUser } from "../auth.tsx";
import { BoardSession, isRemoteLabel, terminalIdOf, type ConnState, type Peer } from "../board/collab.ts";
import { TerminalEmbed } from "../board/TerminalEmbed.tsx";
import { savePreview } from "../board/files.ts";
import { isInTrash, renameItem, useLibrary, useLibraryCtx, type Node } from "../library.tsx";
import { linkMachine, listMachines, setMachineBoard, syncBoardLinks, type Machine } from "../vault.ts";
import { ShareModal } from "../components/ShareModal.tsx";
import { libraryAdapter, type TileIcon } from "../board/personalLibrary.ts";
import { TileCustomizer, type TilePatch } from "../board/TileCustomizer.tsx";
import { Avatar, Menu, Modal, confirmDialog, toast, useTheme, type MenuAnchor } from "../components/ui.tsx";
import { NodeTile } from "../board/NodeTile.tsx";
import { WebEmbed } from "../board/WebEmbed.tsx";
import { WindowDock, type DockGroup } from "../board/WindowDock.tsx";
import { cableEnds, cableOf, finishCable, maintainCables, setCableEnd, type End } from "../board/cables.ts";
import { CableEndForm, CableOverlay, type CableMark } from "../board/CableOverlay.tsx";
import { PointTrash } from "../board/PointTrash.tsx";
import { planKey, planProbes, runProbes, type LinkStates } from "../board/linkStatus.ts";
import { exportDiagram, exportTopology, type TopologyFormat } from "../board/exportDiagram.ts";
import { FormFrame, HOST_RE, MachineField, RemoteForm, useMachineChoice } from "../board/RemoteForm.tsx";
import type { RemoteTarget } from "../api.ts";
import {
  LINK_BASE,
  TERM_H,
  TERM_W,
  activate,
  addShell,
  addWeb,
  bringToFront,
  createNode,
  deactivate,
  deleteElements,
  findEl,
  hideShell,
  nodeDataOf,
  openWeb,
  openShell,
  openWebWindowOf,
  openWindowOf,
  orphanWindows,
  removeShell,
  removeWeb,
  setNodeLook,
  setWindowLocked,
  toggleAll,
  toggleShell,
  toggleWeb,
  windowNodeId,
  migrateLegacyTerminals,
  type RemoteRef,
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
    webs: { id: string; open: boolean }[];
    /** A Telnet / SSH device: no agent on it, so nothing can be reached through it. */
    remote: boolean;
  } | null>(null);
  const selTermRef = useRef(selTerm);
  selTermRef.current = selTerm;
  const [customizing, setCustomizing] = useState<string | null>(null);
  /** Every machine icon with its shells and sites, for the side dock. */
  const [dock, setDock] = useState<DockGroup[]>([]);
  /** Cable tool: the arrow tool with cable styling; the next arrow drawn becomes a cable. */
  const [cableMode, setCableMode] = useState(false);
  const cableModeRef = useRef(false);
  const pendingCable = useRef<string | null>(null);
  /** Arrow styling to give back when the cable tool ends. */
  const savedArrow = useRef<Partial<AppState> | null>(null);
  const cableFrame = useRef<number | null>(null);
  const cableKey = useRef(-1);
  /** Ends of the cables with something to show (or of the selected cable), in viewport coordinates. */
  const [cableMarks, setCableMarks] = useState<CableMark[]>([]);
  const [cableEdit, setCableEdit] = useState<{ cableId: string; end: End } | null>(null);
  const [cableZoom, setCableZoom] = useState(1);
  /** Reachability of the IPs at the cable ends, and where each cable's state badge goes. */
  const [links, setLinks] = useState<LinkStates>({});
  /** "Exporter" menu (PNG / SVG of the diagram, labels included). */
  const [exportMenu, setExportMenu] = useState<MenuAnchor | null>(null);
  // Display name of a machine icon, as drawn on the diagram (image and topology exports).
  const exportNameOf = (x: NonNullable<typeof excalidrawRef.current>) => (id: string) => {
    const nd = nodeDataOf(findEl(x, id));
    const shell = nd?.shells[0] && session.terminals.get(nd.shells[0].terminalId)?.label;
    return nd?.title?.split("\n")[0] || nd?.machineName || shell || "Machine";
  };
  const [cableMids, setCableMids] = useState<{ cableId: string; x: number; y: number }[]>([]);
  /** Last window raised, so it is raised once per focus and not on every change. */
  const frontRef = useRef<string | null>(null);
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

  // Machines their owners linked to this board are offered to its editors too (see vault.ts).
  useEffect(() => {
    setMachineBoard(editor ? { id: node.id, key: node.key! } : null);
    return () => setMachineBoard(null);
  }, [node.id, node.key, editor]);

  // Our machines get linked to this board when we open a shell or a site on them (linkMachine);
  // here the links are kept in step: removed once the machine has no session here, refreshed
  // after a rename, restored after a key rotation.
  useEffect(() => {
    if (!editor || !excalidraw || conn !== "online") return;
    let last = "";
    let running = false;
    const sync = async () => {
      if (running) return;
      const mine = (m: { machineOwnerId: string | null; machineId: string }) => m.machineOwnerId === user.id;
      const used = new Set([...session.terminals.values()].filter(mine).map((t) => t.machineId).concat([...session.webs.values()].filter(mine).map((w) => w.machineId)));
      const key = JSON.stringify([...used].sort());
      if (key === last) return;
      running = true;
      try {
        await syncBoardLinks(keys, { id: node.id, key: node.key! }, used);
        last = key;
      } catch {
        // Try again on the next change or tick.
      } finally {
        running = false;
      }
    };
    const off = session.on("terminals", () => void sync());
    const timer = setInterval(sync, 30_000);
    void sync();
    return () => {
      off();
      clearInterval(timer);
    };
  }, [editor, excalidraw, conn, session, keys, user.id, node.id, node.key]);

  // Once the scene is in, convert terminals from before machine icons existed (editors only).
  const migrated = useRef(false);
  useEffect(() => {
    if (!editor || !excalidraw || conn !== "online" || migrated.current) return;
    const t = setTimeout(() => {
      migrated.current = true;
      const n = migrateLegacyTerminals(excalidraw);
      if (n) toast(`${n} ancien${n > 1 ? "s" : ""} terminal${n > 1 ? "aux" : ""} converti${n > 1 ? "s" : ""} : l'icône reste maintenant en place.`);
    }, 300);
    return () => clearTimeout(t);
  }, [editor, excalidraw, conn]);

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
  /**
   * "Add" dialog: a Telnet / SSH session or a web view. On a node both are offered as tabs; from
   * the machine picker (no node yet) only the Telnet / SSH form, since it creates its node.
   */
  const [access, setAccess] = useState<{
    nodeId?: string;
    kind: "remote" | "web";
    /** A new session to a device icon's own device: the Telnet / SSH form alone, prefilled. */
    device?: RemoteRef;
  } | null>(null);

  const newShell = useCallback(
    async (machine: Machine, nodeId?: string, target?: RemoteTarget) => {
      const x = excalidrawRef.current;
      if (!x) return;
      setPicker(null);
      try {
        const info = await session.createTerminal(machine, 100, 30, target);
        linkMachine({ id: session.boardId, key: session.key }, machine).catch(() => {});
        localStorage.setItem(LAST_MACHINE, machine.id);
        const near = nodeId ? findEl(x, nodeId) : undefined;
        const owner = near && !near.isDeleted ? near : undefined;
        if (target) {
          // A device gets an icon of its own, like a machine with an agent; sessions to the
          // same device (another port, user or protocol) gather on that icon.
          const rem = nodeDataOf(owner)?.remote;
          if (owner && rem && rem.machineId === machine.id && rem.target.host === target.host) addShell(x, owner.id, info.id);
          else createNode(x, info.id, { near: owner, title: target.host, remote: { machineId: machine.id, target } });
        } else if (owner) addShell(x, owner.id, info.id, machine.id, machine.name);
        else createNode(x, info.id, { machineId: machine.id, machineName: machine.name });
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
      const webs = data.webs ?? [];
      // No shell yet: an icon that knows its machine (or its device) opens its own menu, whose
      // "new shell" goes there; only an icon with no known machine asks which one.
      if (data.shells.length + webs.length === 0) anchor && (nodeMachineId(nodeId) ? setNodeMenu({ anchor, nodeId }) : setPicker({ anchor, nodeId }));
      else if (data.shells.length === 1 && !webs.length) toggleShell(x, nodeId, data.shells[0].terminalId);
      else if (webs.length === 1 && !data.shells.length) toggleWeb(x, nodeId, webs[0].webId);
      else anchor && setNodeMenu({ anchor, nodeId });
    },
    [editor, anchorBelow],
  );
  /** The machine a node already talks to (through its shells or sites), so new views default to it. */
  /** The machine name of a local shell (its label), for an icon about to lose its last shell. */
  const shellMachineName = (terminalId: string) => {
    const label = session.terminals.get(terminalId)?.label;
    return label && !isRemoteLabel(label) ? label : undefined;
  };
  /** The machine of a node's running shells or sites, as the server reports them. */
  const liveMachineId = (nodeId: string): string | null => {
    const x = excalidrawRef.current;
    const data = x && nodeDataOf(findEl(x, nodeId));
    if (!data) return null;
    for (const sh of data.shells) {
      const t = session.terminals.get(sh.terminalId);
      if (t) return t.machineId;
    }
    for (const w of data.webs ?? []) {
      const v = session.webs.get(w.webId);
      if (v) return v.machineId;
    }
    return null;
  };
  const liveMachineRef = useRef(liveMachineId);
  liveMachineRef.current = liveMachineId;
  /**
   * The machine a node talks to: its live shells' or sites', else the one it remembers. What it
   * remembers is board data, which any editor can write: a default for forms the user submits,
   * never a machine to open a session on without asking.
   */
  const nodeMachineId = (nodeId: string): string | null => {
    const x = excalidrawRef.current;
    const data = x && nodeDataOf(findEl(x, nodeId));
    if (!data) return null;
    return liveMachineId(nodeId) ?? data.remote?.machineId ?? data.machineId ?? null;
  };
  /**
   * New shell on a node, on the machine it already uses. A device's icon opens the Telnet / SSH
   * form prefilled with its device (the target comes from the board, so the user checks and
   * submits it). A machine known only from the icon's memory is confirmed first, named from the
   * user's own machine list. The picker opens when the node has no machine, or it is offline.
   */
  const newShellOnNode = async (nodeId: string, anchor: MenuAnchor) => {
    const x = excalidrawRef.current;
    const data = x ? nodeDataOf(findEl(x, nodeId)) : undefined;
    if (data?.remote) return setAccess({ nodeId, kind: "remote", device: data.remote });
    const live = liveMachineId(nodeId);
    const machineId = live ?? data?.machineId;
    if (machineId) {
      try {
        const m = (await listMachines(keys)).find((x) => x.id === machineId);
        if (m?.online) {
          const ok =
            !!live ||
            (await confirmDialog({
              title: `Ouvrir un shell sur ${m.name} ?`,
              text:
                m.access === "owner"
                  ? `Le shell s'ouvre sur ta machine ${m.name}, et les éditeurs de ce tableau pourront s'en servir.`
                  : `Le shell s'ouvre sur ${m.name}, la machine de ${m.ownerName ?? "quelqu'un d'autre"}, et les éditeurs de ce tableau pourront s'en servir.`,
              confirm: "Ouvrir",
            }));
          if (ok) newShell(m, nodeId);
          return;
        }
        toast(m ? `${m.name} est hors ligne : choisis une autre machine` : "Machine introuvable : choisis-en une autre");
      } catch (e) {
        toast.error(e);
      }
    }
    setPicker({ anchor, nodeId });
  };
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

  const startCable = useCallback(() => {
    const x = excalidrawRef.current;
    if (!x) return;
    const st = x.getAppState();
    if (!cableModeRef.current)
      savedArrow.current = { currentItemStartArrowhead: st.currentItemStartArrowhead, currentItemEndArrowhead: st.currentItemEndArrowhead, currentItemArrowType: st.currentItemArrowType, currentItemRoughness: st.currentItemRoughness };
    cableModeRef.current = true;
    pendingCable.current = null;
    setCableMode(true);
    x.updateScene({ appState: { currentItemStartArrowhead: null, currentItemEndArrowhead: null, currentItemArrowType: "round", currentItemRoughness: 0 } as any, captureUpdate: CaptureUpdateAction.NEVER });
    x.setActiveTool({ type: "arrow" });
  }, []);
  const stopCable = useCallback(() => {
    const x = excalidrawRef.current;
    cableModeRef.current = false;
    pendingCable.current = null;
    setCableMode(false);
    if (x && savedArrow.current) x.updateScene({ appState: savedArrow.current as any, captureUpdate: CaptureUpdateAction.NEVER });
    savedArrow.current = null;
  }, []);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      session.handleChange(elements, files);
      const xc = excalidrawRef.current;
      if (cableModeRef.current && xc) {
        if (appState.newElement?.type === "arrow") pendingCable.current = appState.newElement.id;
        const idle = !appState.newElement && !appState.multiElement && appState.cursorButton === "up";
        if (idle && pendingCable.current) {
          const id = pendingCable.current;
          pendingCable.current = null;
          setTimeout(() => {
            const err = finishCable(xc, id);
            if (err) toast.error(err);
            stopCable();
          }, 0);
        } else if (idle && appState.activeTool.type !== "arrow") stopCable();
      }
      // Interface / IP / VLAN labels at the cable ends, and the "int" buttons of the selected cable.
      const zoom = appState.zoom.value;
      const marks: CableMark[] = [];
      if (zoom >= 0.35) {
        for (const e of elements) {
          const c = !e.isDeleted ? cableOf(e) : undefined;
          if (!c) continue;
          const sel = Object.keys(appState.selectedElementIds);
          const isSel = sel.length === 1 && sel[0] === e.id && !appState.newElement;
          for (const en of cableEnds(e)) {
            const info = c.ends?.[en.end];
            if (!info && !isSel) continue;
            marks.push({
              cableId: e.id,
              end: en.end,
              x: Math.round((en.p.x + appState.scrollX) * zoom),
              y: Math.round((en.p.y + appState.scrollY) * zoom),
              dir: { x: Math.round(en.dir.x * 1000) / 1000, y: Math.round(en.dir.y * 1000) / 1000 },
              info,
              selected: isSel,
            });
          }
        }
      }
      setCableMarks((prev) => (JSON.stringify(prev) === JSON.stringify(marks) ? prev : marks));
      setCableZoom(zoom);
      // The middle of each cable with an IP at one end: where its live state shows.
      const mids: { cableId: string; x: number; y: number }[] = [];
      if (zoom >= 0.35) {
        for (const e of elements) {
          const c = !e.isDeleted ? cableOf(e) : undefined;
          if (!c || !(c.ends?.a?.ip || c.ends?.b?.ip) || !("points" in e)) continue;
          const pts = e.points;
          const n = pts.length;
          const [px, py] = n % 2 ? pts[(n - 1) / 2] : [(pts[n / 2 - 1][0] + pts[n / 2][0]) / 2, (pts[n / 2 - 1][1] + pts[n / 2][1]) / 2];
          mids.push({ cableId: e.id, x: Math.round((e.x + px + appState.scrollX) * zoom), y: Math.round((e.y + py + appState.scrollY) * zoom) });
        }
      }
      setCableMids((prev) => (JSON.stringify(prev) === JSON.stringify(mids) ? prev : mids));
      // Cables follow their items (and go with them): settled once per frame, and only when the
      // scene (or the pointer, which ends a drag) changed since the last pass.
      let sceneKey = appState.cursorButton === "down" ? 1 : 0;
      for (const e of elements) sceneKey += e.version;
      const changedScene = sceneKey !== cableKey.current;
      cableKey.current = sceneKey;
      if (editor && xc && changedScene && cableFrame.current === null) {
        cableFrame.current = requestAnimationFrame(() => {
          cableFrame.current = null;
          maintainCables(xc);
        });
      }
      if (appState.theme !== theme) toggle();
      const selected = Object.keys(appState.selectedElementIds);
      const el = selected.length === 1 ? elements.find((e) => e.id === selected[0]) : undefined;
      const tid = terminalIdOf(el) ?? ((el?.customData as any)?.webId as string | undefined);
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
              webs: nd ? (nd.webs ?? []).map((w) => ({ id: w.webId, open: !!(x && openWebWindowOf(x, w.webId)) })) : [],
              remote: !!nd?.remote,
            }
          : null;
      setSelTerm((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      // The window being used (active, or just selected) goes above the windows it overlaps.
      const isWindow = (e?: ExcalidrawElement) => !!e && !e.isDeleted && !nodeDataOf(e) && !!(terminalIdOf(e) || (e.customData as any)?.webId);
      const activeEl = appState.activeEmbeddable?.state === "active" ? appState.activeEmbeddable.element : undefined;
      const focusId = isWindow(activeEl) ? activeEl!.id : isWindow(el) ? el!.id : null;
      if (focusId !== frontRef.current) {
        frontRef.current = focusId;
        if (editor && x && focusId) {
          const wasActive = activeEl?.id === focusId;
          setTimeout(() => {
            if (bringToFront(x, focusId) && wasActive) activate(x, focusId);
          }, 0);
        }
      }
      // The dock is for editors only (it opens, hides and closes windows).
      if (x && editor) {
        const groups: DockGroup[] = elements
          .filter((e) => !e.isDeleted && nodeDataOf(e))
          .map((e) => {
            const nd = nodeDataOf(e)!;
            return {
              nodeId: e.id,
              title: nd.title?.split("\n")[0] || null,
              shells: nd.shells.map((s) => ({ id: s.terminalId, open: !!openWindowOf(x, s.terminalId) })),
              webs: (nd.webs ?? []).map((w) => ({ id: w.webId, open: !!openWebWindowOf(x, w.webId) })),
              remote: !!nd.remote,
              machineName: nd.machineName,
            };
          })
          .filter((g) => g.shells.length + g.webs.length > 0);
        setDock((prev) => (JSON.stringify(prev) === JSON.stringify(groups) ? prev : groups));
      }
      // A node was deleted (here or by someone else): its windows go with it.
      if (editor && x) {
        const orphans = orphanWindows(elements);
        if (orphans.length) setTimeout(() => deleteElements(x, orphans), 0);
      }
    },
    [session, theme, toggle, editor, stopCable],
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

  // Live state of the cables: the IPs at their ends are pinged from the user's own machines at
  // the other ends (see board/linkStatus.ts), as soon as cables or IPs change, else every 10 s,
  // and not while the tab is in the background.
  useEffect(() => {
    if (!excalidraw) return;
    let stopped = false;
    let running = false;
    let lastKey = "";
    let lastRun = 0;
    let machines: Machine[] | null = null;
    let machinesAt = 0;
    const tick = async () => {
      if (stopped || running || document.visibilityState === "hidden") return;
      const inUse = new Set([...session.terminals.values()].map((t) => t.machineId).concat([...session.webs.values()].map((w) => w.machineId)));
      const plan = planProbes(excalidraw, (id) => liveMachineRef.current(id), inUse);
      const key = planKey(plan);
      if (!plan.size) {
        if (lastKey) setLinks({});
        lastKey = "";
        return;
      }
      if (key === lastKey && Date.now() - lastRun < 10_000) return;
      running = true;
      try {
        if (!machines || Date.now() - machinesAt > 60_000) {
          machines = await listMachines(keys);
          machinesAt = Date.now();
        }
        const states = await runProbes(plan, machines, node.id);
        if (!stopped) setLinks((prev) => (JSON.stringify(prev) === JSON.stringify(states) ? prev : states));
        lastKey = key;
        lastRun = Date.now();
      } catch {
        // Machines unavailable: try again on the next tick.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(tick, 2000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [excalidraw, keys, session]);

  // A click in a terminal's shell area (below its title bar) opens it for typing right away:
  // without this, Excalidraw only selects the window and wants a second click to activate it.
  // The title bar keeps selecting and moving the window.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const x = excalidrawRef.current;
      if (!x || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!(e.target instanceof HTMLCanvasElement) || !e.target.closest(".board-canvas")) return;
      const st = x.getAppState();
      if (st.activeTool.type !== "selection") return;
      const { x: sx, y: sy } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, st);
      // The topmost window under the pointer, as drawn.
      const hit = [...x.getSceneElements()]
        .reverse()
        .find((el) => el.type === "embeddable" && sx >= el.x && sx <= el.x + el.width && sy >= el.y && sy <= el.y + el.height);
      if (!hit || !terminalIdOf(hit) || nodeDataOf(hit) || (hit.customData as TileData | undefined)?.collapsed) return;
      // The title bar selects and moves the window, except when it is locked: then any click
      // opens the shell (and its title bar buttons), since the window can't be selected.
      if (sy <= hit.y + TERM_HEAD && !hit.locked) return;
      if (st.activeEmbeddable?.element.id === hit.id && st.activeEmbeddable.state === "active") return;
      e.preventDefault();
      e.stopPropagation();
      if (editor) bringToFront(x, hit.id);
      activate(x, hit.id);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [editor]);

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
            (terminalIdOf(el) || (el.customData as any)?.webId) &&
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
            webCount={(nd.webs ?? []).length}
            machineName={nd.machineName}
            remote={!!nd.remote}
            openCount={x ? nd.shells.filter((s) => openWindowOf(x, s.terminalId)).length + (nd.webs ?? []).filter((w) => openWebWindowOf(x, w.webId)).length : 0}
            title={nd.title}
            icon={nd.icon}
            active={active}
            onActivate={() => onNodeActivateRef.current(element.id)}
          />
        );
      }
      const webId = (element.customData as any)?.webId as string | undefined;
      if (webId) {
        const nid = windowNodeId(element);
        const owner = nodeDataOf(x && nid ? findEl(x, nid) : undefined);
        return (
          <WebEmbed
            session={session}
            webId={webId}
            active={active}
            title={owner?.title?.split("\n")[0] ?? null}
            onHide={editor && nid ? () => hideShell(excalidrawRef.current!, element.id) : undefined}
            onRemove={
              editor
                ? () => {
                    session.closeWeb(webId);
                    if (nid) removeWeb(excalidrawRef.current!, nid, webId);
                  }
                : undefined
            }
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
            locked={element.locked}
            onToggleLock={editor ? () => setWindowLocked(excalidrawRef.current!, element.id, !element.locked) : undefined}
            onKill={() => {
              session.closeTerminal(tid);
              if (excalidrawRef.current) removeShell(excalidrawRef.current, nodeId, tid, shellMachineName(tid));
            }}
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
          <button
            className={`btn btn-sm ${cableMode ? "btn-primary" : ""}`}
            aria-pressed={cableMode}
            title="Câble : relie deux éléments (formes, éléments de bibliothèque, machines). Tire-le d'un élément à l'autre."
            onClick={() => (cableMode ? (excalidrawRef.current?.setActiveTool({ type: "selection" }), stopCable()) : startCable())}
          >
            <Spline size={16} /> Câble
          </button>
        )}
        {editor && (
          <button ref={termButton} className="btn btn-primary btn-sm" title="Nouvelle machine + shell (Alt+T)" onClick={(e) => setPicker(picker ? null : { anchor: e.currentTarget })}>
            <TerminalSquare size={16} /> Terminal
          </button>
        )}
        <button className="btn btn-icon btn-sm" title="Exporter le schéma (image, topologie Containerlab, Mermaid, JSON)" onClick={(e) => setExportMenu(exportMenu ? null : e.currentTarget)}>
          <Download size={16} />
        </button>
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
            if (element.link?.startsWith(LINK_BASE)) event.preventDefault();
          }}
          UIOptions={{ canvasActions: { saveToActiveFile: false, toggleTheme: true, loadScene: editor } }}
        />
        {editor && dock.length > 0 && (
          <WindowDock
            session={session}
            groups={dock}
            onOpen={(nodeId, kind, id) => {
              const x = excalidrawRef.current;
              if (!x) return;
              const win = kind === "web" ? openWebWindowOf(x, id) : openWindowOf(x, id);
              if (win) {
                // Already open: bring it into view and to the front.
                x.scrollToContent(win, { animate: true });
                bringToFront(x, win.id);
                activate(x, win.id);
              } else if (kind === "web") openWeb(x, nodeId, id);
              else openShell(x, nodeId, id);
            }}
            onHide={(kind, id) => {
              const x = excalidrawRef.current;
              const win = x && (kind === "web" ? openWebWindowOf(x, id) : openWindowOf(x, id));
              if (x && win) hideShell(x, win.id);
            }}
            onToggleAll={(nodeId) => excalidrawRef.current && toggleAll(excalidrawRef.current, nodeId)}
            onAdd={(nodeId) => setAccess({ nodeId, kind: "remote" })}
            onAddShell={(nodeId, anchor) => void newShellOnNode(nodeId, anchor)}
            onKill={(nodeId, kind, id) => {
              const x = excalidrawRef.current;
              if (kind === "terminal") {
                session.closeTerminal(id);
                if (x) removeShell(x, nodeId, id, shellMachineName(id));
              } else {
                session.closeWeb(id);
                if (x) removeWeb(x, nodeId, id);
              }
            }}
          />
        )}
        <PointTrash api={excalidraw} editable={editor} />
        <CableOverlay
          marks={cableMarks}
          zoom={cableZoom}
          editable={editor}
          onEdit={(m) => setCableEdit({ cableId: m.cableId, end: m.end })}
          onMoveLabel={(m, dx, dy) => excalidrawRef.current && m.info && setCableEnd(excalidrawRef.current, m.cableId, m.end, { ...m.info, dx, dy })}
          links={links}
          mids={cableMids}
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
                {selTerm.webs.map((w) => {
                  const info = session.webs.get(w.id);
                  return (
                    <button
                      key={w.id}
                      className="chip"
                      aria-pressed={w.open}
                      title={`${w.open ? "Masquer" : "Ouvrir"} ${info?.target?.url ?? "le site"}`}
                      onClick={() => toggleWeb(excalidrawRef.current!, selTerm.id, w.id)}
                    >
                      <Globe size={13} />
                      <span className="lbl">{info?.target?.url.replace(/^https?:\/\//, "") ?? "site"}</span>
                    </button>
                  );
                })}
                <button title="Nouveau shell sur cette icône" onClick={() => void newShellOnNode(selTerm.id, anchorBelow(selTerm.id) ?? { x: 0, y: 0 })}>
                  <TerminalSquare size={14} />
                </button>
                {/* A device has no agent: no hop to another device or site through it. */}
                {!selTerm.remote && (
                  <button title="Ajouter : Telnet / SSH vers un équipement, ou site web de la machine" onClick={() => setAccess({ nodeId: selTerm.id, kind: "remote" })}>
                    <Plus size={14} />
                  </button>
                )}
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
            const label = (nd.shells[0] && session.terminals.get(nd.shells[0].terminalId)?.label) || nd.machineName || "Machine";
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
      {picker && (
        <MachinePicker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          onPick={(m) => newShell(m, picker.nodeId)}
          onRemote={() => {
            setAccess({ nodeId: picker.nodeId, kind: "remote" });
            setPicker(null);
          }}
        />
      )}
      {nodeMenu && (
        <NodeMenu
          session={session}
          nodeId={nodeMenu.nodeId}
          anchor={nodeMenu.anchor}
          api={excalidrawRef.current}
          onClose={() => setNodeMenu(null)}
          onNewShell={() => {
            void newShellOnNode(nodeMenu.nodeId, nodeMenu.anchor);
            setNodeMenu(null);
          }}
          onCustomize={() => {
            setCustomizing(nodeMenu.nodeId);
            setNodeMenu(null);
          }}
          onNewAccess={() => {
            setAccess({ nodeId: nodeMenu.nodeId, kind: "remote" });
            setNodeMenu(null);
          }}
        />
      )}
      {access &&
        (() => {
          const device = access.nodeId && excalidrawRef.current ? nodeDataOf(findEl(excalidrawRef.current, access.nodeId))?.remote : undefined;
          const remote = (bare?: boolean) => (
            <RemoteForm
              bare={bare}
              defaultHost={device?.target.host}
              defaultTarget={access.device?.target}
              defaultMachineId={access.device?.machineId || (access.nodeId && nodeMachineId(access.nodeId)) || localStorage.getItem(LAST_MACHINE)}
              onClose={() => setAccess(null)}
              onCreate={(machine, target) => {
                setAccess(null);
                void newShell(machine, access.nodeId, target);
              }}
            />
          );
          // No node yet (machine picker): the session creates its node, a site needs one.
          if (!access.nodeId || access.device) return remote();
          const nodeId = access.nodeId;
          return (
            <AccessDialog kind={access.kind} onKind={(kind) => setAccess({ nodeId, kind })} onClose={() => setAccess(null)}>
              {remote(true)}
              <WebForm
                bare
                defaultHost={device?.target.host}
                defaultMachineId={nodeMachineId(nodeId) ?? localStorage.getItem(LAST_MACHINE)}
                onClose={() => setAccess(null)}
                onCreate={async (machine, target) => {
                  const x = excalidrawRef.current;
                  setAccess(null);
                  try {
                    const web = await session.createWeb(machine, target);
                    linkMachine({ id: session.boardId, key: session.key }, machine).catch(() => {});
                    if (x) addWeb(x, nodeId, web.id, machine.id, machine.name);
                  } catch (e) {
                    toast.error(e);
                  }
                }}
              />
            </AccessDialog>
          );
        })()}
      {cableEdit &&
        (() => {
          const x = excalidrawRef.current;
          const el = x ? findEl(x, cableEdit.cableId) : undefined;
          const c = cableOf(el);
          if (!x || !el || !c) return null;
          const anchor = c[cableEdit.end];
          const item = anchor.id ? findEl(x, anchor.id) : undefined;
          const nd = nodeDataOf(item);
          const itemName = nd
            ? nd.title?.split("\n")[0] || (nd.shells[0] && session.terminals.get(nd.shells[0].terminalId)?.label) || "machine"
            : item?.type === "text"
              ? `« ${(item as any).text.slice(0, 30)} »`
              : anchor.group
                ? "élément de bibliothèque"
                : item?.type === "ellipse"
                  ? "ellipse"
                  : item?.type === "diamond"
                    ? "losange"
                    : "rectangle";
          return (
            <CableEndForm
              info={c.ends?.[cableEdit.end]}
              itemName={itemName}
              onClose={() => setCableEdit(null)}
              onSave={(info) => {
                // Keep where the label was moved to (an empty info clears everything).
                const cur = c.ends?.[cableEdit.end];
                setCableEnd(x, cableEdit.cableId, cableEdit.end, Object.keys(info).length ? { ...info, dx: cur?.dx, dy: cur?.dy } : {});
                setCableEdit(null);
              }}
            />
          );
        })()}
      {exportMenu && (
        <Menu anchor={exportMenu} onClose={() => setExportMenu(null)} align="right">
          <div className="menu-label">Exporter le schéma</div>
          {(["png", "svg"] as const).map((kind) => (
            <button
              key={kind}
              className="menu-item"
              onClick={() => {
                setExportMenu(null);
                const x = excalidrawRef.current;
                if (!x) return;
                exportDiagram(x, kind, node.name, exportNameOf(x)).catch(toast.error);
              }}
            >
              <Download size={16} /> {kind === "png" ? "Image PNG" : "Image SVG (vectorielle)"}
            </button>
          ))}
          {(
            [
              ["containerlab", "Topologie Containerlab (.clab.yml)"],
              ["mermaid", "Mermaid (.mmd)"],
              ["json", "JSON (.json)"],
            ] as [TopologyFormat, string][]
          ).map(([format, label]) => (
            <button
              key={format}
              className="menu-item"
              onClick={() => {
                setExportMenu(null);
                const x = excalidrawRef.current;
                if (!x) return;
                try {
                  const warnings = exportTopology(x, format, node.name, exportNameOf(x));
                  // Non-blocking notice: the first few warnings, the rest counted.
                  if (warnings.length) toast(`Export avec ${warnings.length} avertissement${warnings.length > 1 ? "s" : ""} : ${warnings.slice(0, 3).join(" ")}${warnings.length > 3 ? ` (+${warnings.length - 3} autres)` : ""}`);
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              <Download size={16} /> {label}
            </button>
          ))}
        </Menu>
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

function MachinePicker({ anchor, onClose, onPick, onRemote }: { anchor: MenuAnchor; onClose: () => void; onPick: (m: Machine) => void; onRemote: () => void }) {
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
          Aucune machine. Ajoute un agent sur une de tes machines pour ouvrir des terminaux, ou demande à quelqu'un de te partager la sienne.
        </div>
      )}
      {machines?.map((m) => (
        <button key={m.id} className="menu-item" disabled={!m.online} onClick={() => onPick(m)} title={m.online ? undefined : "Hors ligne"}>
          <span className={`dot ${m.online ? "on" : ""}`} />
          <span style={{ flex: 1 }}>
            {m.name}
            {m.hostname && <span style={{ color: "var(--muted)", fontSize: 12 }}> · {m.hostname}</span>}
            {m.ownerName && <span style={{ color: "var(--muted)", fontSize: 12 }}> · de {m.ownerName}</span>}
          </span>
          {m.id === last && <Check size={14} style={{ color: "var(--muted)" }} />}
        </button>
      ))}
      <div className="menu-sep" />
      {!!machines?.length && (
        <button className="menu-item" onClick={onRemote}>
          <Cable size={16} /> Telnet / SSH vers un équipement…
        </button>
      )}
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
  onNewAccess: () => void;
}) {
  const api = p.api;
  const data = api ? nodeDataOf(findEl(api, p.nodeId)) : undefined;
  if (!api || !data) return null;
  const anyOpen = data.shells.some((s) => openWindowOf(api, s.terminalId)) || (data.webs ?? []).some((w) => openWebWindowOf(api, w.webId));
  return (
    <Menu anchor={p.anchor} onClose={p.onClose}>
      <div className="menu-label">{data.title?.split("\n")[0] || data.machineName || "Shells"}</div>
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
      {(data.webs ?? []).map((w) => {
        const info = p.session.webs.get(w.webId);
        const open = !!openWebWindowOf(api, w.webId);
        return (
          <button
            key={w.webId}
            className={`menu-item ${open ? "selected" : ""}`}
            onClick={() => {
              p.onClose();
              toggleWeb(api, p.nodeId, w.webId);
            }}
          >
            <Globe size={16} />
            <span style={{ flex: 1 }}>{info?.target?.url ?? "Site web"}</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>{open ? "ouvert" : "masqué"}</span>
          </button>
        );
      })}
      {data.shells.length + (data.webs ?? []).length > 0 && (
        <>
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
        </>
      )}
      <button className="menu-item" onClick={p.onNewShell}>
        <Plus size={16} /> Nouveau shell
      </button>
      {!data.remote && (
        <button className="menu-item" onClick={p.onNewAccess}>
          <Cable size={16} /> Telnet / SSH ou site web…
        </button>
      )}
      <button className="menu-item" onClick={p.onCustomize}>
        <Palette size={16} /> Icône et libellé…
      </button>
    </Menu>
  );
}

/**
 * "Add" dialog of a node: Telnet / SSH or web view. Both forms stay mounted side by side and the
 * tabs slide between them (what was typed is kept), the height following the visible one.
 */
function AccessDialog({
  kind,
  onKind,
  onClose,
  children,
}: {
  kind: "remote" | "web";
  onKind: (k: "remote" | "web") => void;
  onClose: () => void;
  children: [React.ReactNode, React.ReactNode];
}) {
  const panels = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const active = kind === "remote" ? 0 : 1;
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = panels[active].current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    // The hidden panel must not be reachable with Tab.
    panels.forEach((p, i) => p.current?.toggleAttribute("inert", i !== active));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return (
    <Modal onClose={onClose} width={560}>
      <div className="access-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={kind === "remote"} onClick={() => onKind("remote")}>
          <Cable size={15} /> SSH / Telnet
        </button>
        <button type="button" role="tab" aria-selected={kind === "web"} onClick={() => onKind("web")}>
          <Globe size={15} /> Site web
        </button>
      </div>
      <div className="access-slider" style={{ height }}>
        <div className="access-track" style={{ transform: `translateX(${active * -50}%)` }}>
          {children.map((c, i) => (
            <div key={i} ref={panels[i]} className="access-panel" role="tabpanel" aria-hidden={i !== active}>
              {c}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Target of a new web view: a service reachable from the chosen machine (itself or its LAN). */
function WebForm({
  defaultMachineId,
  onClose,
  onCreate,
  bare,
  defaultHost,
}: {
  defaultMachineId: string | null;
  bare?: boolean;
  /** The device of the icon, whose web interface is the likely target. */
  defaultHost?: string;
  onClose: () => void;
  onCreate: (m: Machine, target: { url: string; insecure: boolean; hostHeader?: string; legacyTls?: boolean }) => void;
}) {
  const choice = useMachineChoice(defaultMachineId);
  const [scheme, setScheme] = useState("http");
  const [host, setHost] = useState(defaultHost ?? "127.0.0.1");
  const [port, setPort] = useState("80");
  const [path, setPath] = useState("/");
  const [insecure, setInsecure] = useState(true);
  const [hostHeader, setHostHeader] = useState("");
  const [legacyTls, setLegacyTls] = useState(false);
  const machine = choice.machine;
  const cleanHost = host.trim().replace(/^\[|\]$/g, "");
  const cleanHeader = hostHeader.trim();
  const headerOk = !cleanHeader || /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(cleanHeader);
  const portNum = Number(port);
  const valid = !!machine && HOST_RE.test(cleanHost) && Number.isInteger(portNum) && portNum > 0 && portNum < 65536 && headerOk;
  const url = `${scheme}://${cleanHost.includes(":") ? `[${cleanHost}]` : cleanHost}:${port}${path.startsWith("/") ? path : `/${path}`}`;
  const https = scheme === "https";
  return (
    <FormFrame bare={bare} onClose={onClose}>
      <h2 className="display">Ouvrir un site de la machine</h2>
      <p>
        Le site est joint <b>depuis la machine</b> (son propre port, ou un autre appareil de son réseau). Tout le trafic est chiffré de bout en bout entre ton
        navigateur et l'agent : le serveur Excalibash ne voit rien.
      </p>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onCreate(machine!, {
            url,
            insecure: https && insecure,
            ...(cleanHeader ? { hostHeader: cleanHeader } : {}),
            ...(https && legacyTls ? { legacyTls: true } : {}),
          });
        }}
      >
        <MachineField label="Machine (une des tiennes)" choice={choice} />
        <div className="web-form">
          <label className="field">
            Protocole
            <select
              className="select"
              value={scheme}
              onChange={(e) => {
                setScheme(e.target.value);
                if (port === "80" && e.target.value === "https") setPort("443");
                if (port === "443" && e.target.value === "http") setPort("80");
              }}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </label>
          <label className="field">
            Hôte (vu depuis la machine)
            <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" />
          </label>
          <label className="field">
            Port
            <input className="input" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
        <label className="field">
          Chemin
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} />
        </label>
        {https && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600 }}>
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} /> Accepter un certificat auto-signé (Proxmox, routeurs…)
          </label>
        )}
        <details className="advanced">
          <summary>Configuration avancée</summary>
          <div className="advanced-body">
            <label className="field">
              En-tête Host
              <input className="input" value={hostHeader} onChange={(e) => setHostHeader(e.target.value)} placeholder={cleanHost || "intranet.local"} spellCheck={false} />
              <span className="field-help">
                {headerOk
                  ? `Pour un site servi par nom (hôte virtuel) : envoyé à la place de l'hôte${https ? ", et utilisé comme nom TLS (SNI)" : ""}. Vide : l'hôte ci-dessus.`
                  : "En-tête invalide : un nom, avec un port facultatif (intranet.local:8080)."}
              </span>
            </label>
            {https && (
              <label className="check">
                <input type="checkbox" checked={legacyTls} onChange={(e) => setLegacyTls(e.target.checked)} />
                <span>
                  TLS ancien (1.0/1.1)
                  <small>Interfaces web de vieux switchs ou onduleurs qui échouent avec « protocol version » ou « handshake failure ». Chiffrement faible.</small>
                </span>
              </label>
            )}
          </div>
        </details>
        <div className="codebox" style={{ paddingRight: 14 }}>
          {url}
          {cleanHeader && headerOk && <div style={{ color: "#94a3b8" }}>Host: {cleanHeader}</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={!valid}>
            <Globe size={16} /> Ouvrir
          </button>
        </div>
      </form>
    </FormFrame>
  );
}
