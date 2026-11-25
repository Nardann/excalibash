// Broadcast input (like tmux's synchronize-panes): the terminals in the group receive whatever is
// typed in any of them. Purely local UI state of this browser tab: never stored in the scene and
// never shared with peers, so the server sees nothing new. Keystrokes still travel through the
// regular encrypted `session.terminalInput` path, once per target.
import { useSyncExternalStore } from "react";
import type { BoardSession } from "./collab.ts";

let group: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function publish(next: Set<string>) {
  group = next;
  for (const l of listeners) l();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function setBroadcast(id: string, on: boolean) {
  if (group.has(id) === on) return;
  const next = new Set(group);
  if (on) next.add(id);
  else next.delete(id);
  publish(next);
}

export const toggleBroadcast = (id: string) => setBroadcast(id, !group.has(id));

export function clearBroadcast() {
  if (group.size) publish(new Set());
}

/** The current group; a new Set instance on every change, so it is a valid snapshot. */
export const useBroadcastGroup = () =>
  useSyncExternalStore(
    subscribe,
    () => group,
    () => group,
  );

/** Terminals of the group that can receive input right now (writable session, shell running). */
export function liveTargets(session: BoardSession): string[] {
  if (!session.canEdit) return [];
  return [...group].filter((id) => session.terminals.get(id)?.status === "running");
}

/**
 * Forwards input typed in `from` to the other members of the group. A single Set lookup when `from`
 * isn't broadcasting. Targets that are read-only, exited, offline or gone are skipped silently.
 */
export function fanOut(session: BoardSession, from: string, data: string | Uint8Array) {
  if (!group.has(from)) return;
  for (const id of liveTargets(session)) if (id !== from) session.terminalInput(id, data);
}
