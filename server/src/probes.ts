import { agentHooks, isMachineOnline, sendAgent } from "./terminals.ts";

// Reachability probes for the cables of a diagram, relayed blind: the owner's browser boxes the
// addresses under the machine auth key, the agent pings them and boxes the results the same way.
// The server only checks that the requester owns the machine, and paces the requests.

const PROBE_TIMEOUT = 15_000;
/** Minimum time between two probes of the same machine. */
const PROBE_INTERVAL = 2_000;

const pending = new Map<string, { machineId: string; resolve: (d: string | null) => void; timer: NodeJS.Timeout }>();
const lastProbe = new Map<string, number>();

/** Why a probe can't be sent right now, or null. */
export function probeRefusal(machineId: string): string | null {
  if (!isMachineOnline(machineId)) return "offline";
  const busy = [...pending.values()].some((p) => p.machineId === machineId);
  if (busy || Date.now() - (lastProbe.get(machineId) ?? 0) < PROBE_INTERVAL) return "busy";
  return null;
}

/** Forwards one boxed probe; resolves with the boxed answer, or null (offline / timeout). */
export function relayProbe(machineId: string, rid: string, ts: number, d: string): Promise<string | null> {
  if (pending.has(rid)) return Promise.resolve(null);
  const now = Date.now();
  // Entries older than the rate window no longer limit anything: prune them opportunistically.
  for (const [id, at] of lastProbe) if (now - at >= PROBE_INTERVAL) lastProbe.delete(id);
  lastProbe.set(machineId, now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(rid);
      resolve(null);
    }, PROBE_TIMEOUT);
    pending.set(rid, { machineId, resolve, timer });
    if (!sendAgent(machineId, { t: "probe", rid, ts, d })) {
      clearTimeout(timer);
      pending.delete(rid);
      resolve(null);
    }
  });
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "probe.res" || typeof msg.d !== "string" || typeof msg.rid !== "string") return;
  const p = pending.get(msg.rid);
  if (!p || p.machineId !== machineId) return;
  clearTimeout(p.timer);
  pending.delete(msg.rid);
  p.resolve(msg.d);
});
