// Device configuration generated from the cables of one node: Cisco IOS commands, Linux `ip`
// commands or a netplan file. Pure functions (no DOM, no Excalidraw runtime), testable with plain
// node. Everything that ends up in the output is re-validated here against a strict whitelist,
// whatever the topology says: a cable label can never add a line (newline, `;`, `!`…) to a
// configuration that the user may paste or send into a console.
import { IP_RE, parseVlans } from "./cableData.ts";
import { yamlStr, type Topology } from "./topology.ts";

/** What one interface of a node carries, merged from all the cable ends that name it. */
export type IfaceConf = {
  iface: string;
  /** Address, with its prefix length when known ("10.0.0.1/24"). */
  ip?: string;
  /** Every VLAN of the interface, sorted, without duplicates. */
  vlans: number[];
  /** The same, as a compact list ("10,20,30-35"). */
  vlanList: string;
  /** Address in a VLAN, by VLAN number (SVI, sub-interface). */
  vlanIps: Record<string, string>;
  peer: { name: string; iface: string };
};
export type Generated = { text: string; warnings: string[] };
export type NodeRef = { name: string };
export type CiscoOpts = { mode: "switch" | "routeur"; /** Emit `hostname`. */ hostname?: boolean; /** `configure terminal` … `end`. */ wrap?: boolean };

// ---- Validation ----------------------------------------------------------------------------

/** Cisco-style names too: GigabitEthernet0/1, Gi0/1.10, Port-channel1, eth0:1. */
const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,63}$/;
/** Linux kernel names: 15 characters at most, no "/" or ":". */
const LINUX_IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/;
const MAX_LINUX_VLANS = 64;

const show = (s: unknown) => String(s).slice(0, 40).replace(/[^\x20-\x7e]/g, "?");
const isVlan = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 4094;
const cleanWord = (s: unknown, extra = "") => String(s ?? "").replace(new RegExp(`[^A-Za-z0-9._${extra}-]+`, "g"), "-").replace(/^-+|-+$/g, "").slice(0, 64);

type Ip = { v: 4 | 6; addr: string; len?: number };
/** An address in the shape the generators accept: IPv4 or IPv6, optional prefix, no zone. */
function parseIp(raw: unknown): Ip | null {
  if (typeof raw !== "string" || !IP_RE.test(raw) || raw.includes("%")) return null;
  const [addr, p] = raw.split("/");
  const len = p === undefined ? undefined : Number(p);
  if (addr.includes(":")) return /^[0-9A-Fa-f:.]+$/.test(addr) && addr.split(":").length > 2 ? { v: 6, addr, len } : null;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) ? { v: 4, addr, len } : null;
}

/** Dotted netmask of an IPv4 prefix length (0 to 32). */
export function prefixToMask(len: number): string {
  const m = len <= 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join(".");
}

/** "10, 20, 30-35" (as parseVlans normalizes it) -> sorted numbers. */
function expandVlans(list: string): number[] {
  const out = new Set<number>();
  for (const part of list.split(",")) {
    const [lo, hi] = part.trim().split("-").map(Number);
    for (let n = lo; n <= (hi ?? lo); n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Sorted VLAN numbers -> "10,20,30-35". */
export function vlanRanges(vlans: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < vlans.length; ) {
    let j = i;
    while (j + 1 < vlans.length && vlans[j + 1] === vlans[j] + 1) j++;
    out.push(j > i ? `${vlans[i]}-${vlans[j]}` : `${vlans[i]}`);
    i = j + 1;
  }
  return out.join(",");
}

const parts = (s: string) => s.match(/\d+|\D+/g) ?? [];
/** Natural, locale-independent order: Gi0/2 before Gi0/10. */
function natural(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d/.test(x[i]);
    const ny = /^\d/.test(y[i]);
    if (nx && ny) return Number(x[i]) - Number(y[i]) || (x[i] < y[i] ? -1 : 1);
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Re-validates an interface: drops (with a French warning) whatever is not safe to write out.
 * Returns null when the interface itself is unusable.
 */
function sane(i: IfaceConf, warnings: string[]): IfaceConf | null {
  if (typeof i.iface !== "string" || !IFACE_RE.test(i.iface)) {
    warnings.push(`Interface « ${show(i.iface)} » ignorée : nom invalide (lettres, chiffres et / . _ : - seulement).`);
    return null;
  }
  const me = i.iface;
  const out: IfaceConf = { iface: me, vlans: [], vlanList: "", vlanIps: {}, peer: { name: cleanWord(i.peer?.name) || "voisin", iface: cleanWord(i.peer?.iface, "/:") } };
  if (i.ip !== undefined) {
    if (parseIp(i.ip)) out.ip = i.ip;
    else warnings.push(`« ${me} » : adresse IP « ${show(i.ip)} » invalide, ignorée.`);
  }
  const vlans = [...new Set(Array.isArray(i.vlans) ? i.vlans : [])];
  const bad = vlans.filter((v) => !isVlan(v));
  if (bad.length) warnings.push(`« ${me} » : VLAN « ${show(bad[0])} » invalide (1 à 4094), ignoré.`);
  out.vlans = vlans.filter(isVlan).sort((a, b) => a - b);
  out.vlanList = vlanRanges(out.vlans);
  for (const [v, ip] of Object.entries(i.vlanIps ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (!/^\d{1,4}$/.test(v) || !out.vlans.includes(Number(v))) warnings.push(`« ${me} » : adresse du VLAN « ${show(v)} » ignorée (VLAN absent de l'interface).`);
    else if (!parseIp(ip)) warnings.push(`« ${me} » : adresse « ${show(ip)} » du VLAN ${v} invalide, ignorée.`);
    else out.vlanIps[String(Number(v))] = ip;
  }
  return out;
}

/** `sane` on a whole list: sorted, one entry per interface name. */
function prepare(ifaces: readonly IfaceConf[], warnings: string[], nameRe?: RegExp): IfaceConf[] {
  const seen = new Set<string>();
  const out: IfaceConf[] = [];
  for (const raw of ifaces) {
    const i = sane(raw, warnings);
    if (!i) continue;
    if (nameRe && !nameRe.test(i.iface)) {
      warnings.push(`Interface « ${i.iface} » ignorée : nom non utilisable sous Linux (15 caractères au plus, sans / ni :).`);
      continue;
    }
    if (seen.has(i.iface)) {
      warnings.push(`Interface « ${i.iface} » en double : la première est gardée.`);
      continue;
    }
    seen.add(i.iface);
    out.push(i);
  }
  return out.sort((a, b) => natural(a.iface, b.iface));
}

// ---- Interfaces of a node ------------------------------------------------------------------

/**
 * The interfaces of one node, merged from all its cable ends. The same interface on two cables is
 * merged (and warned about). Sorted by interface name, so the output is deterministic.
 */
export function nodeInterfaces(topo: Topology, nodeId: string): { ifaces: IfaceConf[]; warnings: string[] } {
  const warnings: string[] = [];
  const names = new Map(topo.nodes.map((n) => [n.id, n.name]));
  const merged = new Map<string, IfaceConf>();
  for (const l of topo.links) {
    for (const [me, other] of [[l.a, l.b], [l.b, l.a]] as const) {
      if (me.node !== nodeId) continue;
      if (typeof me.iface !== "string" || !IFACE_RE.test(me.iface)) {
        warnings.push(me.iface ? `Interface « ${show(me.iface)} » ignorée : nom invalide (lettres, chiffres et / . _ : - seulement).` : "Une extrémité de câble sans interface est ignorée.");
        continue;
      }
      let vlans: number[] = [];
      if (me.vlans) {
        const ok = parseVlans(String(me.vlans));
        if (ok) vlans = expandVlans(ok);
        else warnings.push(`« ${me.iface} » : VLAN « ${show(me.vlans)} » invalide, ignoré.`);
      }
      const peer = { name: names.get(other.node) ?? "voisin", iface: other.iface ?? "" };
      const have = merged.get(me.iface);
      if (!have) {
        merged.set(me.iface, { iface: me.iface, ...(me.ip ? { ip: me.ip } : {}), vlans, vlanList: "", vlanIps: { ...(vlans.length ? (me.vlanIps ?? {}) : {}) }, peer });
        continue;
      }
      warnings.push(`« ${me.iface} » : interface utilisée sur plusieurs câbles, réglages fusionnés.`);
      if (me.ip && have.ip && me.ip !== have.ip) warnings.push(`« ${me.iface} » : deux adresses différentes (« ${show(have.ip)} » et « ${show(me.ip)} »), la première est gardée.`);
      if (me.ip && !have.ip) have.ip = me.ip;
      have.vlans = [...new Set([...have.vlans, ...vlans])];
      for (const [v, ip] of Object.entries(vlans.length ? (me.vlanIps ?? {}) : {})) have.vlanIps[v] ??= ip;
    }
  }
  const ifaces = prepare([...merged.values()], warnings);
  return { ifaces, warnings };
}

// ---- Cisco IOS -----------------------------------------------------------------------------

const ciscoHost = (name: string, fallback: string) => {
  const h = String(name).replace(/[^A-Za-z0-9-]+/g, "-").replace(/^[^A-Za-z]+/, "").replace(/-+$/g, "").slice(0, 63);
  return h || fallback;
};

/** IOS address line for an address with a prefix; null (and a warning) when there is none. */
function ciscoAddr(ip: string, where: string, warnings: string[]): string | null {
  const p = parseIp(ip)!;
  if (p.len === undefined) {
    warnings.push(`${where} : adresse « ${ip} » sans masque (ex. ${p.v === 4 ? "10.0.0.1/24" : "2001:db8::1/64"}), ligne d'adresse omise.`);
    return null;
  }
  return p.v === 4 ? `ip address ${p.addr} ${prefixToMask(p.len)}` : `ipv6 address ${p.addr}/${p.len}`;
}

/**
 * Cisco IOS commands. "switch": access / trunk ports, `vlan N` definitions, VLAN interfaces (SVI)
 * for the addresses in a VLAN. "routeur": router-on-a-stick, one `.N` sub-interface per VLAN that
 * has an address.
 */
export function toCiscoIOS(node: NodeRef, ifaces: readonly IfaceConf[], opts: CiscoOpts): Generated {
  const warnings: string[] = [];
  const list = prepare(ifaces, warnings);
  const sw = opts.mode === "switch";
  const out: string[] = [];
  if (opts.wrap) out.push("configure terminal");
  if (opts.hostname) out.push(`hostname ${ciscoHost(node.name, sw ? "switch" : "routeur")}`);
  if (sw) {
    const all = [...new Set(list.flatMap((i) => i.vlans))].sort((a, b) => a - b);
    if (all.length && all.length <= 100) for (const v of all) out.push(`vlan ${v}`);
    else if (all.length) out.push(`vlan ${vlanRanges(all)}`);
  }
  const svis = new Map<number, string>();
  for (const i of list) {
    const where = `« ${i.iface} »`;
    out.push(`interface ${i.iface}`);
    if (i.peer.name) out.push(` description vers ${i.peer.name}${i.peer.iface ? ` ${i.peer.iface}` : ""}`);
    if (sw && i.vlans.length) {
      if (i.vlans.length === 1) out.push(" switchport mode access", ` switchport access vlan ${i.vlans[0]}`);
      else out.push(" switchport mode trunk", ` switchport trunk allowed vlan ${i.vlanList}`);
      if (i.ip) warnings.push(`${where} : adresse « ${i.ip} » ignorée sur un port de commutation (utilise une adresse de VLAN).`);
      for (const [v, ip] of Object.entries(i.vlanIps)) {
        if (!svis.has(Number(v))) svis.set(Number(v), ip);
        else if (svis.get(Number(v)) !== ip) warnings.push(`VLAN ${v} : deux adresses différentes, la première est gardée.`);
      }
    } else if (i.ip) {
      const line = ciscoAddr(i.ip, where, warnings);
      if (line) out.push(` ${line}`);
    }
    out.push(" no shutdown");
    if (!sw && i.vlans.length) {
      const bare = i.vlans.filter((v) => !i.vlanIps[v]);
      if (bare.length) warnings.push(`${where} : VLAN ${vlanRanges(bare)} sans adresse, pas de sous-interface générée.`);
      for (const v of i.vlans.filter((v) => i.vlanIps[v])) {
        out.push(`interface ${i.iface}.${v}`, ` encapsulation dot1Q ${v}`);
        const line = ciscoAddr(i.vlanIps[v], `${where} VLAN ${v}`, warnings);
        if (line) out.push(` ${line}`);
      }
    }
  }
  for (const [v, ip] of [...svis].sort((a, b) => a[0] - b[0])) {
    out.push(`interface Vlan${v}`);
    const line = ciscoAddr(ip, `VLAN ${v}`, warnings);
    if (line) out.push(` ${line}`);
    out.push(" no shutdown");
  }
  if (opts.wrap) out.push("end");
  return { text: out.join("\n") + "\n", warnings };
}

// ---- Linux ---------------------------------------------------------------------------------

/** An address that `ip addr add` / netplan accept: with its prefix length, else a warning. */
function withPrefix(ip: string, where: string, warnings: string[]): string | null {
  const p = parseIp(ip)!;
  if (p.len === undefined) {
    warnings.push(`${where} : adresse « ${ip} » sans préfixe (ex. ${p.v === 4 ? "10.0.0.1/24" : "2001:db8::1/64"}), omise.`);
    return null;
  }
  return `${p.addr}/${p.len}`;
}

/** VLAN sub-interfaces to create on a Linux interface (capped), with a warning when cut. */
function linuxVlans(i: IfaceConf, warnings: string[]): { v: number; sub: string }[] {
  const out: { v: number; sub: string }[] = [];
  for (const v of i.vlans) {
    const sub = `${i.iface}.${v}`;
    if (!LINUX_IFACE_RE.test(sub)) {
      warnings.push(`« ${i.iface} » : sous-interface « ${sub} » trop longue pour Linux (15 caractères), VLAN ${v} ignoré.`);
      continue;
    }
    if (out.length >= MAX_LINUX_VLANS) {
      warnings.push(`« ${i.iface} » : plus de ${MAX_LINUX_VLANS} VLAN, les suivants sont ignorés.`);
      break;
    }
    out.push({ v, sub });
  }
  return out;
}

/** `ip` commands (iproute2), to run as root. */
export function toLinuxIproute(node: NodeRef, ifaces: readonly IfaceConf[], opts: { hostname?: boolean } = {}): Generated {
  const warnings: string[] = [];
  const list = prepare(ifaces, warnings, LINUX_IFACE_RE);
  const out: string[] = [`# Généré par Excalibash pour « ${cleanWord(node.name) || "noeud"} » : à exécuter en root.`];
  if (opts.hostname) out.push(`hostnamectl set-hostname ${cleanWord(node.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "noeud"}`);
  for (const i of list) {
    out.push(`# ${i.iface} vers ${i.peer.name}${i.peer.iface ? ` ${i.peer.iface}` : ""}`, `ip link set dev ${i.iface} up`);
    const addr = i.ip && withPrefix(i.ip, `« ${i.iface} »`, warnings);
    if (addr) out.push(`ip addr add ${addr} dev ${i.iface}`);
    for (const { v, sub } of linuxVlans(i, warnings)) {
      out.push(`ip link add link ${i.iface} name ${sub} type vlan id ${v}`);
      const va = i.vlanIps[v] && withPrefix(i.vlanIps[v], `« ${i.iface} » VLAN ${v}`, warnings);
      if (va) out.push(`ip addr add ${va} dev ${sub}`);
      out.push(`ip link set dev ${sub} up`);
    }
  }
  return { text: out.join("\n") + "\n", warnings };
}

// ---- netplan -------------------------------------------------------------------------------

/** A netplan (v2) YAML file: ethernets, plus `vlans` with id / link / addresses. */
export function toNetplan(node: NodeRef, ifaces: readonly IfaceConf[]): Generated {
  const warnings: string[] = [];
  const list = prepare(ifaces, warnings, LINUX_IFACE_RE);
  const out: string[] = [`# Généré par Excalibash pour « ${cleanWord(node.name) || "noeud"} » : à placer dans /etc/netplan/ puis « netplan apply ».`, "network:", "  version: 2"];
  const eth: string[] = [];
  const vlans: string[] = [];
  for (const i of list) {
    const addr = i.ip && withPrefix(i.ip, `« ${i.iface} »`, warnings);
    eth.push(addr ? `    ${yamlStr(i.iface)}:` : `    ${yamlStr(i.iface)}: {}`);
    if (addr) eth.push("      addresses:", `        - ${yamlStr(addr)}`);
    for (const { v, sub } of linuxVlans(i, warnings)) {
      vlans.push(`    ${yamlStr(sub)}:`, `      id: ${v}`, `      link: ${yamlStr(i.iface)}`);
      const va = i.vlanIps[v] && withPrefix(i.vlanIps[v], `« ${i.iface} » VLAN ${v}`, warnings);
      if (va) vlans.push("      addresses:", `        - ${yamlStr(va)}`);
    }
  }
  if (eth.length) out.push("  ethernets:", ...eth);
  if (vlans.length) out.push("  vlans:", ...vlans);
  return { text: out.join("\n") + "\n", warnings };
}
