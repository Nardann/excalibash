import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { serverConfig } from "../api.ts";
import { updateCommand, type OutdatedError } from "../agentCaps.ts";
import { onOutdated } from "../outdatedBus.ts";
import { Modal, copyText, toast } from "./ui.tsx";

/** The update command of this instance (with the certificate pin of a self-signed one). */
export function useUpdateCommand(): string {
  const [pin, setPin] = useState<string | null>(null);
  useEffect(() => {
    serverConfig()
      .then((c) => setPin(c.tls?.pin ?? null))
      .catch(() => {});
  }, []);
  return updateCommand(window.location.origin, pin);
}

/** What to do about an old agent, in words: the command, run on the machine itself. */
export function UpdateHowTo({ command }: { command: string }) {
  return (
    <>
      <p style={{ margin: "6px 0" }}>
        Lance cette commande sur la machine (sans toucher à sa clé ni à son nom ; si l'agent y tourne en service système, avec <code>sudo sh</code> à la place de <code>sh</code>) :
      </p>
      <div className="codebox" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <code style={{ flex: 1, wordBreak: "break-all" }}>{command}</code>
        <button type="button" className="btn btn-sm btn-icon" title="Copier la commande" onClick={() => copyText(command).then(() => toast("Commande copiée"))}>
          <Copy size={14} />
        </button>
      </div>
    </>
  );
}

/** Inline, persistent notice (in a panel): the refusal and how to fix it. */
export function AgentOutdatedNotice({ error }: { error: Pick<OutdatedError, "message"> }) {
  const command = useUpdateCommand();
  return (
    <div className="inline-error" role="alert" data-testid="agent-outdated">
      <b>{error.message}</b>
      <UpdateHowTo command={command} />
    </div>
  );
}

/** Mounted once: shows the dialog when a feature is refused because the agent is too old. */
export function AgentOutdatedHost() {
  const [err, setErr] = useState<OutdatedError | null>(null);
  const command = useUpdateCommand();
  useEffect(() => onOutdated(setErr), []);
  if (!err) return null;
  return (
    <Modal onClose={() => setErr(null)} width={560}>
      <h2 className="display">Agent à mettre à jour</h2>
      <p data-testid="agent-outdated">{err.message}</p>
      <UpdateHowTo command={command} />
      <div className="modal-actions">
        <button className="btn btn-primary" autoFocus onClick={() => setErr(null)}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
