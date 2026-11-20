import { useEffect, useRef, useState } from "react";
import { Cable } from "lucide-react";
import type { RemoteTarget } from "../api.ts";
import { useKeys } from "../auth.tsx";
import { listMachines, type Machine } from "../vault.ts";
import { Modal, toast } from "../components/ui.tsx";

export const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._@-]{0,64}$/;
const DEFAULT_PORT: Record<RemoteTarget["kind"], string> = { telnet: "23", ssh: "22", raw: "" };

/** The machines of the user, with one picked (the given default, else the first one). */
export function useMachineChoice(defaultId: string | null) {
  const keys = useKeys();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machineId, setMachineId] = useState(defaultId ?? "");
  useEffect(() => {
    listMachines(keys)
      .then((ms) => {
        setMachines(ms);
        setMachineId((id) => (ms.some((m) => m.id === id) || !ms[0] ? id : ms[0].id));
      })
      .catch(toast.error);
  }, [keys]);
  return { machines, machineId, setMachineId, machine: machines?.find((m) => m.id === machineId) };
}

export function MachineField({ label, choice }: { label: string; choice: ReturnType<typeof useMachineChoice> }) {
  return (
    <label className="field">
      {label}
      <select className="select" value={choice.machineId} onChange={(e) => choice.setMachineId(e.target.value)} style={{ width: "100%" }}>
        {choice.machines?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.online ? "" : " (hors ligne)"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What the session amounts to, as a command the user could type on the machine. */
function preview(t: RemoteTarget): string {
  if (t.kind === "telnet") return `telnet ${t.host} ${t.port}`;
  if (t.kind === "raw") return `nc ${t.host} ${t.port}`;
  const opts = [
    t.legacyKex && "-o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1",
    t.legacyHostKey && "-o HostKeyAlgorithms=+ssh-rsa,ssh-dss",
    t.legacyCiphers && "-o Ciphers=+aes128-cbc,aes256-cbc,3des-cbc -o MACs=+hmac-sha1",
    t.hostKeyCheck === "off" && "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
  ].filter(Boolean);
  return ["ssh", `${t.user ? `${t.user}@` : ""}${t.host}`, "-p", t.port, ...opts].join(" ");
}

/** A Telnet / SSH / TCP session to a device reachable from one of the user's machines (lab switches, routers…). */
export function RemoteForm({
  defaultMachineId,
  onClose,
  onCreate,
}: {
  defaultMachineId: string | null;
  onClose: () => void;
  onCreate: (m: Machine, target: RemoteTarget) => void;
}) {
  const choice = useMachineChoice(defaultMachineId);
  const [kind, setKind] = useState<RemoteTarget["kind"]>("ssh");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [portEdited, setPortEdited] = useState(false);
  const [user, setUser] = useState("");
  const [legacy, setLegacy] = useState({ legacyKex: false, legacyHostKey: false, legacyCiphers: false });
  const [hostKeyCheck, setHostKeyCheck] = useState<"tofu" | "off">("tofu");
  const legacyAll = useRef<HTMLInputElement>(null);

  const legacyCount = Object.values(legacy).filter(Boolean).length;
  useEffect(() => {
    if (legacyAll.current) legacyAll.current.indeterminate = legacyCount > 0 && legacyCount < 3;
  }, [legacyCount]);

  const ssh = kind === "ssh";
  const cleanHost = host.trim().replace(/^\[|\]$/g, "");
  const cleanUser = user.trim();
  const portNum = Number(port);
  const hostOk = HOST_RE.test(cleanHost);
  const userOk = !ssh || USER_RE.test(cleanUser);
  const portOk = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const valid = !!choice.machine && hostOk && userOk && portOk;
  const target: RemoteTarget = ssh
    ? { kind, host: cleanHost, port: portNum, user: cleanUser, ...legacy, hostKeyCheck }
    : { kind, host: cleanHost, port: portNum };

  const legacyOption = (key: keyof typeof legacy, label: string, help: string) => (
    <label className="check sub">
      <input type="checkbox" checked={legacy[key]} onChange={(e) => setLegacy({ ...legacy, [key]: e.target.checked })} />
      <span>
        {label}
        <small>{help}</small>
      </span>
    </label>
  );

  return (
    <Modal onClose={onClose} width={560}>
      <h2 className="display">Connexion à un équipement</h2>
      <p>
        Un switch, un routeur ou un PC joint <b>depuis la machine</b> en Telnet ou SSH. La session s'ouvre dans un terminal du tableau, chiffrée de bout en
        bout jusqu'à l'agent.
      </p>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onCreate(choice.machine!, target);
        }}
      >
        <MachineField label="Machine relais (une des tiennes)" choice={choice} />
        <div className="web-form">
          <label className="field">
            Protocole
            <select
              className="select"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as RemoteTarget["kind"];
                setKind(k);
                if (!portEdited) setPort(DEFAULT_PORT[k]);
              }}
            >
              <option value="telnet">Telnet</option>
              <option value="ssh">SSH</option>
              <option value="raw">TCP brut</option>
            </select>
          </label>
          <label className="field">
            Hôte (vu depuis la machine)
            <input className="input" value={host} autoFocus onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.1" spellCheck={false} />
          </label>
          <label className="field">
            Port
            <input
              className="input"
              value={port}
              inputMode="numeric"
              placeholder={kind === "raw" ? "2001" : undefined}
              onChange={(e) => {
                setPort(e.target.value.replace(/\D/g, ""));
                setPortEdited(true);
              }}
            />
          </label>
        </div>
        {host.trim() && !hostOk && <span className="form-warn">Hôte invalide : un nom ou une adresse IP, sans espace ni schéma.</span>}
        {ssh && (
          <label className="field">
            Utilisateur
            <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" autoComplete="off" spellCheck={false} />
            <span className="field-help">
              {userOk ? "Facultatif : vide, il est demandé dans le terminal. Le mot de passe se tape dans le terminal, jamais ici." : "Utilisateur invalide (lettres, chiffres, . _ @ -)."}
            </span>
          </label>
        )}
        {kind === "telnet" && <span className="field-help">Telnet n'est pas chiffré entre la machine et l'équipement : à réserver au réseau du TP.</span>}
        {kind === "raw" && <span className="field-help">Aucun protocole : utile pour une console série derrière un serveur de terminaux.</span>}
        {ssh && (
          <details className="advanced">
            <summary>Configuration avancée</summary>
            <div className="advanced-body">
              <label className="check">
                <input
                  ref={legacyAll}
                  type="checkbox"
                  checked={legacyCount === 3}
                  onChange={(e) => setLegacy({ legacyKex: e.target.checked, legacyHostKey: e.target.checked, legacyCiphers: e.target.checked })}
                />
                <span>
                  Équipement ancien
                  <small>Vieux switch ou routeur qui refuse la connexion avec « no matching key exchange method found ». Active les trois options ci-dessous.</small>
                </span>
              </label>
              {legacyOption("legacyKex", "Échange de clés", "diffie-hellman-group1 / group14 en SHA-1 : corrige « no matching key exchange method found ».")}
              {legacyOption("legacyHostKey", "Clé d'hôte", "ssh-rsa (SHA-1) et ssh-dss : corrige « no matching host key type found ».")}
              {legacyOption("legacyCiphers", "Chiffrements", "aes-cbc, 3des-cbc et hmac-sha1 : corrige « no matching cipher found ».")}
              <div className="field">
                Vérification de la clé d'hôte
                <label className="check">
                  <input type="radio" name="hostKeyCheck" checked={hostKeyCheck === "tofu"} onChange={() => setHostKeyCheck("tofu")} />
                  <span>
                    À la première connexion (recommandé)
                    <small>L'empreinte est retenue par l'agent ; une clé différente ensuite bloque la connexion.</small>
                  </span>
                </label>
                <label className="check">
                  <input type="radio" name="hostKeyCheck" checked={hostKeyCheck === "off"} onChange={() => setHostKeyCheck("off")} />
                  <span>
                    Désactivée
                    <small>Pour un équipement réinitialisé à chaque TP.</small>
                  </span>
                </label>
                {hostKeyCheck === "off" && <span className="form-warn">Sans vérification, rien ne garantit que tu parles au bon équipement.</span>}
              </div>
            </div>
          </details>
        )}
        {valid && (
          <>
            <span className="field-help">Équivaut à taper, sur {choice.machine!.name} :</span>
            <div className="codebox" style={{ paddingRight: 14 }}>
              {preview(target)}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={!valid}>
            <Cable size={16} /> Se connecter
          </button>
        </div>
      </form>
    </Modal>
  );
}
