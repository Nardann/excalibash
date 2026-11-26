// Cables: rounded links between two items of the diagram (shapes, library items, machine icons).
// A cable is an Excalidraw arrow without heads, drawn and edited with Excalidraw's own tools, but
// attached by us: each end aims at the center of its item and stops at its border, groups (library
// items) count as one item, and a cable can't dangle: when one of its items goes, it goes too, and
// comes back if that item is restored (undo). Everything is plain scene state (customData).
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cd, cableOf, anchorOf, parseVlans, vlanLines, vlanParts, IP_RE, LABEL_RADIUS } from "./cableData.ts";
import type { Anchor, EndInfo, CableData, End } from "./cableData.ts";
export { cableOf, anchorOf, parseVlans, vlanLines, vlanParts, IP_RE, LABEL_RADIUS };
export type { Anchor, EndInfo, CableData, End };

type El = ExcalidrawElement;
type Api = ExcalidrawImperativeAPI;
type Pt = { x: number; y: number };

/** Distance between an item's border and the cable's end. */
const GAP = 3;

const sameAnchor = (a: Anchor, b: Anchor) => (a.group ? a.group === b.group : !!a.id && a.id === b.id);

/** Terminal / web windows come and go with their icon: cables attach to the icon instead. */
const isWindow = (el: El) => !!cd(el).nodeId && !!(cd(el).terminalId || cd(el).webId || cd(el).codeId || cd(el).notebookId);
const canAnchor = (el: El) => !el.isDeleted && !cableOf(el) && !isWindow(el) && el.type !== "selection";

/** Axis-aligned bounds, points included for lines and arrows. */
function bounds(el: El): [number, number, number, number] {
  if ("points" in el && el.points.length) {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    return [el.x + Math.min(...xs), el.y + Math.min(...ys), el.x + Math.max(...xs), el.y + Math.max(...ys)];
  }
  return [el.x, el.y, el.x + el.width, el.y + el.height];
}

/** Outer bounds of a group: a library item is hit anywhere in its frame, not only on its strokes. */
type Box = [number, number, number, number];
const union = (b: Box[]): Box | null =>
  b.length ? [Math.min(...b.map((v) => v[0])), Math.min(...b.map((v) => v[1])), Math.max(...b.map((v) => v[2])), Math.max(...b.map((v) => v[3]))] : null;

function groupBounds(elements: readonly El[], group: string): Box | null {
  return union(elements.filter((e) => canAnchor(e) && e.groupIds.includes(group)).map(bounds));
}

/** Bounds of every group, computed once per pass instead of once per cable end. */
function allGroupBounds(elements: readonly El[]): Map<string, Box> {
  const out = new Map<string, Box>();
  for (const e of elements) {
    if (!canAnchor(e) || !e.groupIds.length) continue;
    const b = bounds(e);
    for (const g of e.groupIds) {
      const cur = out.get(g);
      out.set(g, cur ? [Math.min(cur[0], b[0]), Math.min(cur[1], b[1]), Math.max(cur[2], b[2]), Math.max(cur[3], b[3])] : b);
    }
  }
  return out;
}

/** A group anchor with its current members recorded (see Anchor.ids). */
function withMembers(a: Anchor, elements: readonly El[]): Anchor {
  if (!a.group) return a;
  const ids = elements.filter((e) => canAnchor(e) && e.groupIds.includes(a.group!)).map((e) => e.id);
  return ids.length ? { group: a.group, ids: ids.slice(0, 500) } : a;
}

/** Hit tolerance, so thin lines and small items are easy to reach. */
const SLOP = 6;

/** Topmost item under a point. */
export function anchorAt(elements: readonly El[], p: Pt, byId: Map<string, El>): Anchor | null {
  const seen = new Set<string>();
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!canAnchor(el)) continue;
    const anchor = anchorOf(el, byId);
    if (anchor.group && seen.has(anchor.group)) continue;
    if (anchor.group) seen.add(anchor.group);
    const b = anchor.group ? groupBounds(elements, anchor.group) : bounds(el);
    if (b && p.x >= b[0] - SLOP && p.x <= b[2] + SLOP && p.y >= b[1] - SLOP && p.y <= b[3] + SLOP) return anchor;
  }
  return null;
}

type Shape = { kind: "rect" | "ellipse" | "diamond"; cx: number; cy: number; hw: number; hh: number; angle: number };

/** The live shape of an anchor, or null when its item is gone. */
function resolve(a: Anchor, elements: readonly El[], byId: Map<string, El>, groups?: Map<string, Box>): Shape | null {
  if (a.group) {
    // The group, else (ungrouped) whatever is left of its members.
    const g =
      (groups ? (groups.get(a.group) ?? null) : groupBounds(elements, a.group)) ??
      union((a.ids ?? []).map((id) => byId.get(id)).filter((e): e is El => !!e && canAnchor(e)).map(bounds));
    if (!g) return null;
    const [x1, y1, x2, y2] = g;
    return { kind: "rect", cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, hw: (x2 - x1) / 2, hh: (y2 - y1) / 2, angle: 0 };
  }
  const el = a.id ? byId.get(a.id) : undefined;
  if (!el || !canAnchor(el)) return null;
  const [x1, y1, x2, y2] = bounds(el);
  const kind = el.type === "ellipse" ? "ellipse" : el.type === "diamond" ? "diamond" : "rect";
  return { kind, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, hw: (x2 - x1) / 2, hh: (y2 - y1) / 2, angle: "points" in el ? 0 : el.angle };
}

const rotate = (p: Pt, c: Pt, a: number): Pt => {
  if (!a) return p;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos };
};

/** Where the line from the shape's center toward `toward` leaves the shape, plus the gap. */
function edgePoint(s: Shape, toward: Pt): Pt {
  const c = { x: s.cx, y: s.cy };
  const local = rotate(toward, c, -s.angle);
  const dx = local.x - c.x;
  const dy = local.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6 || s.hw < 1e-6 || s.hh < 1e-6) return c;
  const ux = Math.abs(dx) / s.hw;
  const uy = Math.abs(dy) / s.hh;
  const t = s.kind === "ellipse" ? 1 / Math.hypot(ux, uy) : s.kind === "diamond" ? 1 / (ux + uy) : 1 / Math.max(ux, uy);
  const k = t + GAP / len;
  return rotate({ x: c.x + dx * k, y: c.y + dy * k }, c, s.angle);
}

/** The cable's points with both ends on their items' borders, aimed at their centers. */
function attachedPoints(el: El & { points: readonly (readonly [number, number])[] }, A: Shape, B: Shape) {
  const abs = el.points.map((p) => ({ x: el.x + p[0], y: el.y + p[1] }));
  const n = abs.length;
  // A straight cable goes center to center; a bent one aims at its first / last bend.
  const towardA = n > 2 ? abs[1] : { x: B.cx, y: B.cy };
  const towardB = n > 2 ? abs[n - 2] : { x: A.cx, y: A.cy };
  abs[0] = edgePoint(A, towardA);
  abs[n - 1] = edgePoint(B, towardB);
  return abs;
}

function withPoints(el: El, abs: Pt[], patch: Record<string, unknown>): El {
  const o = abs[0];
  const points = abs.map((p) => [p.x - o.x, p.y - o.y] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return newElementWith(el, {
    ...patch,
    x: o.x,
    y: o.y,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  } as any);
}

/** A cable the user is drawing or dragging right now: leave it alone until the pointer is up. */
function busy(el: El, st: AppState) {
  if (st.newElement?.id === el.id || st.multiElement?.id === el.id) return true;
  if (st.cursorButton !== "down") return false;
  return st.selectedLinearElement?.elementId === el.id || st.editingLinearElement?.elementId === el.id || !!st.selectedElementIds[el.id];
}

const near = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

/**
 * Keeps every cable attached: ends on their items' borders, re-attached where the user dropped an
 * end on another item, removed with an item and restored with it. Changes are not undo steps
 * (they follow the user's own changes). Returns whether anything changed.
 */
export function maintainCables(api: Api): boolean {
  const els = api.getSceneElementsIncludingDeleted();
  const cables = els.filter((e) => cableOf(e));
  if (!cables.length) return false;
  const st = api.getAppState();
  const byId = new Map(els.map((e) => [e.id, e]));
  const groups = allGroupBounds(els);
  const changed = new Map<string, El>();

  for (const el of cables) {
    if (!("points" in el) || el.points.length < 2) continue;
    const c = cableOf(el)!;
    const A0 = resolve(c.a, els, byId, groups);
    const B0 = resolve(c.b, els, byId, groups);
    if (el.isDeleted) {
      // Removed with one of its items, which is back (undo): the cable comes back too.
      if (c.orphaned && A0 && B0) changed.set(el.id, newElementWith(el, { isDeleted: false, customData: { ...cd(el), cable: { ...c, orphaned: undefined } } }));
      continue;
    }
    if (!A0 || !B0) {
      changed.set(el.id, newElementWith(el, { isDeleted: true, customData: { ...cd(el), cable: { ...c, orphaned: true } } }));
      continue;
    }
    if (busy(el, st)) continue;
    // An end dropped on another item (Excalidraw bound it there): the cable moves to that item.
    let a = c.a;
    let b = c.b;
    const sb = "startBinding" in el && el.startBinding ? byId.get(el.startBinding.elementId) : undefined;
    const eb = "endBinding" in el && el.endBinding ? byId.get(el.endBinding.elementId) : undefined;
    if (sb && canAnchor(sb)) {
      const t = anchorOf(sb, byId);
      if (!sameAnchor(t, b) && !sameAnchor(t, a)) a = withMembers(t, els);
    }
    if (eb && canAnchor(eb)) {
      const t = anchorOf(eb, byId);
      if (!sameAnchor(t, a) && !sameAnchor(t, b)) b = withMembers(t, els);
    }
    // Group ends attached before members were recorded get them now.
    if (a.group && !a.ids) a = withMembers(a, els);
    if (b.group && !b.ids) b = withMembers(b, els);
    const A = a === c.a ? A0 : resolve(a, els, byId, groups);
    const B = b === c.b ? B0 : resolve(b, els, byId, groups);
    if (!A || !B) continue;
    const abs = attachedPoints(el as any, A, B);
    const cur = el.points.map((p) => ({ x: el.x + p[0], y: el.y + p[1] }));
    const moved = !near(abs[0], cur[0]) || !near(abs[abs.length - 1], cur[cur.length - 1]);
    const rebound = a !== c.a || b !== c.b;
    // Excalidraw's own binding would fight ours (it aims wherever the pointer was): drop it.
    const hasBinding = !!(sb || eb || ("startBinding" in el && el.startBinding) || ("endBinding" in el && el.endBinding));
    if (moved || rebound || hasBinding) {
      changed.set(el.id, withPoints(el, abs, { startBinding: null, endBinding: null, customData: { ...cd(el), cable: { ...c, a, b } } }));
    }
  }

  // Items still listing a cable as bound to them (from Excalidraw's binding while drawing).
  const cableIds = new Set(cables.map((e) => e.id));
  for (const e of els) {
    if (e.isDeleted || !e.boundElements?.some((b) => cableIds.has(b.id))) continue;
    changed.set(e.id, newElementWith(changed.get(e.id) ?? e, { boundElements: e.boundElements.filter((b) => !cableIds.has(b.id)) }));
  }

  if (!changed.size) return false;
  api.updateScene({ elements: els.map((e) => changed.get(e.id) ?? e), captureUpdate: CaptureUpdateAction.NEVER });
  return true;
}

/**
 * Turns the arrow just drawn with the cable tool into a cable between the items under its two
 * ends. Returns an error message when it doesn't link two different items (the arrow is removed).
 */
export function finishCable(api: Api, id: string): string | null {
  const els = api.getSceneElementsIncludingDeleted();
  const el = els.find((e) => e.id === id);
  if (!el || el.isDeleted || el.type !== "arrow") return null;
  const byId = new Map(els.map((e) => [e.id, e]));
  const live = els.filter((e) => e.id !== id);
  const endAnchor = (binding: { elementId: string } | null, p: readonly [number, number]) => {
    const bound = binding ? byId.get(binding.elementId) : undefined;
    if (bound && canAnchor(bound)) return anchorOf(bound, byId);
    return anchorAt(live, { x: el.x + p[0], y: el.y + p[1] }, byId);
  };
  const a0 = endAnchor(el.startBinding, el.points[0]);
  const b0 = endAnchor(el.endBinding, el.points[el.points.length - 1]);
  const a = a0 && withMembers(a0, els);
  const b = b0 && withMembers(b0, els);
  const error = !a || !b ? "Un câble relie deux éléments : commence et termine-le sur un élément." : sameAnchor(a, b) ? "Un câble relie deux éléments différents." : null;
  api.updateScene({
    elements: els.map((e) =>
      e.id !== id
        ? e
        : error
          ? newElementWith(e, { isDeleted: true })
          : newElementWith(e, {
              startArrowhead: null,
              endArrowhead: null,
              roundness: { type: 2 },
              // "Architect" stroke (no sketchy wobble): a clean cable by default, restylable after.
              roughness: 0,
              customData: { ...cd(e), cable: { a: a!, b: b! } satisfies CableData },
            } as any),
    ),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  if (!error) maintainCables(api);
  return error;
}

/** Each end of a cable: where it is and the direction the cable leaves it in (unit vector). */
export function cableEnds(el: El): { end: End; p: Pt; dir: Pt }[] {
  if (!("points" in el) || el.points.length < 2) return [];
  const abs = el.points.map((q) => ({ x: el.x + q[0], y: el.y + q[1] }));
  const unit = (from: Pt, to: Pt) => {
    const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
  };
  const n = abs.length;
  return [
    { end: "a", p: abs[0], dir: unit(abs[0], abs[1]) },
    { end: "b", p: abs[n - 1], dir: unit(abs[n - 1], abs[n - 2]) },
  ];
}

const clean = (v?: string) => v?.trim() || undefined;

/** Sets (or clears, with an empty info) what is at one end of a cable. An undo step. */
export function setCableEnd(api: Api, id: string, end: End, info: EndInfo) {
  const els = api.getSceneElementsIncludingDeleted();
  const el = els.find((e) => e.id === id);
  const c = cableOf(el);
  if (!el || !c) return;
  const vlans = clean(info.vlans);
  const vlanIps = vlans && info.vlanIps && Object.keys(info.vlanIps).length ? info.vlanIps : undefined;
  const next: EndInfo = { iface: clean(info.iface), ip: clean(info.ip), vlans, ...(vlanIps ? { vlanIps } : {}) };
  const filled = Object.values(next).some(Boolean);
  if (filled && (info.dx || info.dy)) Object.assign(next, { dx: info.dx, dy: info.dy });
  const ends = { ...c.ends, [end]: filled ? next : undefined };
  api.updateScene({
    elements: els.map((e) => (e.id === id ? newElementWith(e, { customData: { ...cd(e), cable: { ...c, ends } } }) : e)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

