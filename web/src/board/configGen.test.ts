// Unit tests of the configuration generators (pure, no framework):
//   node --experimental-strip-types web/src/board/configGen.test.ts     (or: npx tsx web/src/board/configGen.test.ts)
import { nodeInterfaces, prefixToMask, toCiscoIOS, toLinuxIproute, toNetplan, vlanRanges, type IfaceConf } from "./configGen.ts";
import type { Topology } from "./topology.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const lines = (t: string) => t.split("\n").filter(Boolean);

const nodes = [
  { id: "r", name: "r1", label: "R1", kind: "machine" as const },
  { id: "s", name: "sw1", label: "SW1", kind: "machine" as const },
  { id: "h", name: "pc1", label: "PC1", kind: "machine" as const },
];
const topo = (links: Topology["links"]): Topology => ({ nodes, links, warnings: [] });
const R = { name: "r1" };

// 1. Mask conversion
{
  ok(prefixToMask(24) === "255.255.255.0", "/24 -> 255.255.255.0");
  ok(prefixToMask(30) === "255.255.255.252", "/30 -> 255.255.255.252");
  ok(prefixToMask(0) === "0.0.0.0", "/0 -> 0.0.0.0");
  ok(prefixToMask(32) === "255.255.255.255", "/32 -> 255.255.255.255");
  ok(prefixToMask(17) === "255.255.128.0", "/17 -> 255.255.128.0");
  ok(vlanRanges([10, 20, 30, 31, 32, 33, 34, 35]) === "10,20,30-35", "vlan ranges compacted");
}

// 2. Interfaces of a node: merged, sorted naturally, peer filled
{
  const t = topo([
    { a: { node: "r", iface: "Gi0/10", ip: "10.0.10.1/24" }, b: { node: "s", iface: "Gi0/1" } },
    { a: { node: "r", iface: "Gi0/2", vlans: "10, 20, 30-32", vlanIps: { "10": "10.0.10.1/24" } }, b: { node: "h", iface: "eth0" } },
    { a: { node: "s", iface: "Gi0/3" }, b: { node: "r", iface: "Gi0/2", vlans: "40" } },
  ]);
  const { ifaces, warnings } = nodeInterfaces(t, "r");
  ok(ifaces.map((i) => i.iface).join() === "Gi0/2,Gi0/10", `natural order (${ifaces.map((i) => i.iface).join()})`);
  ok(ifaces[0].vlanList === "10,20,30-32,40" && ifaces[0].vlans.length === 6, "same iface on 2 cables: VLANs merged");
  ok(warnings.some((w) => w.includes("plusieurs câbles")), "same iface on 2 cables: warning");
  ok(ifaces[0].peer.name === "pc1" && ifaces[0].peer.iface === "eth0", "peer of the first cable");
  ok(ifaces[0].vlanIps["10"] === "10.0.10.1/24", "vlan ip kept");
}

// 3. Cisco IOS, router: one routed link and a trunk with 2 VLAN IPs (router-on-a-stick)
const routerTopo = topo([
  { a: { node: "r", iface: "GigabitEthernet0/0", ip: "192.168.1.1/24" }, b: { node: "h", iface: "eth0" } },
  { a: { node: "r", iface: "GigabitEthernet0/1", vlans: "10, 20", vlanIps: { "10": "10.0.10.1/24", "20": "10.0.20.1/25" } }, b: { node: "s", iface: "Gi0/24" } },
]);
{
  const { ifaces } = nodeInterfaces(routerTopo, "r");
  const g = toCiscoIOS(R, ifaces, { mode: "routeur", hostname: true, wrap: true });
  console.log(g.text);
  const want = [
    "configure terminal",
    "hostname r1",
    "interface GigabitEthernet0/0",
    " description vers pc1 eth0",
    " ip address 192.168.1.1 255.255.255.0",
    " no shutdown",
    "interface GigabitEthernet0/1",
    " description vers sw1 Gi0/24",
    " no shutdown",
    "interface GigabitEthernet0/1.10",
    " encapsulation dot1Q 10",
    " ip address 10.0.10.1 255.255.255.0",
    "interface GigabitEthernet0/1.20",
    " encapsulation dot1Q 20",
    " ip address 10.0.20.1 255.255.255.128",
    "end",
  ];
  ok(lines(g.text).join("\n") === want.join("\n"), "router-on-a-stick: exact output");
  ok(g.warnings.length === 0, "no warning");
  const bare = toCiscoIOS(R, ifaces, { mode: "routeur" });
  ok(!bare.text.includes("configure terminal") && !bare.text.includes("\nend") && !bare.text.includes("hostname"), "no wrap / hostname unless asked");
}

// 4. Cisco IOS, switch: access, trunk, vlan definitions, SVI
{
  const t = topo([
    { a: { node: "s", iface: "Gi0/1", vlans: "10" }, b: { node: "h", iface: "eth0" } },
    { a: { node: "s", iface: "Gi0/24", vlans: "10, 20, 30-35", vlanIps: { "20": "10.0.20.2/24" } }, b: { node: "r", iface: "Gi0/1" } },
  ]);
  const g = toCiscoIOS({ name: "sw1" }, nodeInterfaces(t, "s").ifaces, { mode: "switch", wrap: true });
  console.log(g.text);
  const l = lines(g.text);
  ok(l.slice(0, 2).join() === "configure terminal,vlan 10" && l.includes("vlan 20") && l.includes("vlan 35"), "vlan definitions first");
  ok(l.includes(" switchport mode access") && l.includes(" switchport access vlan 10"), "single VLAN: access");
  ok(l.includes(" switchport mode trunk") && l.includes(" switchport trunk allowed vlan 10,20,30-35"), "several VLANs: trunk with compact list");
  ok(l.includes("interface Vlan20") && l.includes(" ip address 10.0.20.2 255.255.255.0"), "address in a VLAN: SVI");
  ok(l.at(-1) === "end", "ends with end");
}

// 5. IPv6, missing prefix
{
  const t = topo([
    { a: { node: "r", iface: "Gi0/0", ip: "2001:db8::1/64" }, b: { node: "s", iface: "Gi0/1" } },
    { a: { node: "r", iface: "Gi0/1", ip: "10.0.0.1" }, b: { node: "h", iface: "eth0" } },
  ]);
  const { ifaces } = nodeInterfaces(t, "r");
  const g = toCiscoIOS(R, ifaces, { mode: "routeur" });
  ok(g.text.includes(" ipv6 address 2001:db8::1/64"), "cisco: ipv6 address");
  ok(!g.text.includes("10.0.0.1") && g.warnings.some((w) => w.includes("sans masque")), "cisco: missing prefix -> warning, no address line");
  const lx = toLinuxIproute(R, ifaces);
  ok(!lx.text.includes("Gi0/0") && lx.warnings.some((w) => w.includes("non utilisable sous Linux")), "linux: names with / are refused");
}

// 6. Linux iproute
{
  const t = topo([
    { a: { node: "h", iface: "eth0", ip: "10.0.0.2/24" }, b: { node: "s", iface: "Gi0/1" } },
    { a: { node: "h", iface: "eth1", vlans: "10, 20", vlanIps: { "10": "10.0.10.2/24" } }, b: { node: "s", iface: "Gi0/2" } },
    { a: { node: "h", iface: "eth2", ip: "10.9.9.9" }, b: { node: "s", iface: "Gi0/3" } },
  ]);
  const { ifaces } = nodeInterfaces(t, "h");
  const g = toLinuxIproute({ name: "pc1" }, ifaces, { hostname: true });
  console.log(g.text);
  const l = lines(g.text).filter((x) => !x.startsWith("#"));
  ok(l.join("\n") === ["hostnamectl set-hostname pc1", "ip link set dev eth0 up", "ip addr add 10.0.0.2/24 dev eth0", "ip link set dev eth1 up", "ip link add link eth1 name eth1.10 type vlan id 10", "ip addr add 10.0.10.2/24 dev eth1.10", "ip link set dev eth1.10 up", "ip link add link eth1 name eth1.20 type vlan id 20", "ip link set dev eth1.20 up", "ip link set dev eth2 up"].join("\n"), "linux: exact output");
  ok(g.warnings.length === 1 && g.warnings[0].includes("sans préfixe"), "linux: missing prefix warned, address skipped");
}

// 7. netplan
{
  const t = topo([
    { a: { node: "h", iface: "eth0", ip: "10.0.0.2/24" }, b: { node: "s", iface: "Gi0/1" } },
    { a: { node: "h", iface: "eth1", vlans: "10", vlanIps: { "10": "2001:db8::2/64" } }, b: { node: "s", iface: "Gi0/2" } },
  ]);
  const g = toNetplan({ name: "pc1" }, nodeInterfaces(t, "h").ifaces);
  console.log(g.text);
  const l = lines(g.text).filter((x) => !x.startsWith("#"));
  ok(l.join("\n") === ["network:", "  version: 2", "  ethernets:", "    eth0:", "      addresses:", '        - "10.0.0.2/24"', "    eth1: {}", "  vlans:", '    "eth1.10":', "      id: 10", "      link: eth1", "      addresses:", '        - "2001:db8::2/64"'].join("\n"), "netplan: exact YAML, addresses and dotted names quoted");
  ok(!!yamlRoundTrip(g.text), "netplan: parses as plain nested mappings");
}
function yamlRoundTrip(text: string) {
  // Tiny structural check: indentation grows by 2 and no tab.
  return lines(text).every((l) => !l.includes("\t") && (l.length - l.trimStart().length) % 2 === 0);
}

// 8. Injection attempts never produce an extra line
{
  const evil = topo([
    { a: { node: "r", iface: "Gi0/1\nshutdown", ip: "1.2.3.4/24" }, b: { node: "s", iface: "Gi0/1" } },
    { a: { node: "r", iface: "Gi0/2", ip: "1.2.3.4/24\nreload", vlans: "10\nreload" }, b: { node: "s", iface: "Gi0/2\n!x" } },
    { a: { node: "r", iface: "Gi0/3", ip: "10.0.0.1/24; reboot", vlans: "10;20" }, b: { node: "h", iface: "e;1" } },
    { a: { node: "r", iface: "Gi0/4", vlans: "10, 20", vlanIps: { "10": "1.1.1.1/24\nreload", "20\nx": "2.2.2.2/24" } }, b: { node: "h", iface: "eth0" } },
    { a: { node: "r", iface: "Gi0/5 ; reload", ip: "10.0.5.1/24" }, b: { node: "h", iface: "eth1" } },
  ]);
  const { ifaces, warnings } = nodeInterfaces(evil, "r");
  const outs = [
    toCiscoIOS(R, ifaces, { mode: "routeur", wrap: true, hostname: true }).text,
    toCiscoIOS(R, ifaces, { mode: "switch", wrap: true }).text,
    toLinuxIproute(R, ifaces).text,
    toNetplan(R, ifaces).text,
  ];
  ok(outs.every((o) => !/reload|reboot|shutdown|[;!]/.test(o.replace(/\bno shutdown\b/g, ""))), "no injected command anywhere");
  ok(warnings.length >= 5, `bad fields warned (${warnings.length})`);
  ok(outs[0].split("\n").filter((l) => /^interface /.test(l)).join() === "interface Gi0/2,interface Gi0/3,interface Gi0/4", "only well-formed interfaces survive (cisco, router)");
  // The generators also defend themselves against a hand-built interface list.
  const raw: IfaceConf[] = [{ iface: "eth0\nip link del eth1", ip: "1.2.3.4/24\nreload", vlans: [10, 5000, -1, 1.5], vlanList: "x\ny", vlanIps: { "10": "9.9.9.9/24 && id" }, peer: { name: "a\nb", iface: "c\nd" } }, { iface: "eth1", ip: "10.0.0.1/24;id", vlans: [], vlanList: "", vlanIps: {}, peer: { name: "n\nreload", iface: "x\nshutdown" } }];
  const cases: [string, ReturnType<typeof toCiscoIOS>, number][] = [
    ["cisco routeur", toCiscoIOS(R, raw, { mode: "routeur", wrap: true }), 5],
    ["cisco switch", toCiscoIOS(R, raw, { mode: "switch" }), 3],
    ["linux", toLinuxIproute(R, raw), 3],
    ["netplan", toNetplan(R, raw), 5],
  ];
  for (const [name, g, n] of cases)
    ok(lines(g.text).length === n && !/[;&]|ip link del|\.1\.|1\.2\.3\.4|9\.9\.9\.9|10\.0\.0\.1/.test(g.text) && g.warnings.length >= 2, `raw list (${name}): only the safe interface, ${n} lines, warnings given`);
  const host = toCiscoIOS({ name: "x\nreload" }, [], { mode: "switch", hostname: true });
  ok(lines(host.text).join() === "hostname x-reload", "hostname sanitised");
}

// 9. Deterministic whatever the order of the links
{
  const links = routerTopo.links;
  const a = toCiscoIOS(R, nodeInterfaces(routerTopo, "r").ifaces, { mode: "routeur" }).text;
  const b = toCiscoIOS(R, nodeInterfaces(topo([...links].reverse()), "r").ifaces, { mode: "routeur" }).text;
  ok(a === b, "same output whatever the link order");
  ok(nodeInterfaces(routerTopo, "nope").ifaces.length === 0, "unknown node: no interface");
}

console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
