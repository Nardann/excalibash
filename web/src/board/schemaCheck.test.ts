// Unit tests of the schema check (pure, no framework):
//   node --experimental-strip-types web/src/board/schemaCheck.test.ts     (or: npx tsx web/src/board/schemaCheck.test.ts)
import { applyFix, compareEnds, parseCidr, suggestIface, vlanIfaces, type IfaceInfo, type NodeEnd } from "./schemaCheck.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

const nic = (name: string, addrs: string[], up = true): IfaceInfo => ({ name, up, running: up, mtu: 1500, addrs });
const end = (cableId: string, info: NodeEnd["info"], e: "a" | "b" = "a"): NodeEnd => ({ cableId, end: e, info });
const machine = [
  nic("lo", ["127.0.0.1/8", "::1/128"]),
  nic("ens19", ["10.0.0.1/24", "fe80::1/64", "2001:db8::1/64"]),
  nic("ens20", [], false),
  nic("ens19.10", ["10.0.10.1/24"]),
  nic("docker0", ["172.17.0.1/16"]),
];
const one = (e: NodeEnd, ifaces = machine) => compareEnds([e], ifaces).ends[0];

// ok
{
  const r = one(end("c1", { iface: "ens19", ip: "10.0.0.1/24" }));
  ok(r.status === "ok" && r.findings.length === 0 && r.key === "c1:a", "interface and address present: ok");
  ok(one(end("c1", { iface: "ens19", ip: "10.0.0.1" })).status === "ok", "address without prefix drawn: prefix not checked");
  ok(one(end("c1", { iface: "ens19" })).status === "ok", "interface only: ok");
}
// iface absente + suggestion
{
  const r = one(end("c1", { iface: "eth1", ip: "10.0.0.1/24" }));
  ok(r.status === "iface-absente" && r.findings[0].message.includes("eth1 absente") && r.findings[0].fix?.patch.iface === "ens19", "absent interface: suggestion = the one holding the address");
  ok(r.findings.length === 1, "no second finding for the address of an absent interface");
  ok(suggestIface("eth1", machine, { ip: "9.9.9.9/24" }) === null, "no unique candidate (ens19, ens20 both wired): no suggestion");
  ok(suggestIface("eth1", machine, { claimed: new Set(["ens19"]) }) === "ens20", "wired interface not used by another end is suggested");
  ok(suggestIface("Ens19", machine) === "ens19", "case-only difference suggested");
  ok(suggestIface("ens91", [nic("ens19", []), nic("lo", [])]) === "ens19", "only wired interface of the machine");
  ok(suggestIface("wlan0", machine) === null, "no wireless on the machine: no suggestion");
  ok(suggestIface("eth0", [nic("lo", []), nic("docker0", []), nic("veth1", [])]) === null, "virtual interfaces never suggested by family");
  const nofix = one(end("c1", { iface: "eth1" }));
  ok(nofix.findings[0].fix === undefined && !nofix.findings[0].message.includes("?"), "ambiguous: message without suggestion, no quick fix");
  ok(applyFix({ iface: "eth1", ip: "1.1.1.1" }, r.findings[0].fix!.patch).iface === "ens19", "fix replaces the interface name only");
}
// interface down
{
  const r = one(end("c1", { iface: "ens20" }));
  ok(r.status === "interface-down" && r.findings[0].message === "interface ens20 down", "interface exists but down");
}
// IP absente / ailleurs / prefix
{
  const r = one(end("c1", { iface: "ens19", ip: "10.0.0.2/24" }));
  ok(r.status === "ip-absente" && r.findings[0].message.includes("10.0.0.2/24 absente de ens19"), "address absent from the interface");
  const e = one(end("c1", { iface: "ens20", ip: "172.17.0.1/16" }));
  ok(e.findings.some((f) => f.kind === "ip-ailleurs" && f.message.includes("docker0")), "address found on another interface");
  const p = one(end("c1", { iface: "ens19", ip: "10.0.0.1/16" }));
  ok(p.status === "prefixe-different" && p.findings[0].message.includes("préfixe différent (/16 attendu, /24 trouvé)"), "same address, other prefix: message");
  ok(applyFix({ iface: "ens19", ip: "10.0.0.1/16" }, p.findings[0].fix!.patch).ip === "10.0.0.1/24", "fix sets the real prefix");
  const noif = one(end("c1", { ip: "10.0.0.1/24" }));
  ok(noif.status === "ok", "address without interface drawn: found anywhere");
  ok(one(end("c1", { ip: "10.9.9.9/24" })).status === "ip-absente", "address without interface, nowhere: absent from the machine");
}
// IPv6
{
  ok(one(end("c1", { iface: "ens19", ip: "2001:DB8:0:0:0:0:0:1/64" })).status === "ok", "IPv6: other spelling of the same address");
  const p = one(end("c1", { iface: "ens19", ip: "2001:db8::1/48" }));
  ok(p.status === "prefixe-different" && p.findings[0].message.includes("(/48 attendu, /64 trouvé)"), "IPv6 prefix mismatch");
  ok(one(end("c1", { iface: "ens19", ip: "2001:db8::2/64" })).status === "ip-absente", "IPv6 absent");
  ok(JSON.stringify(parseCidr("[::1]")) === JSON.stringify(parseCidr("0:0:0:0:0:0:0:1")) && parseCidr("::ffff:10.0.0.1")?.addr === "0:0:0:0:0:ffff:a00:1", "IPv6 parsing: brackets, :: and embedded IPv4");
  ok(parseCidr("10.0.0.256") === null && parseCidr("10.0.0.1/33") === null && parseCidr("a:b:c") === null && parseCidr("1::2::3") === null && parseCidr("") === null, "invalid addresses rejected");
}
// VLANs
{
  ok(vlanIfaces(machine, "ens19", "10").map((i) => i.name).join() === "ens19.10", "VLAN subinterface <iface>.<vlan> matched");
  ok(vlanIfaces([nic("vlan20", []), nic("br0.20", []), nic("vlan200", [])], "eth0", "20").map((i) => i.name).join() === "vlan20,br0.20", "any interface named with the VLAN id (vlan20, x.20), not vlan200");
  const good = one(end("c1", { iface: "ens19", vlans: "10", vlanIps: { "10": "10.0.10.1/24" } }));
  ok(good.status === "ok", "VLAN address on the subinterface: ok");
  const viaName = one(end("c1", { iface: "eth9", vlans: "10", vlanIps: { "10": "10.0.10.1/24" } }), [nic("vlan10", ["10.0.10.1/24"])]);
  ok(viaName.findings.filter((f) => f.kind === "iface-absente").length === 1 && !viaName.findings.some((f) => f.kind === "vlan-absent"), "VLAN found on vlan10 even when the parent is another name");
  const missing = one(end("c1", { iface: "ens19", vlans: "30", vlanIps: { "30": "10.0.30.1/24" } }));
  ok(missing.status === "vlan-absent" && missing.findings[0].message.includes("ens19.30 attendue"), "VLAN without any interface: reports the expected name");
  const noAddr = one(end("c1", { iface: "ens19", vlans: "10", vlanIps: { "10": "10.0.10.9/24" } }));
  ok(noAddr.status === "vlan-absent" && noAddr.findings[0].message.includes("absente de ens19.10"), "VLAN interface exists, address missing");
  const pfx = one(end("c1", { iface: "ens19", vlans: "10", vlanIps: { "10": "10.0.10.1/16" } }));
  ok(pfx.status === "prefixe-different" && applyFix({ iface: "ens19", vlans: "10", vlanIps: { "10": "10.0.10.1/16" } }, pfx.findings[0].fix!.patch).vlanIps?.["10"] === "10.0.10.1/24", "VLAN prefix mismatch with fix");
  const wrong = one(end("c1", { iface: "ens19", vlans: "10", vlanIps: { "10": "10.0.0.1/24" } }));
  ok(wrong.findings.some((f) => f.kind === "ip-ailleurs"), "VLAN address held by a non-VLAN interface");
  ok(one(end("c1", { iface: "ens19", vlans: "10, 20" })).status === "ok", "VLANs without an address: nothing expected");
}
// Extra addresses
{
  const c = compareEnds([end("c1", { iface: "ens19", ip: "10.0.0.1/24" })], machine);
  const extra = c.extra.map((x) => `${x.iface} ${x.addr}`);
  ok(extra.join("|") === "ens19 2001:db8::1/64|ens19.10 10.0.10.1/24|docker0 172.17.0.1/16", `listed: global addresses not drawn; loopback and link-local left out (${extra.join("|")})`);
  const all = compareEnds([end("c1", { iface: "ens19", ip: "10.0.0.1/24", vlans: "10", vlanIps: { "10": "10.0.10.1/24" } }, "a"), end("c2", { ip: "172.17.0.1/16" }, "b")], machine);
  ok(all.extra.length === 1 && all.extra[0].addr === "2001:db8::1/64", "addresses drawn on any end of the machine are not extra");
  ok(compareEnds([], []).ends.length === 0 && compareEnds([], []).extra.length === 0, "empty machine and empty board");
}

console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
