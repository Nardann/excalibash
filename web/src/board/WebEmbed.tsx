import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Globe, Minimize2, Power, RotateCw } from "lucide-react";
import type { BoardSession } from "./collab.ts";
import { confirmDialog } from "../components/ui.tsx";
import { serverConfig } from "../api.ts";

/** Origin serving tunnelled sites (separate from Excalibash's own, see server/src/proxy.ts). */
const proxyUrl = () => serverConfig().then((c) => c.proxyUrl.replace(/\/$/, ""));

/**
 * A site reached through an end-to-end encrypted tunnel to one of the board's machines. The page
 * itself runs on the proxy origin; we only hand the tunnel key to the frame or tab we opened.
 */
export function WebEmbed(p: { session: BoardSession; webId: string; active: boolean; title?: string | null; onHide?: () => void; onRemove?: () => void }) {
  const info = useSyncExternalStore(
    (cb) => p.session.on("terminals", cb),
    () => p.session.webs.get(p.webId),
  );
  const [base, setBase] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const popups = useRef(new Set<Window>());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    proxyUrl().then(setBase).catch(() => setBase(null));
  }, []);

  // Key handshake with the proxy origin's boot page.
  useEffect(() => {
    if (!base) return;
    const origin = new URL(base).origin;
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || e.data?.type !== "eb-proxy-ready" || e.data.tunnelId !== p.webId) return;
      const source = e.source as Window | null;
      if (!source || (source !== frame.current?.contentWindow && !popups.current.has(source))) return;
      const key = await p.session.webKey(p.webId);
      const target = p.session.webs.get(p.webId)?.target;
      if (key && target) source.postMessage({ type: "eb-proxy-key", tunnelId: p.webId, key, target: target.url }, origin);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [base, p.session, p.webId]);

  // Keep wheel and keys inside the page instead of the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    const events = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, []);

  const url = base ? `${base}/t/${p.webId}/` : null;
  const target = info?.target;
  const label = p.title || target?.machine || "Site web";

  const openTab = () => {
    if (!url) return;
    const w = window.open(url, "_blank");
    if (w) popups.current.add(w);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: "Fermer le tunnel ?",
      text: "La fenêtre et le tunnel vers ce site sont supprimés. Les onglets ouverts sur ce site cesseront de fonctionner.",
      confirm: "Fermer",
      danger: true,
    });
    if (ok) p.onRemove?.();
  };

  return (
    <div className="term web" ref={rootRef}>
      <div className="term-head">
        <span className={`dot ${info?.online ? "on" : ""}`} />
        <Globe size={14} />
        <span className="name" title={target?.url}>
          {label.split("\n")[0]}
          {target && <span className="status"> · {target.url.replace(/^https?:\/\//, "")}</span>}
        </span>
        <button title="Recharger" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw size={14} />
        </button>
        <button title="Ouvrir en grand dans un nouvel onglet" onClick={openTab}>
          <ExternalLink size={14} />
        </button>
        {p.onHide && (
          <button title="Masquer (le tunnel reste, l'icône aussi)" onClick={p.onHide}>
            <Minimize2 size={14} />
          </button>
        )}
        {p.onRemove && (
          <button title="Fermer le tunnel" onClick={remove}>
            <Power size={14} />
          </button>
        )}
      </div>
      <div className="term-body web-body">
        {!info ? (
          <div className="term-veil">Tunnel introuvable (fermé, ou appartenant à un autre tableau).</div>
        ) : !url ? (
          <div className="term-veil">Chargement…</div>
        ) : (
          <iframe
            key={nonce}
            ref={frame}
            src={url}
            title={label}
            // No top navigation: the site can never take over the Excalibash tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
            referrerPolicy="no-referrer"
          />
        )}
        {info && !info.online && <div className="term-veil bottom">La machine est hors ligne.</div>}
      </div>
    </div>
  );
}
