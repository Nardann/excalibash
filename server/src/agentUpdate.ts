import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import { config } from "./config.ts";
import { agentHooks, isMachineOnline, sendAgent } from "./terminals.ts";

// Agent self-update, relayed blind. The server distributes the signed release (manifest and
// signature published by the maintainer next to the binaries) and carries the browser's boxed
// request to the agent and the agent's boxed progress back. It holds neither the signing key nor
// machineAuth, so it can neither make an agent run anything nor forge an answer: the agent
// verifies the signature with the public key compiled into it (docs/SECURITY.md).

/** Names served from the downloads directory next to the binaries. */
export const MANIFEST_FILE = /^agent-manifest\.json(\.sig)?$/;

/** The newest published release, as announced by the manifest (public metadata). */
export function latestRelease(): { version: string | null; signed: boolean } {
  const manifest = join(config.agentDistDir, "agent-manifest.json");
  const sig = join(config.agentDistDir, "agent-manifest.json.sig");
  if (!existsSync(manifest) || !existsSync(sig)) return { version: null, signed: false };
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    const version = typeof m?.version === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(m.version) ? m.version : null;
    // "signed" only says the files are there: the server has no key, the agent is the judge.
    return { version, signed: version !== null };
  } catch {
    return { version: null, signed: false };
  }
}

/** No frame from the agent for this long ends the stream (a download of 64 MiB fits). */
const IDLE_MS = 120_000;
/** Absolute cap of one update. */
const TOTAL_MS = 10 * 60_000;

type Pending = { machineId: string; res: Response; idle: NodeJS.Timeout; total: NodeJS.Timeout };
const pending = new Map<string, Pending>();
const lastUpdate = new Map<string, number>();

/** Why an update can't be sent right now, or null. */
export function updateRefusal(machineId: string): "offline" | "busy" | "rate" | null {
  if (!isMachineOnline(machineId)) return "offline";
  if ([...pending.values()].some((p) => p.machineId === machineId)) return "busy";
  if (Date.now() - (lastUpdate.get(machineId) ?? 0) < config.updateIntervalMs) return "rate";
  return null;
}

function finish(rid: string): void {
  const p = pending.get(rid);
  if (!p) return;
  clearTimeout(p.idle);
  clearTimeout(p.total);
  pending.delete(rid);
  if (!p.res.writableEnded) p.res.end();
}

/**
 * Forwards one boxed update request and streams the boxed progress frames to the HTTP response
 * (one JSON object per line: {d, end?}) until the agent ends it, disconnects (it restarts) or goes quiet.
 */
export function relayUpdate(machineId: string, rid: string, ts: number, d: string, res: Response): boolean {
  if (pending.has(rid)) return false;
  const now = Date.now();
  for (const [id, at] of lastUpdate) if (now - at >= config.updateIntervalMs) lastUpdate.delete(id);
  lastUpdate.set(machineId, now);
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const idle = setTimeout(() => finish(rid), IDLE_MS);
  const total = setTimeout(() => finish(rid), TOTAL_MS);
  pending.set(rid, { machineId, res, idle, total });
  res.on("close", () => finish(rid));
  if (!sendAgent(machineId, { t: "update", rid, ts, d })) finish(rid);
  return true;
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "update.res" || typeof msg.d !== "string" || typeof msg.rid !== "string" || msg.d.length > 16_000) return;
  const p = pending.get(msg.rid);
  if (!p || p.machineId !== machineId) return;
  p.idle.refresh();
  p.res.write(JSON.stringify({ d: msg.d, end: msg.end === true || undefined }) + "\n");
  if (msg.end === true) finish(msg.rid);
});

agentHooks.hello.push((machineId) => {
  for (const [rid, p] of [...pending]) if (p.machineId === machineId) finish(rid);
});

// The agent re-executes itself after installing: its socket closes, the stream is over.
agentHooks.disconnect.push((machineId) => {
  for (const [rid, p] of [...pending]) if (p.machineId === machineId) finish(rid);
});
