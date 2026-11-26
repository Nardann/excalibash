// Network-diagram nodes: an icon on the canvas that owns shells and web views. Each one has its
// own window element, moved independently; hiding a window keeps the shell (or tunnel) alive and
// the icon in place. Everything is plain scene state (customData): encrypted, synced, undoable.
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cd, labelOfName, nodeDataOf } from "./nodeData.ts";
import type { NodeData, ShellRef, WebRef, CodeRef, NotebookRef, RemoteRef, Geometry } from "./nodeData.ts";
import type { TileIcon } from "./personalLibrary.ts";
export { nodeDataOf };
export type { NodeData, ShellRef, WebRef, CodeRef, NotebookRef, RemoteRef };

export const LINK_BASE = "https://excalibash.local/";
export const TERMINAL_LINK = `${LINK_BASE}terminal/`;
const WEB_LINK = `${LINK_BASE}web/`;
const CODE_LINK = `${LINK_BASE}code/`;
const NOTEBOOK_LINK = `${LINK_BASE}notebook/`;
const NODE_LINK = `${LINK_BASE}node/`;
export const TERM_W = 760;
export const TERM_H = 440;
export const CODE_W = 760;
export const CODE_H = 520;
export const NOTEBOOK_W = 820;
export const NOTEBOOK_H = 620;
export const NODE_SIZE = 110;
const GAP = 40;

type El = ExcalidrawElement;
type Api = ExcalidrawImperativeAPI;

/**
 * The kinds of windows a node can own. `field` is the key in the window's customData, `ref` the
 * key of its entry in the node's list (they differ for code: `codeId` in the window, `docId` in the node).
 */
const KINDS = {
  terminal: { field: "terminalId", ref: "terminalId", list: "shells", link: TERMINAL_LINK, w: TERM_W, h: TERM_H },
  web: { field: "webId", ref: "webId", list: "webs", link: WEB_LINK, w: 900, h: 580 },
  code: { field: "codeId", ref: "docId", list: "codes", link: CODE_LINK, w: CODE_W, h: CODE_H },
  notebook: { field: "notebookId", ref: "docId", list: "notebooks", link: NOTEBOOK_LINK, w: NOTEBOOK_W, h: NOTEBOOK_H },
} as const;
type Kind = keyof typeof KINDS;


/** A shell, site or code window (as opposed to a drawing or a node tile). */
export const isWindow = (el: El | null | undefined): boolean => !!(cd(el).terminalId || cd(el).webId || cd(el).codeId || cd(el).notebookId);

/** The node a window belongs to (undefined for standalone, older terminals). */
export const windowNodeId = (el: El | null | undefined): string | undefined =>
  isWindow(el) ? cd(el).nodeId : undefined;

const kindOf = (el: El): Kind | undefined => (cd(el).webId ? "web" : cd(el).codeId ? "code" : cd(el).notebookId ? "notebook" : cd(el).terminalId ? "terminal" : undefined);

function embeddable(x: number, y: number, w: number, h: number, link: (id: string) => string, customData: Record<string, unknown>): El {
  const [base] = convertToExcalidrawElements([
    { type: "rectangle", x, y, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0 },
  ]);
  return { ...base, type: "embeddable", link: link(base.id), customData, index: null, roundness: null } as unknown as El;
}

const all = (api: Api) => api.getSceneElementsIncludingDeleted();
export const findEl = (api: Api, id: string) => all(api).find((e) => e.id === id);

function openWindow(api: Api, kind: Kind, id: string) {
  const f = KINDS[kind].field;
  return api.getSceneElements().find((e) => cd(e)[f] === id && cd(e).nodeId);
}
/** The visible window of a shell, if it is open. */
export const openWindowOf = (api: Api, terminalId: string) => openWindow(api, "terminal", terminalId);
export const openWebWindowOf = (api: Api, webId: string) => openWindow(api, "web", webId);
export const openCodeWindowOf = (api: Api, docId: string) => openWindow(api, "code", docId);
export const openNotebookWindowOf = (api: Api, docId: string) => openWindow(api, "notebook", docId);

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

/**
 * A new node with its first shell open next to it: at the center of the view, or below `near`
 * (a device reached from that machine's icon).
 */
export function createNode(api: Api, terminalId: string, opts: { near?: El; title?: string; remote?: RemoteRef; machineId?: string; machineName?: string } = {}) {
  const st = api.getAppState();
  const zoom = st.zoom.value;
  const cx = -st.scrollX + st.width / 2 / zoom;
  const cy = -st.scrollY + st.height / 2 / zoom;
  const near = opts.near;
  const nx = near ? near.x : cx - (NODE_SIZE + GAP + TERM_W) / 2;
  const ny = near ? near.y + near.height + GAP * 2 : cy - NODE_SIZE / 2;
  const data: NodeData = { node: true, shells: [{ terminalId }], webs: [], ...(opts.title ? { title: opts.title } : {}), ...(opts.remote ? { remote: opts.remote } : opts.machineId ? { machineId: opts.machineId, ...(opts.machineName ? { machineName: opts.machineName } : {}) } : {}) };
  const node = embeddable(nx, ny, NODE_SIZE, NODE_SIZE, (id) => NODE_LINK + id, data);
  const wy = near ? ny : cy - TERM_H / 2;
  const win = embeddable(nx + NODE_SIZE + GAP, wy, TERM_W, TERM_H, () => TERMINAL_LINK + terminalId, { terminalId, nodeId: node.id });
  commit(api, [], [node, win]);
  activate(api, win.id);
}

function refsOf(data: NodeData, kind: Kind): (Geometry & Record<string, any>)[] {
  return ((data as any)[KINDS[kind].list] as any[] | undefined) ?? [];
}

function add(api: Api, kind: Kind, nodeId: string, id: string, machineId?: string, machineName?: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (!node || !data) return;
  const k = KINDS[kind];
  // Icons from before machines were remembered learn theirs from their next shell or site, and
  // the name follows a renamed machine (the icon's own machine only).
  const learn =
    machineId && !data.remote && (!data.machineId || data.machineId === machineId)
      ? { machineId, ...(machineName ? { machineName } : {}) }
      : {};
  commit(api, [newElementWith(node, { customData: { ...data, ...learn, [k.list]: [...refsOf(data, kind), { [k.ref]: id }] } })]);
  open(api, kind, nodeId, id);
}
export const addShell = (api: Api, nodeId: string, terminalId: string, machineId?: string, machineName?: string) =>
  add(api, "terminal", nodeId, terminalId, machineId, machineName);
export const addWeb = (api: Api, nodeId: string, webId: string, machineId?: string, machineName?: string) => add(api, "web", nodeId, webId, machineId, machineName);
/** Adds a code window (shared document `docId`) to a node and opens it. */
export const addCode = (api: Api, nodeId: string, docId: string) => add(api, "code", nodeId, docId);
/** Adds a notebook window (shared document `docId`) to a node and opens it. */
export const addNotebook = (api: Api, nodeId: string, docId: string) => add(api, "notebook", nodeId, docId);

function open(api: Api, kind: Kind, nodeId: string, id: string, focus = true) {
  const k = KINDS[kind];
  const existing = openWindow(api, kind, id);
  if (existing) {
    if (focus) activate(api, existing.id);
    return;
  }
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (!node || !data) return;
  const refs = refsOf(data, kind);
  const i = Math.max(0, refs.findIndex((r) => r[k.ref] === id));
  const ref = refs[i] ?? {};
  // Web views and code open below the node, shells to its right: their default spots don't overlap.
  const geometry =
    kind !== "terminal"
      ? { x: ref.x ?? node.x + i * 28, y: ref.y ?? node.y + node.height + GAP + i * 28, width: ref.w ?? k.w, height: ref.h ?? k.h }
      : { x: ref.x ?? node.x + node.width + GAP + i * 28, y: ref.y ?? node.y + i * 28, width: ref.w ?? k.w, height: ref.h ?? k.h };
  // Reuse the hidden window when there is one: no pile of deleted elements.
  const hidden = all(api).find((e) => e.isDeleted && cd(e)[k.field] === id && cd(e).nodeId === nodeId);
  if (hidden) {
    commit(api, [newElementWith(hidden, { ...geometry, isDeleted: false })]);
    if (focus) activate(api, hidden.id);
  } else {
    const win = embeddable(geometry.x, geometry.y, geometry.width, geometry.height, () => k.link + id, { [k.field]: id, nodeId });
    commit(api, [], [win]);
    if (focus) activate(api, win.id);
  }
}
export const openShell = (api: Api, nodeId: string, terminalId: string, focus = true) => open(api, "terminal", nodeId, terminalId, focus);
export const openWeb = (api: Api, nodeId: string, webId: string, focus = true) => open(api, "web", nodeId, webId, focus);
export const openCode = (api: Api, nodeId: string, docId: string, focus = true) => open(api, "code", nodeId, docId, focus);
export const openNotebook = (api: Api, nodeId: string, docId: string, focus = true) => open(api, "notebook", nodeId, docId, focus);

const overlap = (a: El, b: El) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Puts a window above the others. Stacking (on screen and for clicks) follows the scene order, so
 * the element moves to the end of the scene, but only when a window it overlaps is drawn above
 * it: no change, no sync traffic otherwise. Returns whether it moved.
 */
export function bringToFront(api: Api, id: string): boolean {
  const els = all(api);
  const i = els.findIndex((e) => e.id === id);
  const win = els[i];
  if (!win || win.isDeleted) return false;
  if (!els.slice(i + 1).some((e) => !e.isDeleted && e.type === "embeddable" && overlap(e, win))) return false;
  // Without a state-preserving move, raising a web view would reload its page (here and for
  // everyone else): leave it where it is.
  if (cd(win).webId && typeof (Element.prototype as any).moveBefore !== "function") return false;
  keepFramesOnMove();
  // A null index is recomputed by Excalidraw from the position in the array (like a new element).
  const moved = newElementWith(win, { index: null } as any);
  api.updateScene({ elements: [...els.slice(0, i), ...els.slice(i + 1), moved], captureUpdate: CaptureUpdateAction.NEVER });
  return true;
}

/**
 * Embeds are DOM nodes laid out in scene order, so reordering moves the DOM node of the raised
 * window, and a moved iframe reloads (a web view would lose its page). Where the browser has
 * Element.moveBefore (state-preserving move), make React's moves use it in the embeds' container.
 * Installed by every web view when it mounts, for every role: a window raised by someone else
 * moves here too, when their reorder arrives.
 */
export function keepFramesOnMove() {
  const parent = document.querySelector(".excalidraw__embeddable-container")?.parentElement as (HTMLElement & { ebPatched?: boolean; moveBefore?: (n: Node, r: Node | null) => void }) | null;
  if (!parent || parent.ebPatched || typeof parent.moveBefore !== "function") return;
  parent.ebPatched = true;
  const insertBefore = parent.insertBefore.bind(parent);
  const appendChild = parent.appendChild.bind(parent);
  const move = <T extends Node>(node: T, ref: Node | null, fallback: () => T): T => {
    if (node.parentNode !== parent) return fallback();
    try {
      parent.moveBefore!(node, ref);
      return node;
    } catch {
      return fallback();
    }
  };
  parent.insertBefore = <T extends Node>(node: T, ref: Node | null) => move(node, ref, () => insertBefore(node, ref));
  parent.appendChild = <T extends Node>(node: T) => move(node, null, () => appendChild(node));
}

/** Locks a window in place (no move, no resize) or unlocks it; what runs in it is not affected. */
export function setWindowLocked(api: Api, windowId: string, locked: boolean) {
  const win = findEl(api, windowId);
  if (win && !win.isDeleted) commit(api, [newElementWith(win, { locked })]);
}

/** Hides a window; the shell / tunnel keeps running and the node remembers where it was. */
export function hideShell(api: Api, windowId: string) {
  const win = findEl(api, windowId);
  const nodeId = windowNodeId(win);
  const kind = win && kindOf(win);
  if (!win || !nodeId || !kind) return;
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [newElementWith(win, { isDeleted: true })];
  if (node && data) {
    const k = KINDS[kind];
    const id = cd(win)[k.field];
    const refs = refsOf(data, kind).map((r) => (r[k.ref] === id ? { ...r, x: win.x, y: win.y, w: win.width, h: win.height } : r));
    changed.push(newElementWith(node, { customData: { ...data, [k.list]: refs } }));
  }
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

function toggle(api: Api, kind: Kind, nodeId: string, id: string) {
  const w = openWindow(api, kind, id);
  if (w) hideShell(api, w.id);
  else open(api, kind, nodeId, id);
}
export const toggleShell = (api: Api, nodeId: string, terminalId: string) => toggle(api, "terminal", nodeId, terminalId);
export const toggleWeb = (api: Api, nodeId: string, webId: string) => toggle(api, "web", nodeId, webId);
export const toggleCode = (api: Api, nodeId: string, docId: string) => toggle(api, "code", nodeId, docId);
export const toggleNotebook = (api: Api, nodeId: string, docId: string) => toggle(api, "notebook", nodeId, docId);

/** Opens every window of a node, or hides them all if any is open. */
export function toggleAll(api: Api, nodeId: string) {
  const data = nodeDataOf(findEl(api, nodeId));
  if (!data) return;
  const items = (["terminal", "web", "code", "notebook"] as Kind[]).flatMap((kind) => refsOf(data, kind).map((r) => ({ kind, id: r[KINDS[kind].ref] as string })));
  const open_ = items.map((it) => openWindow(api, it.kind, it.id)).filter(Boolean) as El[];
  if (open_.length) for (const w of open_) hideShell(api, w.id);
  else items.forEach((it, i) => open(api, it.kind, nodeId, it.id, i === items.length - 1));
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

/**
 * Removes a shell from its node (it was closed): its entry and its window go away. `machineName`
 * (the shell's machine) is kept on an icon that had none yet, so it doesn't lose its label.
 */
export function removeShell(api: Api, nodeId: string, terminalId: string, machineName?: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [];
  const keep = machineName && !data?.remote && !data?.machineName ? { machineName } : {};
  if (node && data) changed.push(newElementWith(node, { customData: { ...data, ...keep, shells: data.shells.filter((s) => s.terminalId !== terminalId) } }));
  for (const e of all(api)) if (cd(e).terminalId === terminalId && cd(e).nodeId === nodeId && !e.isDeleted) changed.push(newElementWith(e, { isDeleted: true }));
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

/**
 * Records the display name of a code or notebook window in its node's list (the dock and the menus show it
 * instead of "Code 1"). A base name only. Not an undo step; nothing is written when it is already there.
 */
export function setDocLabel(api: Api, kind: "code" | "notebook", nodeId: string, docId: string, name: string | null): boolean {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  if (!node || node.isDeleted || !data) return false;
  const label = name === null ? undefined : (labelOfName(name) ?? undefined);
  const list = refsOf(data, kind);
  const cur = list.find((r) => r.docId === docId);
  if (!cur || cur.label === label) return false;
  const refs = list.map((r) => {
    if (r.docId !== docId) return r;
    const { label: _old, ...rest } = r;
    return label ? { ...rest, label } : rest;
  });
  api.updateScene({
    elements: all(api).map((e) => (e.id === node.id ? newElementWith(node, { customData: { ...data, [KINDS[kind].list]: refs } }) : e)),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return true;
}

/** Removes a web view from its node (its tunnel was closed). */
export function removeWeb(api: Api, nodeId: string, webId: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [];
  if (node && data) changed.push(newElementWith(node, { customData: { ...data, webs: (data.webs ?? []).filter((w) => w.webId !== webId) } }));
  for (const e of all(api)) if (cd(e).webId === webId && !e.isDeleted) changed.push(newElementWith(e, { isDeleted: true }));
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

/** Removes a code window from its node (the shared document itself stays on the server). */
export function removeCode(api: Api, nodeId: string, docId: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [];
  if (node && data) changed.push(newElementWith(node, { customData: { ...data, codes: (data.codes ?? []).filter((c) => c.docId !== docId) } }));
  for (const e of all(api)) if (cd(e).codeId === docId && cd(e).nodeId === nodeId && !e.isDeleted) changed.push(newElementWith(e, { isDeleted: true }));
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

/** Removes a notebook window from its node (the caller discards the shared document and its kernel). */
export function removeNotebook(api: Api, nodeId: string, docId: string) {
  const node = findEl(api, nodeId);
  const data = nodeDataOf(node);
  const changed: El[] = [];
  if (node && data) changed.push(newElementWith(node, { customData: { ...data, notebooks: (data.notebooks ?? []).filter((c) => c.docId !== docId) } }));
  for (const e of all(api)) if (cd(e).notebookId === docId && cd(e).nodeId === nodeId && !e.isDeleted) changed.push(newElementWith(e, { isDeleted: true }));
  commit(api, changed, [], { activeEmbeddable: null, selectedElementIds: {} });
}

/**
 * Terminals created before nodes existed turned into a tile *instead of* their window. Give each
 * one a node of its own (same label, icon and tile size) so the icon stays when the shell opens.
 * Returns how many were converted.
 */
export function migrateLegacyTerminals(api: Api): number {
  const legacy = api.getSceneElements().filter((e) => cd(e).terminalId && !cd(e).nodeId);
  if (!legacy.length) return 0;
  const changed: El[] = [];
  const added: El[] = [];
  for (const el of legacy) {
    const d = cd(el);
    const collapsed = !!d.collapsed;
    const tileW = collapsed ? el.width : (d.tile?.w ?? NODE_SIZE);
    const tileH = collapsed ? el.height : (d.tile?.h ?? NODE_SIZE);
    const win = collapsed
      ? { x: el.x + tileW + GAP, y: el.y, w: d.expanded?.w ?? TERM_W, h: d.expanded?.h ?? TERM_H }
      : { x: el.x, y: el.y, w: el.width, h: el.height };
    const nodePos = collapsed ? { x: el.x, y: el.y } : { x: el.x - tileW - GAP, y: el.y };
    const ref: ShellRef = collapsed ? { terminalId: d.terminalId, ...win } : { terminalId: d.terminalId };
    const node = embeddable(nodePos.x, nodePos.y, tileW, tileH, (id) => NODE_LINK + id, {
      node: true,
      title: d.title ?? null,
      icon: d.icon ?? null,
      shells: [ref],
      webs: [],
    } satisfies NodeData);
    added.push(node);
    changed.push(
      newElementWith(el, {
        x: win.x,
        y: win.y,
        width: win.w,
        height: win.h,
        // A collapsed one stays hidden: the node now stands for it.
        isDeleted: collapsed,
        customData: { terminalId: d.terminalId, nodeId: node.id },
      }),
    );
  }
  const byId = new Map(changed.map((e) => [e.id, e]));
  api.updateScene({ elements: [...all(api).map((e) => byId.get(e.id) ?? e), ...added], captureUpdate: CaptureUpdateAction.NEVER });
  return legacy.length;
}
