// Network-diagram nodes: an icon on the canvas that owns one or more shells. Each shell has its
// own window element, moved independently; hiding a window keeps the shell running and the icon
// in place. Everything is plain scene state (customData), so it is encrypted, synced and undoable.
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { TileIcon } from "./personalLibrary.ts";

export const LINK_BASE = "https://excalibash.local/";
export const TERMINAL_LINK = `${LINK_BASE}terminal/`;
const NODE_LINK = `${LINK_BASE}node/`;
export const TERM_W = 760;
export const TERM_H = 440;
export const NODE_SIZE = 110;
const GAP = 40;

/** Last place and size of a shell's window, so it reopens where it was. */
export type ShellRef = { terminalId: string; x?: number; y?: number; w?: number; h?: number };
export type NodeData = { node: true; title?: string | null; icon?: TileIcon | null; shells: ShellRef[] };

type El = ExcalidrawElement;
type Api = ExcalidrawImperativeAPI;

export const nodeDataOf = (el: El | null | undefined): NodeData | undefined =>
  (el?.customData as any)?.node ? (el!.customData as NodeData) : undefined;

/** The node a shell window belongs to (undefined for standalone, older terminals). */
export const windowNodeId = (el: El | null | undefined): string | undefined =>
  (el?.customData as any)?.terminalId ? (el!.customData as any).nodeId : undefined;

function embeddable(x: number, y: number, w: number, h: number, link: (id: string) => string, customData: Record<string, unknown>): El {
  const [base] = convertToExcalidrawElements([
    { type: "rectangle", x, y, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0 },
  ]);
  return { ...base, type: "embeddable", link: link(base.id), customData, index: null, roundness: null } as unknown as El;
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
export const findEl = (api: Api, id: string) => all(api).find((e) => e.id === id);

/** The visible window of a shell, if it is open. */
export const openWindowOf = (api: Api, terminalId: string) =>
  api.getSceneElements().find((e) => (e.customData as any)?.terminalId === terminalId && (e.customData as any)?.nodeId);

function commit(api: Api, changed: El[], added: El[] = [], appState?: object) {
  const byId = new Map(changed.map((e) => [e.id, e]));
  api.updateScene({
    elements: [...all(api).map((e) => byId.get(e.id) ?? e), ...added],
    appState: appState as any,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** Excalidraw tracks the active embeddable by identity: activate the final instance once settled. */
export function activate(api: Api, id: string) {
  setTimeout(() => {
    const el = api.getSceneElements().find((e) => e.id === id);
    if (el) api.updateScene({ appState: { selectedElementIds: {}, activeEmbeddable: { element: el, state: "active" } } as any, captureUpdate: CaptureUpdateAction.NEVER });
  }, 60);
}

export function deactivate(api: Api) {
  api.updateScene({ appState: { activeEmbeddable: null } as any, captureUpdate: CaptureUpdateAction.NEVER });
}

/** A new node at the center of the view with its first shell open next to it. */
export function createNode(api: Api, terminalId: string) {
  const st = api.getAppState();
  const zoom = st.zoom.value;
  const cx = -st.scrollX + st.width / 2 / zoom;
  const cy = -st.scrollY + st.height / 2 / zoom;
  const width = NODE_SIZE + GAP + TERM_W;
  const nx = cx - width / 2;
  const ny = cy - NODE_SIZE / 2;
  const node = embeddable(nx, ny, NODE_SIZE, NODE_SIZE, (id) => NODE_LINK + id, { node: true, shells: [{ terminalId }] } satisfies NodeData);
  const win = embeddable(nx + NODE_SIZE + GAP, cy - TERM_H / 2, TERM_W, TERM_H, () => TERMINAL_LINK + terminalId, { terminalId, nodeId: node.id });
  commit(api, [], [node, win]);
  activate(api, win.id);
}

export function addShell(api: Api, nodeId: string, terminalId: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (!node || !data) return;
  commit(api, [newElementWith(node, { customData: { ...data, shells: [...data.shells, { terminalId }] } })]);
  openShell(api, nodeId, terminalId);
}

export function openShell(api: Api, nodeId: string, terminalId: string, focus = true) {
  const existing = openWindowOf(api, terminalId);
  if (existing) {
    if (focus) activate(api, existing.id);
    return;
  }
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (!node || !data) return;
  const i = Math.max(0, data.shells.findIndex((s) => s.terminalId === terminalId));
  const ref = data.shells[i] ?? { terminalId };
  const geometry = {
    x: ref.x ?? node.x + node.width + GAP + i * 28,
    y: ref.y ?? node.y + i * 28,
    width: ref.w ?? TERM_W,
    height: ref.h ?? TERM_H,
  };
  // Reuse the hidden window when there is one: no pile of deleted elements.
  const hidden = all(api).find((e) => e.isDeleted && (e.customData as any)?.terminalId === terminalId && (e.customData as any)?.nodeId === nodeId);
  if (hidden) {
    commit(api, [newElementWith(hidden, { ...geometry, isDeleted: false })]);
    if (focus) activate(api, hidden.id);
  } else {
    const win = embeddable(geometry.x, geometry.y, geometry.width, geometry.height, () => TERMINAL_LINK + terminalId, { terminalId, nodeId });
    commit(api, [], [win]);
    if (focus) activate(api, win.id);
  }
}

/** Hides a shell window; the shell keeps running and the node remembers where it was. */
export function hideShell(api: Api, windowId: string) {
  const win = findEl(api, windowId);
  const nodeId = windowNodeId(win);
  if (!win || !nodeId) return;
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [newElementWith(win, { isDeleted: true })];
  if (node && data) {
    const tid = (win.customData as any).terminalId as string;
    const shells = data.shells.map((s) => (s.terminalId === tid ? { ...s, x: win.x, y: win.y, w: win.width, h: win.height } : s));
    changed.push(newElementWith(node, { customData: { ...data, shells } }));
  }
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

export function toggleShell(api: Api, nodeId: string, terminalId: string) {
  const open = openWindowOf(api, terminalId);
  if (open) hideShell(api, open.id);
  else openShell(api, nodeId, terminalId);
}

/** Opens every shell of a node, or hides them all if any is open. */
export function toggleAll(api: Api, nodeId: string) {
  const data = nodeDataOf(findEl(api, nodeId));
  if (!data) return;
  const open = data.shells.map((s) => openWindowOf(api, s.terminalId)).filter(Boolean) as El[];
  if (open.length) for (const w of open) hideShell(api, w.id);
  else data.shells.forEach((s, i) => openShell(api, nodeId, s.terminalId, i === data.shells.length - 1));
}

export function setNodeLook(api: Api, nodeId: string, look: { title: string | null; icon: TileIcon | null }) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (node && data) commit(api, [newElementWith(node, { strokeColor: "transparent", backgroundColor: "transparent", customData: { ...data, ...look } })]);
}

/** Windows whose node was deleted would float around orphaned: delete them too. */
export function orphanWindows(elements: readonly El[]): El[] {
  const nodes = new Map(elements.filter((e) => nodeDataOf(e)).map((e) => [e.id, e]));
  return elements.filter((e) => {
    const nid = windowNodeId(e);
    if (!nid || e.isDeleted) return false;
    const n = nodes.get(nid);
    return !n || n.isDeleted;
  });
}

export function deleteElements(api: Api, list: El[]) {
  if (!list.length) return;
  const byId = new Map(list.map((e) => [e.id, newElementWith(e, { isDeleted: true })]));
  api.updateScene({ elements: all(api).map((e) => byId.get(e.id) ?? e), captureUpdate: CaptureUpdateAction.NEVER });
}
