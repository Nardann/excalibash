// "Vérifier le schéma", the network side: asks each involved machine (agent probe of kind
// "ifaces", sealed under the machine auth key like the ping probes: the server relays it blind)
// for its interfaces, then compares them with the cable ends of the machine's icons.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { ApiError, api } from "../api.ts";
import { AAD, boxJson, randomId, unboxJson } from "../crypto.ts";
import type { Machine } from "../vault.ts";
import { cableOf, type End } from "./cables.ts";
import { findEl, nodeDataOf } from "./nodes.ts";
import { compareEnds, type Comparison, type IfaceInfo, type NodeEnd } from "./schemaCheck.ts";

export type SchemaPlan = {
  /** The ends to check, by machine. */
  machines: Map<string, NodeEnd[]>;
  /** Names of the Telnet / SSH devices with cables: nothing to read on them. */
  remote: string[];
};

export type MachineCheck =
  | ({ machineId: string; name: string } & Comparison & { error?: undefined })
  | { machineId: string; name: string; error: string; ends?: undefined; extra?: undefined };

/** The tile an anchor stands for: the element itself, or the tile inside a group. */
function tileOf(x: ExcalidrawImperativeAPI, a: { id?: string; group?: string }) {
  if (a.id) return findEl(x, a.id);
  if (!a.group) return undefined;
  return x.getSceneElements().find((e) => e.groupIds.includes(a.group!) && nodeDataOf(e));
}

/**
 * What to check, by machine, with the same trust rule as the ping probes: the machine of an icon
 * is the one of its live shells or sites, or the one it remembers if it is in use on this board
 * (the remembered one is board data, which any editor can write).
 */
export function planSchemaCheck(x: ExcalidrawImperativeAPI, liveMachine: (nodeId: string) => string | null, inUse: Set<string>, nameOf: (nodeId: string) => string): SchemaPlan {
  const machines = new Map<string, NodeEnd[]>();
  const remote = new Set<string>();
  for (const el of x.getSceneElements()) {
    const c = cableOf(el);
    if (!c) continue;
    for (const end of ["a", "b"] as End[]) {
      const info = c.ends?.[end];
      if (!info) continue;
      const tile = tileOf(x, c[end]);
      const nd = tile && nodeDataOf(tile);
      if (!tile || !nd) continue;
      if (nd.remote) {
        remote.add(nameOf(tile.id));
        continue;
      }
      const hint = nd.machineId;
      const machineId = liveMachine(tile.id) ?? (hint && inUse.has(hint) ? hint : null);
      if (!machineId) continue;
      const list = machines.get(machineId) ?? [];
      list.push({ cableId: el.id, end, info });
      machines.set(machineId, list);
    }
  }
  return { machines, remote: [...remote].sort() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const asIface = (v: any): IfaceInfo | null =>
  v && typeof v.name === "string" && v.name
    ? {
        name: v.name,
        up: v.up === true,
        running: v.running === true,
        mtu: typeof v.mtu === "number" ? v.mtu : undefined,
        mac: typeof v.mac === "string" ? v.mac : undefined,
        addrs: Array.isArray(v.addrs) ? v.addrs.filter((a: unknown) => typeof a === "string") : [],
      }
    : null;

/** The machine's interfaces; throws a French message when the agent is too old to answer. */
export async function probeIfaces(machine: Machine, boardId?: string): Promise<IfaceInfo[]> {
  const rid = randomId();
  const ts = Date.now();
  const d = await boxJson(machine.auth, { kind: "ifaces", targets: [] }, AAD.probe(rid, ts));
  const r = await api.post<{ d: string }>(`/machines/${machine.id}/probe`, { rid, ts, d, boardId: machine.access === "board" ? boardId : undefined });
  const res = await unboxJson<{ ifaces?: unknown }>(machine.auth, r.d, AAD.probeRes(rid));
  // An agent that predates this check ignores `kind` and answers like a ping probe.
  if (!Array.isArray(res.ifaces)) throw new Error("agent trop ancien, mets-le à jour");
  return res.ifaces.map(asIface).filter((i): i is IfaceInfo => !!i);
}

/** Probes one machine; a probe in flight (the ping loop) is waited for, as the server paces them. */
async function probeWithRetry(machine: Machine, boardId?: string): Promise<IfaceInfo[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await probeIfaces(machine, boardId);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 429) || attempt >= 4) throw e;
      await sleep(2200);
    }
  }
}

/** Checks every planned machine, a few at a time; a machine that can't answer carries its error. */
export async function runSchemaCheck(plan: SchemaPlan, machines: Machine[], boardId?: string, parallel = 3): Promise<MachineCheck[]> {
  const entries = [...plan.machines];
  const out: MachineCheck[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const [machineId, ends] = entries[i];
      const m = machines.find((x) => x.id === machineId);
      const name = m?.name ?? "Machine";
      if (!m) out[i] = { machineId, name, error: "machine introuvable" };
      else if (!m.online) out[i] = { machineId, name, error: "machine hors ligne" };
      else {
        try {
          out[i] = { machineId, name, ...compareEnds(ends, await probeWithRetry(m, boardId)) };
        } catch (e) {
          out[i] = { machineId, name, error: e instanceof Error ? e.message : "pas de réponse" };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, entries.length) }, worker));
  return out;
}
