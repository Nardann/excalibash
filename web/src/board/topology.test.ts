// Unit tests of the topology export (pure, no framework):
//   node --experimental-strip-types web/src/board/topology.test.ts     (or: npx tsx web/src/board/topology.test.ts)
import { extractTopology, toContainerlab, toMermaid, toJSON, sanitizeName } from "./topology.ts";
import { vlanLines } from "./cableData.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

// Minimal scene elements (only what the extraction reads).
const base = { isDeleted: false, groupIds: [] as string[], x: 0, y: 0, width: 100, height: 100 };
const tile = (id: string, extra: any = {}) => ({ ...base, id, type: "embeddable", customData: { node: true, shells: [], ...extra } }) as any;
const rect = (id: string, extra: any = {}) => ({ ...base, id, type: "rectangle", ...extra }) as any;
const text = (id: string, t: string, extra: any = {}) => ({ ...base, id, type: "text", text: t, ...extra }) as any;
const cable = (id: string, a: any, b: any, ends?: any, extra: any = {}) => ({ ...base, id, type: "arrow", customData: { cable: { a, b, ends } }, ...extra }) as any;
const names: Record<string, string> = { m1: "R1", m2: "SW1" };
const nameOf = (id: string) => names[id] ?? "Machine";

// 1. Two machines, one cable with interfaces and addresses
{
  const t = extractTopology(
    [tile("m1"), tile("m2"), cable("c1", { id: "m1" }, { id: "m2" }, { a: { iface: "eth1", ip: "10.0.0.1/24", vlans: "10, 20" }, b: { iface: "eth2" } })],
    nameOf,
  );
  ok(t.nodes.map((n) => n.name).join() === "r1,sw1", "nodes sorted and sanitised (r1, sw1)");
  ok(t.nodes.every((n) => n.kind === "machine"), "machine tiles are machines");
  ok(t.links.length === 1 && t.links[0].a.iface === "eth1" && t.links[0].a.ip === "10.0.0.1/24" && t.links[0].a.vlans === "10, 20", "link keeps iface, ip and vlans");
  ok(t.warnings.length === 0, "no warning when everything is filled");
  const y = toContainerlab(t, "Mon TP");
  console.log(y);
  ok(y.includes("name: mon-tp\n") && y.includes('- endpoints: ["r1:eth1", "sw1:eth2"]'), "containerlab: name and endpoints");
  ok(y.includes("kind: linux") && y.includes("image: alpine:latest") && y.startsWith("# Généré par Excalibash"), "containerlab: placeholder kind/image and French comment");
  ok(y.includes('- "ip addr add 10.0.0.1/24 dev eth1"'), "containerlab: exec line for an IP with a prefix");
  ok(y.includes("# r1:eth1 : ip 10.0.0.1/24, VLAN 10, 20"), "containerlab: ip/vlan as comment");
  ok(toContainerlab(extractTopology([], nameOf), "x").includes("nodes: {}"), "containerlab: empty board is valid");
  const j = JSON.parse(toJSON(t));
  ok(j.format === "excalibash-topology/v1" && j.nodes.length === 2 && j.links.length === 1, "json: format field, nodes and links");
  ok(toContainerlab(t, "Mon TP") === y && JSON.stringify(extractTopology([cable("c1", { id: "m1" }, { id: "m2" }, { a: { iface: "eth1", ip: "10.0.0.1/24", vlans: "10, 20" }, b: { iface: "eth2" } }), tile("m2"), tile("m1")], nameOf)) === JSON.stringify(t), "deterministic whatever the element order");
}

// 2. Missing interfaces are generated, with a French warning
{
  const t = extractTopology([tile("m1"), tile("m2"), cable("c1", { id: "m1" }, { id: "m2" }, { a: { iface: "eth1" } }), cable("c2", { id: "m1" }, { id: "m2" })], nameOf);
  const l = t.links.map((x) => `${x.a.iface}-${x.b.iface}`);
  ok(l.join() === "eth1-eth1,eth2-eth2", `missing ifaces generated, explicit one kept, no clash (${l.join(" ")})`);
  ok(t.warnings.length === 3 && t.warnings.every((w) => w.includes("interface non renseignée")), "one French warning per generated interface");
}

// 3. Name sanitising and dedupe; unlabelled shapes
{
  names.m3 = "Ré Seau #1!";
  names.m4 = "ré seau 1";
  const t = extractTopology(
    [tile("m3"), tile("m4"), rect("s1"), rect("s2"), text("t2", "Box", { containerId: "s2" }), cable("c1", { id: "m3" }, { id: "s1" }), cable("c2", { id: "m4" }, { id: "s2" })],
    nameOf,
  );
  const n = t.nodes.map((x) => x.name);
  ok(n.join() === "box,noeud-1,re-seau-1,re-seau-1-2", `sanitised, deduped (-2) and unlabelled shape named (${n.join()})`);
  ok(t.nodes.find((x) => x.name === "box")?.kind === "shape", "shapes are kind shape");
  ok(sanitizeName("!!!") === "noeud" && sanitizeName("A_b-C") === "a_b-c", "sanitizeName fallbacks");
}

// 4. A group anchor resolves to the tile it contains; deleted / orphaned cables are skipped
{
  const t = extractTopology(
    [tile("m1", {}), { ...rect("deco", { groupIds: ["g1"] }) }, { ...tile("m2"), groupIds: ["g1"] }, tile("m3"), cable("c1", { group: "g1", ids: ["m2", "deco"] }, { id: "m1" }), cable("c2", { id: "m1" }, { id: "m3" }, undefined, { isDeleted: true }), cable("c3", { id: "m1" }, { id: "gone" })],
    nameOf,
  );
  ok(t.links.length === 1, "deleted and dangling cables skipped");
  ok(t.links[0].a.node === "m2", "group anchor resolved to the tile of the group");
  ok(t.nodes.length === 3, "tiles without cable are still nodes (no phantom node from the group)");
}

// 5. Injection attempts never reach exec lines or comments
{
  const evil = cable("c1", { id: "m1" }, { id: "m2" }, { a: { iface: "eth1", ip: "1.2.3.4/24; rm -rf /" }, b: { iface: "eth2\nx: y", ip: "10.0.0.2/24", vlans: "10\n- evil" } });
  const t = extractTopology([tile("m1"), tile("m2"), evil], nameOf);
  const y = toContainerlab(t, "lab\nname: x");
  ok(!y.includes("rm -rf") && !y.includes("1.2.3.4"), "ip with shell metacharacters rejected");
  ok(t.warnings.some((w) => w.includes("invalide")), "a warning tells about the rejected ip");
  ok(!/^\s*x: y/m.test(y) && !y.includes("evil") && y.split("\n").filter((l) => l.startsWith("name:")).length === 1, "newlines in iface/vlans/lab name cannot add YAML lines");
  ok(y.includes('"ip addr add 10.0.0.2/24 dev eth2-x-y"'), "valid ip kept, iface cleaned");
  // Exporter is defensive on its own, even for a hand-built topology.
  const raw = { nodes: [{ id: "a", name: "a", label: "a", kind: "machine" as const }], links: [{ a: { node: "a", iface: "eth1", ip: "1.2.3.4/24\nrm -rf /" }, b: { node: "a", iface: "eth2; id", ip: "10.0.0.9" } }], warnings: [] };
  const y2 = toContainerlab(raw, "x");
  ok(!y2.includes("exec:") && y2.split("\n").filter((l) => l.includes("rm -rf")).every((l) => l.trim().startsWith("#")), "exporter alone: no exec for bad ip / iface / missing prefix, text stays in a one-line comment");
}

// 6. Mermaid escaping
{
  names.m5 = 'A "q" <b> & #x';
  const t = extractTopology([tile("m5"), tile("m2"), cable("c1", { id: "m5" }, { id: "m2" }, { a: { iface: 'e"1' }, b: { iface: "eth2" } })], nameOf);
  const m = toMermaid(t);
  console.log(m);
  ok(m.startsWith("graph LR\n"), "mermaid: graph LR");
  ok(m.includes('["A #quot;q#quot; #lt;b#gt; #amp; #35;x"]'), "mermaid: node label escaped");
  ok(m.includes('---|"e-1 — eth2"|') || m.includes("e-1 — eth2"), "mermaid: edge label 'iface — iface'");
  ok(!/"[^"\n]*"[^"\n]*"[^"\n]*"\]$/m.test(m), "mermaid: no stray quote left inside a label");
}

// VLANs with an address: kept for listed single VLANs, exec on a VLAN subinterface, label lines.
{
  const t = extractTopology(
    [tile("m1"), tile("m2"), cable("c1", { id: "m1" }, { id: "m2" }, { a: { iface: "eth1", vlans: "10, 20, 30-35", vlanIps: { "10": "10.0.10.1/24", "99": "1.2.3.4/24", "20": "nope" } }, b: { iface: "eth2" } })],
    nameOf,
  );
  const a = t.links[0].a;
  ok(JSON.stringify(a.vlanIps) === JSON.stringify({ "10": "10.0.10.1/24" }), "vlan ips: only well-formed addresses of listed VLANs kept");
  ok(t.warnings.some((w) => w.includes("du VLAN 20 invalide")), "vlan ips: invalid address warned");
  const y = toContainerlab(t, "lab");
  ok(y.includes('"ip link add link eth1 name eth1.10 type vlan id 10"') && y.includes('"ip addr add 10.0.10.1/24 dev eth1.10"'), "containerlab: VLAN subinterface with its address");
  ok(y.includes("VLAN 10 ip 10.0.10.1/24"), "containerlab: VLAN address as comment");
  const lines = vlanLines({ vlans: "10, 20, 30-35", vlanIps: { "10": "10.0.10.1/24" } });
  ok(lines.join("|") === "VLAN 20, 30-35|VLAN 10 10.0.10.1/24", `label: plain VLANs together, one line per VLAN with an address (${lines.join(" | ")})`);
}

console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
