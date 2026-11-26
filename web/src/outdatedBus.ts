// Lets code that has no UI (the file client) ask for the « agent trop ancien » dialog, which the
// AgentOutdatedHost component (mounted once at the root) shows. No UI import here: tests load the
// file client without React.
import type { OutdatedError } from "./agentCaps.ts";

type Listener = (e: OutdatedError) => void;
let listener: Listener | null = null;

/** Called by the host when it mounts; returns the way to unregister. */
export function onOutdated(l: Listener): () => void {
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}

/** Shows the persistent « mets-le à jour » dialog for this refusal (no-op without a host). */
export function reportOutdated(e: OutdatedError): void {
  listener?.(e);
}
