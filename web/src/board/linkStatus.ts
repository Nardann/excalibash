// Live state of the cables: each IP written at one end of a cable is pinged from the machine at
// the other end (its agent), if that machine is one of the user's own. The request and the answer
// are boxed under the machine auth key, like terminal and tunnel keys: the server relays them
// without seeing the addresses or the results (see agent/probe.go).
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api } from "../api.ts";
import { AAD, boxJson, randomId, unboxJson } from "../crypto.ts";
import type { Machine } from "../vault.ts";
import { cableOf, type End } from "./cables.ts";
import { findEl, nodeDataOf } from "./nodes.ts";

export type LinkState = { up: boolean; ms?: number; from: string };
/** By `${cableId}:${end}`: the reachability of the IP written at that end. */
export type LinkStates = Record<string, LinkState>;

/** The address part of what was typed ("10.0.0.1/24" → "10.0.0.1"), or null. */
export function ipOf(v?: string): string | null {
  const ip = v?.trim().split("/")[0].replace(/^\[|\]$/g, "");
  return ip && /^[0-9A-Fa-f:.]{2,45}$/.test(ip) ? ip : null;
}

/** Asks a machine the user can use which of these addresses it can reach (`boardId`: for a board's machine). */
export async function probeMachine(machine: Machine, ips: string[], boardId?: string): Promise<Record<string, { up: boolean; ms?: number }>> {
  const rid = randomId();
  const ts = Date.now();
  const d = await boxJson(machine.auth, { targets: ips }, AAD.probe(rid, ts));
  const r = await api.post<{ d: string }>(`/machines/${machine.id}/probe`, { rid, ts, d, boardId: machine.access === "board" ? boardId : undefined });
  const res = await unboxJson<{ r?: Record<string, { up: boolean; ms?: number }> }>(machine.auth, r.d, AAD.probeRes(rid));
  return res.r ?? {};
}

export type ProbePlan = Map<string, { ip: string; key: string }[]>;

/**
 * What to probe, by machine: for every cable end carrying an IP, the machine at the other end
 * (an agent machine, or the relay of a Telnet / SSH device). `liveMachine` gives the machine of
 * an icon's running shells or sites; `inUse` the machines with a shell or site on this board,
 * as the server reports them. The machine an icon remembers is board data (any editor can write
 * it): it is only trusted if that machine is in use here, so nobody can make the user's own
 * machines ping addresses through a doctored icon.
 */
export function planProbes(x: ExcalidrawImperativeAPI, liveMachine: (nodeId: string) => string | null, inUse: Set<string>): ProbePlan {
  const plan: ProbePlan = new Map();
  const machineOf = (anchorId?: string) => {
    if (!anchorId) return null;
    const nd = nodeDataOf(findEl(x, anchorId));
    if (!nd) return null;
    const hint = nd.remote?.machineId ?? nd.machineId;
    return liveMachine(anchorId) ?? (hint && inUse.has(hint) ? hint : null);
  };
  for (const el of x.getSceneElements()) {
    const c = cableOf(el);
    if (!c) continue;
    for (const [end, other] of [["a", "b"], ["b", "a"]] as [End, End][]) {
      const ip = ipOf(c.ends?.[end]?.ip);
      const machineId = machineOf(c[other].id);
      if (!ip || !machineId) continue;
      const list = plan.get(machineId) ?? [];
      list.push({ ip, key: `${el.id}:${end}` });
      plan.set(machineId, list);
    }
  }
  return plan;
}

/** A stable signature of a plan, to probe again as soon as it changes. */
export const planKey = (plan: ProbePlan) =>
  JSON.stringify([...plan].sort(([a], [b]) => a.localeCompare(b)).map(([m, l]) => [m, l.map((e) => `${e.key}=${e.ip}`).sort()]));

/** Runs a plan on the online machines the user can use; ends with no such machine are left out. */
export async function runProbes(plan: ProbePlan, machines: Machine[], boardId?: string): Promise<LinkStates> {
  const out: LinkStates = {};
  await Promise.all(
    [...plan].map(async ([machineId, ends]) => {
      const m = machines.find((x) => x.id === machineId);
      if (!m?.online) return;
      const ips = [...new Set(ends.map((e) => e.ip))].slice(0, 32);
      try {
        const r = await probeMachine(m, ips, boardId);
        for (const e of ends) if (r[e.ip]) out[e.key] = { up: r[e.ip].up, ms: r[e.ip].ms, from: m.name };
      } catch {
        // Busy, offline or no answer: those ends stay without a state this round.
      }
    }),
  );
  return out;
}
