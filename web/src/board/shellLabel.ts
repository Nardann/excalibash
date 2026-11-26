// Pure: what a shell's label says about where it runs (kept apart from collab.ts, which pulls in Excalidraw).

/** Whether a label is that of a remote session (Telnet / SSH / raw / Jupyter kernel) rather than a local shell. */
export const isRemoteLabel = (label: string) => /^(telnet|ssh|raw) \S+ via |^Noyau Jupyter \S+ via /.test(label);
