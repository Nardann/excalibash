// Removing a point of a line, arrow or cable: hold a point still for a moment, a small trash appears
// above it; drop the point on it and the point is gone. Released anywhere else, the point stays
// where it was dragged (Excalidraw's own behavior) and the trash goes away.
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { cableOf } from "./cables.ts";

type Api = ExcalidrawImperativeAPI;

/** How long a point must be held still before the trash shows (ms). */
const HOLD_MS = 1000;
/** Movement still counted as "not moving" (px). */
const STILL_PX = 4;
/** Trash center above the held point (px). */
const ABOVE = 56;
/** Extra margin around the trash for the drop (px). */
const DROP_SLOP = 10;

type Held = { id: string; index: number; x: number; y: number; hot: boolean };

/** The point that can be removed under the pointer, if any (a line keeps at least 2 points). */
function heldPoint(api: Api): Omit<Held, "hot"> | null {
  const st = api.getAppState();
  if (st.cursorButton !== "down") return null;
  const le = st.editingLinearElement ?? st.selectedLinearElement;
  const index = le?.pointerDownState?.lastClickedPoint ?? -1;
  if (!le || index < 0) return null;
  const el = api.getSceneElements().find((e) => e.id === le.elementId);
  if (!el || !("points" in el) || el.points.length <= 2 || index >= el.points.length) return null;
  // Elbow arrows route themselves; a cable's ends are its attachments.
  if ((el as any).elbowed) return null;
  if (cableOf(el) && (index === 0 || index === el.points.length - 1)) return null;
  const p = el.points[index];
  const z = st.zoom.value;
  return { id: el.id, index, x: (el.x + p[0] + st.scrollX) * z, y: (el.y + p[1] + st.scrollY) * z };
}

/** Removes one point of a line / arrow / cable: an undo step. */
export function removePoint(api: Api, id: string, index: number) {
  const els = api.getSceneElementsIncludingDeleted();
  const el = els.find((e) => e.id === id);
  if (!el || el.isDeleted || !("points" in el) || el.points.length <= 2 || index < 0 || index >= el.points.length) return;
  const abs = el.points.map((p) => [el.x + p[0], el.y + p[1]] as const).filter((_, i) => i !== index);
  const [ox, oy] = abs[0];
  const points = abs.map(([x, y]) => [x - ox, y - oy] as [number, number]);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const last = el.points.length - 1;
  const next = newElementWith(el, {
    x: ox,
    y: oy,
    points,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    // An arrow end bound to a shape no longer is once that end is removed.
    ...(index === 0 && "startBinding" in el ? { startBinding: null } : {}),
    ...(index === last && "endBinding" in el ? { endBinding: null } : {}),
  } as any);
  api.updateScene({
    elements: els.map((e) => (e.id === id ? next : e)),
    // The point editor still points at the removed index: leave it.
    appState: { editingLinearElement: null, selectedLinearElement: null, selectedElementIds: {} } as any,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

export function PointTrash({ api, editable }: { api: Api | null; editable: boolean }) {
  const [held, setHeld] = useState<Held | null>(null);
  const trashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!api || !editable) return;
    let timer: number | undefined;
    let start: { x: number; y: number } | null = null;
    let current: Held | null = null;
    const show = (h: Held | null) => {
      current = h;
      setHeld(h);
    };
    const overTrash = (e: PointerEvent) => {
      const r = trashRef.current?.getBoundingClientRect();
      return !!r && e.clientX >= r.left - DROP_SLOP && e.clientX <= r.right + DROP_SLOP && e.clientY >= r.top - DROP_SLOP && e.clientY <= r.bottom + DROP_SLOP;
    };
    const down = (e: PointerEvent) => {
      // Only presses on the drawing canvas (Excalidraw handles the point itself).
      if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement) || !e.target.closest(".excalidraw")) return;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        start = null;
        const p = heldPoint(api);
        if (p) show({ ...p, hot: false });
      }, HOLD_MS);
    };
    const move = (e: PointerEvent) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > STILL_PX) {
        clearTimeout(timer);
        start = null;
      }
      if (current) {
        const hot = overTrash(e);
        if (hot !== current.hot) show({ ...current, hot });
      }
    };
    const up = (e: PointerEvent) => {
      clearTimeout(timer);
      start = null;
      const h = current;
      const drop = !!h && e.type === "pointerup" && overTrash(e);
      show(null);
      // After Excalidraw has committed its own drag of the point.
      if (h && drop) setTimeout(() => removePoint(api, h.id, h.index), 0);
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [api, editable]);

  if (!held) return null;
  return (
    <div ref={trashRef} className={`point-trash ${held.hot ? "hot" : ""}`} style={{ left: held.x, top: held.y - ABOVE }} aria-hidden="true">
      <Trash2 size={18} />
    </div>
  );
}
