import { useEffect, useRef, useSyncExternalStore } from "react";
import { Monitor, Router } from "lucide-react";
import type { BoardSession } from "./collab.ts";
import type { TileIcon } from "./personalLibrary.ts";
import { useIconUrl } from "./TerminalEmbed.tsx";

/** A node of the diagram: its icon, label and the combined state of its shells. */
export function NodeTile(p: {
  session: BoardSession;
  shells: string[];
  webCount?: number;
  openCount: number;
  title?: string | null;
  icon?: TileIcon | null;
  /** Name of the icon's machine, for when it has no shell left. */
  machineName?: string;
  /** A device reached over Telnet / SSH (no agent on it). */
  remote?: boolean;
  active: boolean;
  onActivate: () => void;
}) {
  const iconSrc = useIconUrl(p.icon);
  // Re-render when any terminal status changes.
  const statusKey = useSyncExternalStore(
    (cb) => p.session.on("terminals", cb),
    () => p.shells.map((id) => p.session.terminals.get(id)?.status ?? "").join(","),
  );
  const statuses = statusKey.split(",");
  const state = statuses.includes("running") ? "on" : statuses.includes("starting") ? "warn" : "";
  const label = p.title || (p.shells.length && p.session.terminals.get(p.shells[0])?.label) || p.machineName || (p.shells.length ? "Machine" : "Nouvelle machine");

  // Clicking the icon activates it: that is the "open its shells" gesture. Fire once per
  // activation (the callback changes on every render while Excalidraw catches up).
  const wasActive = useRef(false);
  const onActivate = useRef(p.onActivate);
  onActivate.current = p.onActivate;
  useEffect(() => {
    if (p.active && !wasActive.current) onActivate.current();
    wasActive.current = p.active;
  }, [p.active]);

  const webs = p.webCount ?? 0;
  const shellsText = [
    `${p.shells.length} shell${p.shells.length > 1 ? "s" : ""}`,
    webs ? `${webs} site${webs > 1 ? "s" : ""}` : "",
    p.openCount ? `${p.openCount} ouvert${p.openCount > 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="term collapsed">
      <div className={`term-tile ${iconSrc ? "custom" : ""}`} title={`${label} — ${shellsText}. Clique pour ouvrir.`}>
        {iconSrc ? (
          <div className="tile-art">
            <img src={iconSrc} alt="" draggable={false} />
            <span className={`dot ${state}`} />
          </div>
        ) : (
          <div className="tile-icon">
            {p.remote ? <Router size={40} strokeWidth={1.6} /> : <Monitor size={40} strokeWidth={1.6} />}
            {!p.remote && <span className="prompt">&gt;_</span>}
            <span className={`dot ${state}`} />
          </div>
        )}
        <div className="tile-name">{label}</div>
        {!iconSrc && <div className="tile-status">{shellsText}</div>}
        {p.shells.length + webs > 1 && <span className="tile-count">{p.shells.length + webs}</span>}
      </div>
    </div>
  );
}
