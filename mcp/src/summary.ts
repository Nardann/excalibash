// Board -> compact French text for a language model: texts, machine tiles, cables.
// Shapes of customData mirror web/src/board/nodes.ts (nodeDataOf) and cables.ts (cableOf), which
// cannot be imported here (they pull the Excalidraw runtime). Board content is untrusted input.
import type { Role } from "../../web/src/api.ts";

type El = any;
type Term = { id: string; label: string; status: string };

const MAX_CHARS = 20_000;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const cd = (el: El) => (el?.customData && typeof el.customData === "object" ? el.customData : {});
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

export const ROLE_FR: Record<Role, string> = { owner: "propriétaire", editor: "éditeur", viewer: "lecteur" };

export function terminalKind(label: string): string {
  const m = /^(telnet|ssh|raw) \S+ via /.exec(label);
  return m ? m[1] : "shell";
}

function nodeTitle(el: El, terms: Map<string, Term>): string {
  const d = cd(el);
  const shells: any[] = Array.isArray(d.shells) ? d.shells : [];
  const first = str(shells[0]?.terminalId);
  return str(d.title) ?? (first && terms.get(first)?.label) ?? str(d.machineName) ?? "machine sans nom";
}

export function summarize(opts: { name: string; role: Role; elements: Map<string, El>; terminals: Map<string, Term> }): string {
  const els = [...opts.elements.values()].filter((e) => !e.isDeleted);
  const byId = new Map(els.map((e) => [e.id, e]));
  const out: string[] = [];
  out.push(`Tableau « ${opts.name} » (rôle : ${ROLE_FR[opts.role]}) — ${els.length} élément(s).`);

  // Text bound to a container (shape label) names that container.
  const boundText = new Map<string, string>();
  for (const e of els) if (e.type === "text" && str(e.containerId) && str(e.text)) boundText.set(e.containerId, one(e.text));

  const nodes = els.filter((e) => cd(e).node === true);
  const nameOf = (el: El): string => {
    if (cd(el).node === true) return nodeTitle(el, opts.terminals);
    if (el.type === "text") return clip(one(String(el.text ?? "")), 60) || "texte vide";
    return boundText.get(el.id) ?? `${el.type} sans nom`;
  };
  const anchorName = (a: any): string => {
    if (str(a?.group)) {
      const members = els.filter((e) => Array.isArray(e.groupIds) && e.groupIds.includes(a.group));
      const node = members.find((e) => cd(e).node === true);
      if (node) return nodeTitle(node, opts.terminals);
      const txt = members.find((e) => e.type === "text" && str(e.text));
      return txt ? clip(one(txt.text), 60) : `groupe de ${members.length} élément(s)`;
    }
    const el = str(a?.id) ? byId.get(a.id) : undefined;
    return el ? nameOf(el) : "extrémité inconnue";
  };

  const texts = els.filter((e) => e.type === "text" && !str(e.containerId) && str(e.text) && !cd(e).cable);
  if (texts.length) {
    out.push("", "Textes :");
    for (const t of texts.slice(0, 200)) out.push(`- ${clip(one(t.text), 300)}`);
  }

  if (nodes.length) {
    out.push("", "Machines et équipements :");
    for (const n of nodes) {
      const d = cd(n);
      const shells: any[] = Array.isArray(d.shells) ? d.shells : [];
      const parts = [`- ${nodeTitle(n, opts.terminals)}`];
      if (str(d.machineName)) parts.push(`machine : ${d.machineName}`);
      const r = d.remote?.target;
      if (r && str(r.host)) parts.push(`équipement : ${r.kind} ${r.host}:${r.port}`);
      const tl = shells
        .map((s) => str(s?.terminalId))
        .filter((id): id is string => !!id)
        .map((id) => {
          const t = opts.terminals.get(id);
          return t ? `${id} (${terminalKind(t.label)}, ${t.status})` : `${id} (fermé)`;
        });
      parts.push(tl.length ? `terminaux : ${tl.join(", ")}` : "aucun terminal");
      out.push(parts.join(" — "));
    }
  }

  const cables = els.filter((e) => cd(e).cable && typeof cd(e).cable === "object");
  if (cables.length) {
    out.push("", "Câbles :");
    const end = (info: any) => {
      if (!info || typeof info !== "object") return "";
      const bits = [str(info.iface), str(info.ip), str(info.vlans) ? `VLAN ${info.vlans}` : undefined].filter(Boolean);
      return bits.length ? ` [${bits.map((b) => clip(String(b), 100)).join(", ")}]` : "";
    };
    for (const c of cables) {
      const k = cd(c).cable;
      out.push(`- ${anchorName(k.a)}${end(k.ends?.a)} <-> ${anchorName(k.b)}${end(k.ends?.b)}`);
    }
  }

  const other = els.length - texts.length - nodes.length - cables.length;
  const windows = els.filter((e) => cd(e).terminalId || cd(e).webId || cd(e).codeId).length;
  if (other > 0) out.push("", `Autres éléments graphiques : ${Math.max(0, other - windows)} (formes, flèches, images…), fenêtres de terminal/site/code : ${windows}.`);

  const text = out.join("\n");
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n[… résumé tronqué à 20 000 caractères]" : text;
}

/** Strips ANSI/OSC escapes and applies backspaces and carriage returns, like a dumb terminal. */
export function stripTerminal(raw: string): string {
  let s = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, "") // DCS, SOS, PM, APC
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "") // charset
    .replace(/\x1b[@-Z\\-_=>78]/g, ""); // other 2-byte escapes
  s = s.replace(/\r\n/g, "\n");
  const lines = s.split("\n").map((line) => {
    let cur = "";
    for (const ch of line) {
      if (ch === "\r") cur = "";
      else if (ch === "\b") cur = cur.slice(0, -1);
      else cur += ch;
    }
    return cur;
  });
  // eslint-disable-next-line no-control-regex
  return lines.join("\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
