// What sits at each end of the cables (interface, IP, VLANs), drawn next to the ends, and the
// small "int" button on the ends of the selected cable to fill it in.
import { useState } from "react";
import { Modal } from "../components/ui.tsx";
import { IP_RE, LABEL_RADIUS, parseVlans, type End, type EndInfo } from "./cables.ts";
import type { LinkState, LinkStates } from "./linkStatus.ts";

const linkText = (ip: string, l: LinkState) =>
  l.up ? `${ip} joignable depuis ${l.from}${l.ms !== undefined ? ` (${l.ms < 1 ? "<1" : Math.round(l.ms)} ms)` : ""}` : `${ip} injoignable depuis ${l.from}`;

/** One end of a cable, in viewport coordinates, `dir` pointing along the cable. */
export type CableMark = { cableId: string; end: End; x: number; y: number; dir: { x: number; y: number }; info?: EndInfo; selected: boolean };

/** Distance from the end of the cable to the label, along the cable (px). */
const ALONG = 18;
const SIDE = 6;

type Box = { w: number; h: number };
/** Rough size of a label (11px monospace) from its lines. */
const labelBox = (lines: string[]): Box => ({ w: Math.max(...lines.map((l) => l.length)) * 6.7 + 14, h: lines.length * 15 + 6 });
const BUTTON: Box = { w: 30, h: 20 };

/** The lines of a cable end's label (interface, IP, VLANs), in display order. */
export const labelLines = (i?: EndInfo) => [i?.iface, i?.ip, i?.vlans && `VLAN ${i.vlans}`].filter(Boolean) as string[];

/**
 * A box beside the cable end, clear of the item and of the cable: on one side of the cable
 * (`side`), growing along the cable away from the item. When the cable runs diagonally under the
 * box, the box steps aside by what the cable drifts over its length. Returns the corner the box
 * grows from and the growth direction on each axis.
 */
function anchor(m: { x: number; y: number; dir: { x: number; y: number } }, side: 1 | -1, box: Box) {
  const d = m.dir;
  let n = { x: -d.y, y: d.x };
  if (n.x < 0 || (n.x === 0 && n.y < 0)) n = { x: -n.x, y: -n.y };
  if (side === -1) n = { x: -n.x, y: -n.y };
  const sgn = (v: number) => (v < 0 ? -1 : 1);
  const horizontal = Math.abs(d.x) >= Math.abs(d.y);
  // Growth: away from the cable on the perpendicular axis, away from the item on the other.
  const gx = horizontal ? sgn(d.x) : sgn(n.x);
  const gy = horizontal ? sgn(n.y) : sgn(d.y);
  let x = m.x + d.x * ALONG + n.x * SIDE;
  let y = m.y + d.y * ALONG + n.y * SIDE;
  if (horizontal && sgn(d.y) === gy && d.y !== 0) y += gy * box.w * (Math.abs(d.y) / Math.abs(d.x));
  if (!horizontal && sgn(d.x) === gx && d.x !== 0) x += gx * box.h * (Math.abs(d.x) / Math.abs(d.y));
  return { x, y, gx, gy };
}

function place(m: CableMark, side: 1 | -1, box: Box, offset = { x: 0, y: 0 }): React.CSSProperties {
  const a = anchor(m, side, box);
  return { left: a.x + offset.x, top: a.y + offset.y, transform: `translate(${a.gx > 0 ? "0" : "-100%"}, ${a.gy > 0 ? "0" : "-100%"})` };
}

/**
 * Where a cable end's label sits at zoom 1, as a box (top-left corner and size): the same spot as
 * on screen, for an export. `p` and `dir` are the end and the cable's direction (scene units).
 */
export function labelRect(p: { x: number; y: number }, dir: { x: number; y: number }, info: EndInfo) {
  const lines = labelLines(info);
  const box = labelBox(lines);
  const a = anchor({ ...p, dir }, 1, box);
  return { x: a.x + (info.dx ?? 0) - (a.gx > 0 ? 0 : box.w), y: a.y + (info.dy ?? 0) - (a.gy > 0 ? 0 : box.h), w: box.w, h: box.h, lines };
}

export function CableOverlay({
  marks,
  zoom,
  editable,
  onEdit,
  onMoveLabel,
  links = {},
  mids = [],
}: {
  marks: CableMark[];
  /** Reachability of the IPs at the cable ends (by `${cableId}:${end}`). */
  links?: LinkStates;
  /** Middle of each cable with an IP, where its overall state shows. */
  mids?: { cableId: string; x: number; y: number }[];
  zoom: number;
  editable: boolean;
  onEdit: (m: CableMark) => void;
  /** A label was dragged: its offset from its default spot, in scene units. */
  onMoveLabel: (m: CableMark, dx: number, dy: number) => void;
}) {
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null);

  const startDrag = (e: React.PointerEvent, m: CableMark, key: string) => {
    if (!editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const ox = m.info?.dx ?? 0;
    const oy = m.info?.dy ?? 0;
    let cur = { dx: ox, dy: oy };
    const move = (ev: PointerEvent) => {
      let dx = ox + (ev.clientX - x0) / zoom;
      let dy = oy + (ev.clientY - y0) / zoom;
      const r = Math.hypot(dx, dy);
      if (r > LABEL_RADIUS) {
        dx *= LABEL_RADIUS / r;
        dy *= LABEL_RADIUS / r;
      }
      cur = { dx: Math.round(dx), dy: Math.round(dy) };
      setDrag({ key, ...cur });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDrag(null);
      if (cur.dx !== ox || cur.dy !== oy) onMoveLabel(m, cur.dx, cur.dy);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <>
      {marks.map((m) => {
        const i = m.info;
        const lines = labelLines(i);
        const key = `${m.cableId}:${m.end}`;
        const off = drag?.key === key ? drag : { dx: i?.dx ?? 0, dy: i?.dy ?? 0 };
        return (
          <div key={key}>
            {lines.length > 0 && (
              <div
                className={`cable-label ${m.selected ? "selected" : ""} ${editable ? "movable" : ""} ${drag?.key === key ? "dragging" : ""}`}
                style={place(m, 1, labelBox(lines), { x: off.dx * zoom, y: off.dy * zoom })}
                title={editable ? "Glisse pour déplacer l'étiquette (près du bout du câble)" : undefined}
                onPointerDown={(e) => startDrag(e, m, key)}
                onDoubleClick={() => editable && onEdit(m)}
              >
                {i!.iface && <b>{i!.iface}</b>}
                {i!.ip &&
                  (links[key] ? (
                    <span className="cable-ip" title={linkText(i!.ip, links[key])}>
                      <span className={`link-dot ${links[key].up ? "up" : "down"}`} />
                      {i!.ip}
                    </span>
                  ) : (
                    <span>{i!.ip}</span>
                  ))}
                {i!.vlans && <span className="vlan">VLAN {i!.vlans}</span>}
              </div>
            )}
            {editable && m.selected && (
              <button className="cable-int" style={place(m, -1, BUTTON)} title="Interface, IP et VLAN de cette extrémité" onClick={() => onEdit(m)}>
                int
              </button>
            )}
          </div>
        );
      })}
      {mids.map((m) => {
        const states = (["a", "b"] as End[]).map((e) => links[`${m.cableId}:${e}`]).filter((l): l is LinkState => !!l);
        if (!states.length) return null;
        const up = states.filter((l) => l.up).length;
        const state = up === states.length ? "up" : up === 0 ? "down" : "mixed";
        const text = state === "up" ? "Lien actif" : state === "down" ? "Lien coupé" : "Lien partiel";
        return (
          <div key={`mid:${m.cableId}`} className={`cable-state ${state}`} style={{ left: m.x, top: m.y }} role="img" aria-label={text} />
        );
      })}
    </>
  );
}

export function CableEndForm({ info, itemName, onSave, onClose }: { info?: EndInfo; itemName: string; onSave: (i: EndInfo) => void; onClose: () => void }) {
  const [iface, setIface] = useState(info?.iface ?? "");
  const [ip, setIp] = useState(info?.ip ?? "");
  const [vlans, setVlans] = useState(info?.vlans ?? "");
  const ipOk = !ip.trim() || IP_RE.test(ip.trim());
  const vlansNorm = vlans.trim() ? parseVlans(vlans) : "";
  const valid = ipOk && vlansNorm !== null;
  return (
    <Modal onClose={onClose} width={440}>
      <h2 className="display">Extrémité du câble</h2>
      <p>
        Côté <b>{itemName}</b>. Tout est facultatif.
      </p>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave({ iface, ip, vlans: vlansNorm ?? "" });
        }}
      >
        <label className="field">
          Interface
          <input className="input" autoFocus value={iface} onChange={(e) => setIface(e.target.value)} placeholder="Gi0/1, eth0, port 3…" maxLength={64} spellCheck={false} />
        </label>
        <label className="field">
          Adresse IP
          <input className="input" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.1/24" maxLength={64} spellCheck={false} />
          {!ipOk && <span className="field-help">Adresse IPv4 ou IPv6, avec un préfixe facultatif (/24).</span>}
        </label>
        <label className="field">
          VLAN(s)
          <input className="input" value={vlans} onChange={(e) => setVlans(e.target.value)} placeholder="10, 20, 30-35" maxLength={200} spellCheck={false} />
          <span className="field-help">{vlansNorm === null ? "Numéros de 1 à 4094 séparés par des virgules, ou des plages (30-35)." : "Séparés par des virgules."}</span>
        </label>
        <div className="modal-actions">
          {(info?.iface || info?.ip || info?.vlans) && (
            <button type="button" className="btn" style={{ marginRight: "auto" }} onClick={() => onSave({})}>
              Effacer
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={!valid}>
            Enregistrer
          </button>
        </div>
      </form>
    </Modal>
  );
}
