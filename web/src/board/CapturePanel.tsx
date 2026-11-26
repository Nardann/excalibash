import { useEffect, useRef, useState } from "react";
import { toast } from "../components/ui.tsx";
import { AgentOutdatedNotice } from "../components/AgentOutdated.tsx";
import { FileClient, IFACE_RE, filterProblem, type MachineIface, type Signal } from "./fileTransfer.ts";
import { splitDetails } from "./errorDetails.ts";
import { saveBlob, exportName } from "./termTools.ts";

/** A persistent, red error with tcpdump's own line folded under it. */
export function InlineError({ text }: { text: string }) {
  const { message, details } = splitDetails(text);
  return (
    <div className="inline-error" role="alert" data-testid="capture-error">
      <b>{message}</b>
      {details && (
        <details>
          <summary>Détails</summary>
          <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{details}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The machine's real interfaces, for the capture select. null while loading, "unknown" when the
 * agent cannot list them (too old for it, or no answer): the panel then falls back to a text field.
 */
function useMachineIfaces(client: FileClient): MachineIface[] | null | "unknown" {
  const [list, setList] = useState<MachineIface[] | null | "unknown">(null);
  const latest = useRef(client);
  latest.current = client;
  const skip = !!client.refusal("capture") || !!client.refusal("ifaces");
  useEffect(() => {
    if (skip) return setList("unknown");
    let live = true;
    setList(null);
    latest.current.ifaces().then(
      (l) => live && setList(l),
      () => live && setList("unknown"),
    );
    return () => {
      live = false;
    };
  }, [client.terminal, skip]);
  return list;
}

/**
 * Packet capture on an interface of the machine at this cable end, run by the agent through its
 * local shell (tcpdump). The pcap goes straight to the browser, sealed with the shell's key.
 * `cableIface` is the interface written on the cable: preselected when the machine has it.
 */
export function CapturePanel({ client, cableIface }: { client: FileClient; cableIface: string }) {
  const [seconds, setSeconds] = useState(30);
  const [filter, setFilter] = useState("");
  const [mib, setMib] = useState(20);
  const [bytes, setBytes] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signal = useRef<Signal | null>(null);
  const ifaces = useMachineIfaces(client);
  const wanted = cableIface.trim();
  const names = Array.isArray(ifaces) ? ifaces.filter((i) => IFACE_RE.test(i.name)) : null;
  const missing = !!names && !!wanted && !names.some((i) => i.name === wanted);
  const iface = picked ?? (names ? (names.some((i) => i.name === wanted) ? wanted : "") : wanted);
  const ifaceOk = IFACE_RE.test(iface.trim());
  const problem = filterProblem(filter);
  const valid = ifaceOk && !problem && seconds >= 1 && seconds <= 300 && mib >= 1 && mib <= 50;
  useEffect(() => () => void (signal.current && (signal.current.aborted = true)), []);

  const refusal = client.refusal("capture");
  if (refusal)
    return (
      <fieldset className="capture-box">
        <legend>Capturer (pcap)</legend>
        <AgentOutdatedNotice error={refusal} />
      </fieldset>
    );

  const start = async () => {
    const s: Signal = { aborted: false };
    signal.current = s;
    setError(null);
    setBytes(0);
    try {
      const { name, blob } = await client.capture(
        { iface: iface.trim(), filter: filter.trim() || undefined, seconds, maxBytes: Math.round(mib * 1024 * 1024) },
        { signal: s, onProgress: setBytes },
      );
      saveBlob(blob, exportName(name.replace(/\.pcap$/, ""), "pcap"));
      toast(`Capture terminée : ${(blob.size / 1024).toFixed(0)} Kio téléchargés`);
    } catch (e) {
      if (!s.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      signal.current = null;
      setBytes(null);
    }
  };

  return (
    // Enter in a capture field must not submit the cable form: that would close it and cancel the capture.
    <fieldset className="capture-box" onKeyDown={(e) => e.key === "Enter" && e.target instanceof HTMLInputElement && e.preventDefault()}>
      <legend>Capturer (pcap)</legend>
      {bytes === null ? (
        <>
          {error && <InlineError text={error} />}
          {names ? (
            <label className="field">
              Interface à capturer
              <select className="input" aria-label="Interface à capturer" value={iface} onChange={(e) => setPicked(e.target.value)}>
                <option value="" disabled>
                  Choisis une interface…
                </option>
                {names.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                    {i.up ? "" : " (down)"} — {i.addrs[0] ?? "sans adresse"}
                  </option>
                ))}
              </select>
              {missing && (
                <span className="field-help" role="alert" style={{ color: "var(--danger)" }} data-testid="capture-iface-missing">
                  L'interface du câble ({wanted}) n'existe pas sur la machine : choisis-en une dans la liste.
                </span>
              )}
            </label>
          ) : (
            <label className="field">
              Interface à capturer
              <input className="input" aria-label="Interface à capturer" value={iface} onChange={(e) => setPicked(e.target.value)} placeholder="eth0, enp3s0, br-lan…" spellCheck={false} maxLength={32} />
              <span className="field-help">{ifaces === null ? "Recherche des interfaces de la machine…" : "La liste des interfaces n'est pas disponible : saisis le nom à la main."}</span>
            </label>
          )}
          <div className="capture-row">
            <label className="field">
              Durée (s)
              <input className="input" type="number" min={1} max={300} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <label className="field">
              Taille max (Mio)
              <input className="input" type="number" min={1} max={50} value={mib} onChange={(e) => setMib(Number(e.target.value))} />
            </label>
          </div>
          <label className="field">
            Filtre BPF (facultatif)
            <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="tcp port 80 and host 10.0.0.1" spellCheck={false} />
            {problem && <span className="field-help">{problem}</span>}
          </label>
          <button type="button" className="btn" disabled={!valid} onClick={start} title={ifaceOk ? undefined : "Choisis une interface de la machine (eth0, enp3s0, br-lan…)"}>
            Capturer sur {iface.trim() || "…"}
          </button>
          <span className="field-help">
            tcpdump tourne sur la machine : l'agent doit être root (ou tcpdump avoir CAP_NET_RAW). La connexion de l'agent au serveur est exclue de la capture.
            Le fichier .pcap arrive chiffré de bout en bout. Garde cette fenêtre ouverte jusqu'à la fin.
          </span>
        </>
      ) : (
        <div className="capture-row">
          <span>{(bytes / 1024).toFixed(1)} Kio capturés…</span>
          <button type="button" className="btn" onClick={() => signal.current && (signal.current.stop = true)}>
            Arrêter
          </button>
          <button type="button" className="btn" onClick={() => signal.current && (signal.current.aborted = true)}>
            Annuler
          </button>
        </div>
      )}
    </fieldset>
  );
}
