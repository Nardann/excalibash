// What sits at each end of the cables (interface, IP, VLANs), drawn next to the ends, and the
// small "int" button on the ends of the selected cable to fill it in.
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Modal, toast } from "../components/ui.tsx";
import { IP_RE, LABEL_RADIUS, parseVlans, vlanLines, vlanParts, type End, type EndInfo } from "./cables.ts";
import { FileClient, IFACE_RE, filterProblem, type Signal } from "./fileTransfer.ts";
import { saveBlob, exportName } from "./termTools.ts";
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
export const labelLines = (i?: EndInfo) => [i?.iface, i?.ip, ...vlanLines(i)].filter(Boolean) as string[];

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
                {vlanParts(i).plain.length > 0 && <span className="vlan">VLAN {vlanParts(i).plain.join(", ")}</span>}
                {vlanParts(i).withIp.map(([v, vip]) => {
                  const l = links[`${key}:v${v}`];
                  return (
                    <span key={v} className="vlan cable-ip" title={l ? `VLAN ${v} : ${linkText(vip, l)}` : undefined}>
                      {l && <span className={`link-dot ${l.up ? "up" : "down"}`} />}
                      VLAN {v} {vip}
                    </span>
                  );
                })}
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
        // Every address of the cable counts: the ends' IPs and their VLAN interfaces.
        const states = Object.entries(links)
          .filter(([k]) => k.startsWith(`${m.cableId}:`))
          .map(([, l]) => l);
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

/** One VLAN row of the form: a VLAN (or a range) and, for a single VLAN, its address. */
type VlanRow = { vlan: string; ip: string };

function rowsOf(info?: EndInfo): VlanRow[] {
  const parts = info?.vlans ? (parseVlans(info.vlans) ?? info.vlans).split(",").map((p) => p.trim()).filter(Boolean) : [];
  const ips = info?.vlanIps ?? {};
  return parts.map((vlan) => ({ vlan, ip: Object.hasOwn(ips, vlan) && typeof ips[vlan] === "string" ? ips[vlan] : "" }));
}

const isSingleVlan = (v: string) => /^\d{1,4}$/.test(v.trim());

/**
 * Packet capture on the interface at this cable end, run by the agent of the item's machine through
 * its local shell (tcpdump). The pcap goes straight to the browser, sealed with the shell's key.
 */
function CapturePanel({ client, iface }: { client: FileClient; iface: string }) {
  const [seconds, setSeconds] = useState(30);
  const [filter, setFilter] = useState("");
  const [mib, setMib] = useState(20);
  const [bytes, setBytes] = useState<number | null>(null);
  const signal = useRef<Signal | null>(null);
  const ifaceOk = IFACE_RE.test(iface.trim());
  const problem = filterProblem(filter);
  const valid = ifaceOk && !problem && seconds >= 1 && seconds <= 300 && mib >= 1 && mib <= 50;
  useEffect(() => () => void (signal.current && (signal.current.aborted = true)), []);

  const start = async () => {
    const s: Signal = { aborted: false };
    signal.current = s;
    setBytes(0);
    try {
      const { name, blob } = await client.capture(
        { iface: iface.trim(), filter: filter.trim() || undefined, seconds, maxBytes: Math.round(mib * 1024 * 1024) },
        { signal: s, onProgress: setBytes },
      );
      saveBlob(blob, exportName(name.replace(/\.pcap$/, ""), "pcap"));
      toast(`Capture terminée : ${(blob.size / 1024).toFixed(0)} Kio téléchargés`);
    } catch (e) {
      toast.error(e);
    } finally {
      signal.current = null;
      setBytes(null);
    }
  };

  return (
    <fieldset className="capture-box">
      <legend>Capturer (pcap)</legend>
      {bytes === null ? (
        <>
          <div className="capture-row">
            <label className="field">
              Durée (s)
              <input className="input" type="number" min={1} max={300} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <label className="field">
              Taille max (Mio)
              <input className="input" type="number" min={1} max={50} value={mib} onChange={(e) => setMib(Number(e.target.value))} />
            </label>
          </div>
          <label className="field">
            Filtre BPF (facultatif)
            <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="tcp port 80 and host 10.0.0.1" spellCheck={false} />
            {problem && <span className="field-help">{problem}</span>}
          </label>
          <button type="button" className="btn" disabled={!valid} onClick={start} title={ifaceOk ? undefined : "Nom d'interface invalide : utilise celui de la machine (eth0, enp3s0, br-lan…)"}>
            Capturer sur {iface.trim() || "…"}
          </button>
          <span className="field-help">tcpdump tourne sur la machine : l'agent doit être root (ou tcpdump avoir CAP_NET_RAW). Le fichier .pcap arrive chiffré de bout en bout.</span>
        </>
      ) : (
        <div className="capture-row">
          <span>{(bytes / 1024).toFixed(1)} Kio capturés…</span>
          <button type="button" className="btn" onClick={() => signal.current && (signal.current.stop = true)}>
            Arrêter
          </button>
          <button type="button" className="btn" onClick={() => signal.current && (signal.current.aborted = true)}>
            Annuler
          </button>
        </div>
      )}
    </fieldset>
  );
}

export function CableEndForm({
  info,
  itemName,
  onSave,
  onClose,
  capture,
}: {
  info?: EndInfo;
  itemName: string;
  onSave: (i: EndInfo) => void;
  onClose: () => void;
  /** A running local shell on the item's machine, when there is one: enables the capture. */
  capture?: FileClient | null;
}) {
  const [iface, setIface] = useState(info?.iface ?? "");
  const [ip, setIp] = useState(info?.ip ?? "");
  const [rows, setRows] = useState<VlanRow[]>(() => rowsOf(info));
  const ipOk = !ip.trim() || IP_RE.test(ip.trim());
  const filled = rows.filter((r) => r.vlan.trim());
  const rowError = (r: VlanRow) => {
    if (!r.vlan.trim()) return r.ip.trim() ? "Indique le numéro du VLAN." : null;
    const v = parseVlans(r.vlan);
    if (v === null || v.includes(",")) return "Un VLAN de 1 à 4094, ou une plage (30-35).";
    if (r.ip.trim() && !isSingleVlan(r.vlan)) return "Une adresse va sur un seul VLAN, pas sur une plage.";
    if (r.ip.trim() && !IP_RE.test(r.ip.trim())) return "Adresse IPv4 ou IPv6, avec un préfixe facultatif (/24).";
    return null;
  };
  const valid = ipOk && rows.every((r) => !rowError(r));
  const setRow = (i: number, patch: Partial<VlanRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () => {
    const vlans = filled.length ? (parseVlans(filled.map((r) => r.vlan).join(",")) ?? "") : "";
    const vlanIps: Record<string, string> = {};
    for (const r of filled) if (isSingleVlan(r.vlan) && r.ip.trim()) vlanIps[String(+r.vlan.trim())] = r.ip.trim();
    onSave({ iface, ip, vlans, ...(Object.keys(vlanIps).length ? { vlanIps } : {}) });
  };

  return (
    <Modal onClose={onClose} width={480}>
      <h2 className="display">Extrémité du câble</h2>
      <p>
        Côté <b>{itemName}</b>. Tout est facultatif.
      </p>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save();
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
        <div className="field">
          VLAN(s)
          {rows.map((r, i) => {
            const err = rowError(r);
            return (
              <div key={i} className="vlan-row">
                <input
                  className="input vlan-num"
                  value={r.vlan}
                  onChange={(e) => setRow(i, { vlan: e.target.value })}
                  placeholder="10"
                  aria-label={`VLAN ${i + 1}`}
                  maxLength={9}
                  spellCheck={false}
                  autoFocus={!r.vlan && i === rows.length - 1}
                />
                <input
                  className="input"
                  value={r.ip}
                  onChange={(e) => setRow(i, { ip: e.target.value })}
                  placeholder={isSingleVlan(r.vlan) || !r.vlan.trim() ? "IP dans ce VLAN (facultatif)" : "pas d'IP sur une plage"}
                  disabled={!!r.vlan.trim() && !isSingleVlan(r.vlan) && !r.ip}
                  aria-label={`Adresse IP dans le VLAN ${r.vlan || i + 1}`}
                  maxLength={64}
                  spellCheck={false}
                />
                <button type="button" className="btn btn-sm btn-icon" title="Retirer ce VLAN" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
                {err && <span className="field-help vlan-err">{err}</span>}
              </div>
            );
          })}
          <button type="button" className="btn btn-sm vlan-add" onClick={() => setRows((rs) => [...rs, { vlan: "", ip: "" }])}>
            <Plus size={14} /> Ajouter un VLAN
          </button>
        </div>
        {capture && iface.trim() && <CapturePanel client={capture} iface={iface} />}
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
