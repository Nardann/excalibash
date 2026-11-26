// Topology export: the cables of the diagram read as a network (nodes + links), then written as a
// Containerlab file, a Mermaid graph or JSON. Pure functions (no DOM, no Excalidraw runtime), so the
// whole thing is testable with plain node. Nothing here talks to the server: the board stays
// encrypted, the file is built in the browser from the decrypted scene.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cableOf, cd, IP_RE, parseVlans } from "./cableData.ts";
import { nodeDataOf } from "./nodeData.ts";

type El = ExcalidrawElement;

export type TopoNode = {
  id: string;
  /** Unique, Containerlab-safe name ([a-z0-9-_]). */
  name: string;
  /** The name as drawn on the board (display only). */
  label: string;
  kind: "machine" | "remote" | "shape";
  mgmt?: { host: string; port: number; kind: string };
};
export type TopoEnd = { node: string; iface?: string; ip?: string; vlans?: string; /** Address in a VLAN, by VLAN number. */ vlanIps?: Record<string, string> };
export type TopoLink = { a: TopoEnd; b: TopoEnd };
export type Topology = { nodes: TopoNode[]; links: TopoLink[]; warnings: string[] };

const FORMAT = "excalibash-topology/v1";

/** Containerlab-safe name: lowercase [a-z0-9-_], never empty. */
export function sanitizeName(raw: string, fallback = "noeud"): string {
  const s = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

/** Interface names: letters, digits and . _ / - only (it ends up in "node:iface"). */
const sanitizeIface = (raw: string) =>
  raw
    .trim()
    .replace(/[^A-Za-z0-9_./-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

const firstLine = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Key = { key: string; el: El; tile: boolean; members: El[] };

/**
 * Reads the board as a network. `nameOf` gives a machine icon's display name (as on the diagram).
 * Deleted elements, windows and orphaned cables are ignored; the order is deterministic.
 */
export function extractTopology(elements: readonly El[], nameOf: (nodeId: string) => string): Topology {
  const warnings: string[] = [];
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const isWindow = (e: El) => !!cd(e).nodeId && !!(cd(e).terminalId || cd(e).webId || cd(e).codeId || cd(e).notebookId);
  const cables = live.filter((e) => cableOf(e) && !cableOf(e)!.orphaned).sort((p, q) => cmp(p.id, q.id));

  // The anchor of a cable end -> the item (tile / shape / group) it stands for.
  const items = new Map<string, Key>();
  const tileOf = (e: El): Key => items.get(e.id) ?? (items.set(e.id, { key: e.id, el: e, tile: true, members: [e] }), items.get(e.id)!);
  const resolve = (a: { id?: string; group?: string; ids?: string[] }): Key | undefined => {
    if (a.group) {
      const members = live.filter((e) => e.groupIds.includes(a.group!) && !cableOf(e) && !isWindow(e));
      if (!members.length) {
        // Ungrouped since: whatever is left of the members (first one, by id).
        const left = (a.ids ?? []).map((i) => byId.get(i)).filter((e): e is El => !!e && !cableOf(e) && !isWindow(e)).sort((p, q) => cmp(p.id, q.id));
        return left.length ? resolve({ id: left[0].id }) : undefined;
      }
      const tile = members.filter((e) => nodeDataOf(e)).sort((p, q) => cmp(p.id, q.id))[0];
      if (tile) return tileOf(tile);
      const key = `group:${a.group}`;
      if (!items.has(key)) items.set(key, { key, el: members.sort((p, q) => cmp(p.id, q.id))[0], tile: false, members });
      return items.get(key);
    }
    const e = a.id ? byId.get(a.id) : undefined;
    if (!e || cableOf(e) || isWindow(e)) return undefined;
    if (nodeDataOf(e)) return tileOf(e);
    if (!items.has(e.id)) items.set(e.id, { key: e.id, el: e, tile: false, members: [e] });
    return items.get(e.id);
  };

  type Info = { iface?: string; ip?: string; vlans?: string; vlanIps?: Record<string, string> };
  type Raw = { id: string; a: Key; b: Key; ea?: Info; eb?: Info };
  const raws: Raw[] = [];
  for (const el of cables) {
    const c = cableOf(el)!;
    const a = resolve(c.a);
    const b = resolve(c.b);
    if (!a || !b) continue; // an end is gone: orphaned cable
    if (a.key === b.key) {
      warnings.push("Un câble relie un élément à lui-même : ignoré.");
      continue;
    }
    raws.push({ id: el.id, a, b, ea: c.ends?.a, eb: c.ends?.b });
  }

  // Nodes: every machine tile, plus any shape a cable is attached to.
  for (const e of live) if (nodeDataOf(e) && !isWindow(e)) tileOf(e);

  const textOf = (k: Key): string => {
    const texts = (k.tile ? [] : live.filter((e) => e.type === "text" && ((k.members.length === 1 && (e as any).containerId === k.el.id) || k.members.some((m) => m.id === e.id))))
      .map((e) => firstLine((e as any).text ?? ""))
      .filter(Boolean);
    return texts[0] ?? "";
  };
  const labelled = [...items.values()].map((k) => {
    let label = "";
    if (k.tile) label = firstLine(nameOf(k.el.id) ?? "") || "machine";
    else label = textOf(k);
    return { k, label };
  });
  // Unlabelled shapes: noeud-1, noeud-2… in id order.
  let n = 0;
  for (const l of labelled.filter((l) => !l.label).sort((p, q) => cmp(p.k.key, q.k.key))) l.label = `noeud-${++n}`;
  labelled.sort((p, q) => cmp(sanitizeName(p.label), sanitizeName(q.label)) || cmp(p.label, q.label) || cmp(p.k.key, q.k.key));

  const used = new Set<string>();
  const nodes: TopoNode[] = labelled.map(({ k, label }) => {
    const base = sanitizeName(label);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    const nd = k.tile ? nodeDataOf(k.el) : undefined;
    const node: TopoNode = { id: k.key, name, label, kind: nd?.remote ? "remote" : k.tile ? "machine" : "shape" };
    if (nd?.remote) node.mgmt = { host: nd.remote.target.host, port: nd.remote.target.port, kind: nd.remote.target.kind };
    return node;
  });
  const nameById = new Map(nodes.map((x) => [x.id, x.name]));

  // Deterministic link order: by node names, then cable id.
  raws.sort((p, q) => cmp(nameById.get(p.a.key)!, nameById.get(q.a.key)!) || cmp(nameById.get(p.b.key)!, nameById.get(q.b.key)!) || cmp(p.id, q.id));

  // Interfaces: explicit ones first (cleaned, duplicates per node refused), then eth1, eth2… for the rest.
  const ifaces = new Map<string, Set<string>>();
  const taken = (node: string) => ifaces.get(node) ?? (ifaces.set(node, new Set()), ifaces.get(node)!);
  type Slot = { node: string; peer: string; info?: Info; out: TopoEnd };
  const slots: Slot[] = [];
  const links: TopoLink[] = raws.map((r) => {
    const mk = (k: Key, other: Key, info: Raw["ea"]): TopoEnd => {
      const out: TopoEnd = { node: k.key };
      slots.push({ node: k.key, peer: other.key, info, out });
      return out;
    };
    return { a: mk(r.a, r.b, r.ea), b: mk(r.b, r.a, r.eb) };
  });
  for (const s of slots) {
    const me = nameById.get(s.node)!;
    const peer = nameById.get(s.peer)!;
    const raw = s.info?.iface;
    if (raw) {
      const clean = sanitizeIface(raw);
      if (clean && !taken(s.node).has(clean)) {
        if (clean !== raw) warnings.push(`« ${me} » : interface « ${raw} » renommée en « ${clean} » (caractères non autorisés).`);
        taken(s.node).add(clean);
        s.out.iface = clean;
      } else if (clean) {
        warnings.push(`« ${me} » : interface « ${clean} » utilisée sur plusieurs câbles, une autre est générée.`);
      }
    }
    // IP and VLANs are kept only when well-formed: they end up in generated files.
    const ip = s.info?.ip;
    if (ip) {
      if (IP_RE.test(ip)) s.out.ip = ip;
      else warnings.push(`« ${me} » vers « ${peer} » : adresse IP « ${ip.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")} » invalide, ignorée.`);
    }
    const vlans = s.info?.vlans ? parseVlans(s.info.vlans) : null;
    if (s.info?.vlans) {
      if (vlans) s.out.vlans = vlans;
      else warnings.push(`« ${me} » vers « ${peer} » : VLAN « ${s.info.vlans.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")} » invalide, ignoré.`);
    }
    // Addresses in VLANs: only for a VLAN of this end (a single one, not a range), well-formed.
    if (vlans && s.info?.vlanIps) {
      const listed = new Set(vlans.split(", "));
      const out: Record<string, string> = {};
      for (const [v, vip] of Object.entries(s.info.vlanIps)) {
        if (!listed.has(v)) continue;
        if (IP_RE.test(vip)) out[v] = vip;
        else warnings.push(`« ${me} » vers « ${peer} » : adresse « ${vip.slice(0, 40).replace(/[^\x20-\x7e]/g, "?")} » du VLAN ${v} invalide, ignorée.`);
      }
      if (Object.keys(out).length) s.out.vlanIps = out;
    }
  }
  const counters = new Map<string, number>();
  for (const s of slots) {
    if (s.out.iface) continue;
    const me = nameById.get(s.node)!;
    let i = counters.get(s.node) ?? 0;
    let name: string;
    do name = `eth${++i}`;
    while (taken(s.node).has(name));
    counters.set(s.node, i);
    taken(s.node).add(name);
    s.out.iface = name;
    warnings.push(`« ${me} » : interface non renseignée sur le câble vers « ${nameById.get(s.peer)} », « ${name} » générée.`);
  }
  // Tidy key order: node, iface, ip, vlans, vlanIps.
  for (const l of links) for (const e of [l.a, l.b]) {
    const { node, iface, ip, vlans, vlanIps } = e;
    for (const k of Object.keys(e)) delete (e as any)[k];
    Object.assign(e, { node, iface, ...(ip ? { ip } : {}), ...(vlans ? { vlans } : {}), ...(vlanIps ? { vlanIps } : {}) });
  }
  return { nodes, links, warnings };
}

// ---- Containerlab (YAML) ------------------------------------------------------------------

const RESERVED = new Set(["true", "false", "null", "yes", "no", "y", "n", "on", "off", "~"]);
/** A YAML scalar: plain when it is obviously safe, else a double-quoted (JSON) string. */
export const yamlStr = (s: string) => (/^[a-z_][a-z0-9_-]*$/.test(s) && !RESERVED.has(s) ? s : JSON.stringify(s));
/** Text for a YAML comment: one line, printable characters only. */
const comment = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
/** Strict whitelist for what goes into an `ip addr add` line: address with a prefix length. */
const execIp = (ip?: string) => (ip && /^[0-9A-Fa-f:.]+\/\d{1,3}$/.test(ip) && IP_RE.test(ip) ? ip : undefined);
const execIface = (i?: string) => (i && /^[A-Za-z0-9_.-]{1,32}$/.test(i) ? i : undefined);

/** A Containerlab topology file. Kind and image are placeholders to adjust per node. */
export function toContainerlab(topo: Topology, labName: string): string {
  const name = new Map(topo.nodes.map((n) => [n.id, n.name]));
  const out: string[] = [
    "# Généré par Excalibash. Le kind et l'image de chaque nœud sont des valeurs par défaut :",
    "# adapte-les au matériel réel (ex. kind: nokia_srlinux, ceos, vr-sros... avec l'image correspondante).",
    "# Containerlab n'a pas de champ pour les IP et les VLAN : ils sont notés en commentaire à côté de",
    "# chaque lien. Les IP avec masque (ex. 10.0.0.1/24) sont aussi posées par exec sur les nœuds linux,",
    "# celles d'un VLAN sur une sous-interface (eth1.10).",
    `name: ${yamlStr(sanitizeName(labName, "schema"))}`,
    "topology:",
  ];
  if (!topo.nodes.length) out.push("  nodes: {}");
  else out.push("  nodes:");
  for (const n of topo.nodes) {
    out.push(`    ${yamlStr(n.name)}:`);
    if (n.mgmt) out.push(`      # accès ${comment(n.mgmt.kind)} ${comment(n.mgmt.host)}:${Number(n.mgmt.port) || 0} (équipement distant)`);
    out.push("      kind: linux", "      image: alpine:latest");
    const execs: string[] = [];
    for (const l of topo.links) for (const e of [l.a, l.b]) {
      const ip = execIp(e.ip);
      const iface = execIface(e.iface);
      if (e.node === n.id && ip && iface) execs.push(`ip addr add ${ip} dev ${iface}`);
      // A VLAN with an address: a VLAN subinterface (eth1.10) carrying it.
      for (const [v, vip] of Object.entries(e.node === n.id && iface ? (e.vlanIps ?? {}) : {})) {
        const addr = execIp(vip);
        const sub = execIface(`${iface}.${v}`);
        if (!addr || !sub || !/^\d{1,4}$/.test(v) || sub.length > 15) continue;
        execs.push(`ip link add link ${iface} name ${sub} type vlan id ${v}`, `ip link set ${sub} up`, `ip addr add ${addr} dev ${sub}`);
      }
    }
    if (execs.length) out.push("      exec:", ...execs.map((x) => `        - ${JSON.stringify(x)}`));
  }
  if (!topo.links.length) out.push("  links: []");
  else out.push("  links:");
  for (const l of topo.links) {
    for (const e of [l.a, l.b]) {
      const vlanIps = Object.entries(e.vlanIps ?? {}).map(([v, vip]) => `VLAN ${comment(v)} ip ${comment(vip)}`);
      const extra = [e.ip ? `ip ${comment(e.ip)}` : "", e.vlans ? `VLAN ${comment(e.vlans)}` : "", ...vlanIps].filter(Boolean).join(", ");
      if (extra) out.push(`    # ${comment(name.get(e.node) ?? "?")}:${comment(e.iface ?? "?")} : ${extra}`);
    }
    out.push(`    - endpoints: [${[l.a, l.b].map((e) => JSON.stringify(`${name.get(e.node)}:${e.iface}`)).join(", ")}]`);
  }
  return out.join("\n") + "\n";
}

// ---- Mermaid ------------------------------------------------------------------------------

/** Mermaid text inside double quotes: entity codes for what would end the string or be markup. */
const mm = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/&/g, "#amp;");

export function toMermaid(topo: Topology): string {
  const id = new Map(topo.nodes.map((n, i) => [n.id, `n${i}`]));
  const out = ["graph LR"];
  for (const n of topo.nodes) out.push(`  ${id.get(n.id)}["${mm(n.label)}"]`);
  for (const l of topo.links) out.push(`  ${id.get(l.a.node)} ---|"${mm(`${l.a.iface ?? "?"} — ${l.b.iface ?? "?"}`)}"| ${id.get(l.b.node)}`);
  return out.join("\n") + "\n";
}

// ---- JSON ---------------------------------------------------------------------------------

export const toJSON = (topo: Topology): string => JSON.stringify({ format: FORMAT, nodes: topo.nodes, links: topo.links, warnings: topo.warnings }, null, 2) + "\n";
