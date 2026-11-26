// An agent error is « message\nDétail : <ligne d'origine de tcpdump> » (agent/capture.go): the first part is shown,
// the second folded.
/** The agent's message and, after « Détail : », tcpdump's own line. */
export function splitDetails(text: string): { message: string; details?: string } {
  const i = text.indexOf("\nDétail : ");
  return i < 0 ? { message: text } : { message: text.slice(0, i), details: text.slice(i + "\nDétail : ".length) };
}
