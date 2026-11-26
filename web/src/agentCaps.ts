// What the agent of a machine can do, as it announces in its hello (agent/conn.go `agentCaps`). The
// server relays the list as plain metadata (like hostname / os / arch). An agent that announces
// nothing predates the list: it is treated as old for every feature below.

/** Every capability the current agent has: a machine lacking one of them can be updated. */
export const KNOWN_CAPS = ["files", "capture", "ifaces", "jupyter", "probe", "schema"] as const;
export type Cap = (typeof KNOWN_CAPS)[number];

/** The features of the web app that need the agent to know something, and what that is. */
export const FEATURES = {
  files: { label: "le transfert de fichiers", needs: ["files"] },
  capture: { label: "la capture réseau", needs: ["files", "capture"] },
  ifaces: { label: "la liste des interfaces", needs: ["files", "ifaces"] },
  code: { label: "les fenêtres de code (ouvrir et enregistrer un fichier de la machine)", needs: ["files"] },
  notebook: { label: "les notebooks (ouvrir et enregistrer un fichier de la machine)", needs: ["files"] },
  kernel: { label: "les noyaux Jupyter", needs: ["jupyter"] },
  schema: { label: "la vérification du schéma", needs: ["probe", "schema"] },
} as const satisfies Record<string, { label: string; needs: readonly Cap[] }>;
export type Feature = keyof typeof FEATURES;

/** True when the agent announced every capability the feature needs. No list = old agent. */
export function supports(caps: readonly string[] | null | undefined, feature: Feature): boolean {
  return !!caps && FEATURES[feature].needs.every((c) => caps.includes(c));
}

/** The capabilities the agent lacks compared with what this version of the app knows. */
export function missingCaps(caps: readonly string[] | null | undefined): string[] {
  return KNOWN_CAPS.filter((c) => !caps?.includes(c));
}

/** True when the agent should be updated (it lacks something this app can use). */
export const needsUpdate = (caps: readonly string[] | null | undefined) => missingCaps(caps).length > 0;

/** « L'agent de <machine> est trop ancien pour <fonction> : mets-le à jour » */
export function outdatedMessage(machine: string, feature: Feature): string {
  const name = machine.replace(/\s+/g, " ").trim().slice(0, 60) || "cette machine";
  return `L'agent de ${name} est trop ancien pour ${FEATURES[feature].label} : mets-le à jour.`;
}

/** The command that updates an agent in place, keeping its identity (server/src/install.ts `updateScript`). */
export function updateCommand(origin: string, pin: string | null): string {
  const curl = pin ? `curl -k --pinnedpubkey '${pin}' -fsSL` : "curl -fsSL";
  return `${curl} ${origin.replace(/\/+$/, "")}/update.sh | sh`;
}

/** Error of a feature refused because the agent is too old. */
export class OutdatedError extends Error {
  readonly code = "outdated";
  readonly machine: string;
  readonly feature: Feature;
  constructor(machine: string, feature: Feature) {
    super(outdatedMessage(machine, feature));
    this.machine = machine;
    this.feature = feature;
  }
}
