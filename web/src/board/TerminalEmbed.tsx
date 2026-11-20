import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Cable, Maximize2, Minimize2, Monitor, Palette, Power, RotateCcw, TerminalSquare } from "lucide-react";
import { isRemoteLabel, type BoardSession } from "./collab.ts";
import { confirmDialog, useTheme } from "../components/ui.tsx";
import { iconUrl, type TileIcon } from "./personalLibrary.ts";
import { TileCustomizer, type TilePatch } from "./TileCustomizer.tsx";

const FONT = '"Cascadia Code", ui-monospace, Menlo, monospace';

const THEME = {
  background: "#0b1020",
  foreground: "#e2e8f0",
  cursor: "#a5b4fc",
  cursorAccent: "#0b1020",
  selectionBackground: "#4f46e580",
  black: "#1e293b",
  red: "#f43f5e",
  green: "#10b981",
  yellow: "#f59e0b",
  blue: "#6366f1",
  magenta: "#d946ef",
  cyan: "#06b6d4",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightRed: "#fb7185",
  brightGreen: "#34d399",
  brightYellow: "#fbbf24",
  brightBlue: "#818cf8",
  brightMagenta: "#e879f9",
  brightCyan: "#22d3ee",
  brightWhite: "#f8fafc",
};

function useTerminalInfo(session: BoardSession, id: string) {
  return useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => session.terminals.get(id),
  );
}

const STATUS_LABEL = {
  starting: "démarrage…",
  running: "en cours",
  exited: "terminé",
  offline: "machine hors ligne",
};

/**
 * A live shell rendered inside an Excalidraw embeddable. Excalidraw only routes
 * pointer events to it once the user clicks the element ("active" state).
 */
type Props = {
  session: BoardSession;
  terminalId: string;
  active: boolean;
  /** Shown as a small machine tile; the shell keeps running and its grid is untouched. */
  collapsed: boolean;
  /** Custom label and library icon shown on the tile. */
  title?: string | null;
  icon?: TileIcon | null;
  onToggleCollapsed?: () => void;
  /** Tooltip of the header's reduce button (windows of a node are hidden, not collapsed). */
  toggleTitle?: string;
  onCustomize?: (patch: TilePatch, collapse: boolean) => void;
};

export function useIconUrl(icon: TileIcon | null | undefined) {
  const { theme } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!icon) return setUrl(null);
    let live = true;
    iconUrl(icon, theme === "dark").then((u) => live && setUrl(u)).catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [icon, theme]);
  return url;
}

export function TerminalEmbed({ session, terminalId, active, collapsed, title, icon, onToggleCollapsed, toggleTitle, onCustomize }: Props) {
  const info = useTerminalInfo(session, terminalId);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // New output while reduced to a tile: show an activity badge.
  const [unread, setUnread] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const iconSrc = useIconUrl(icon);

  useEffect(() => {
    const body = bodyRef.current!;
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;

    let disposed = false;
    let unsubscribe = () => {};
    let observer: ResizeObserver | undefined;

    const refit = () => {
      if (disposed || !body.offsetWidth || !body.offsetHeight) return;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const cols = Math.max(10, dims.cols);
      const rows = Math.max(3, dims.rows);
      if (cols !== term.cols || rows !== term.rows) {
        term.resize(cols, rows);
        session.resizeTerminal(terminalId, cols, rows);
      }
    };

    // Metrics must use the real font, or every client computes a different grid.
    document.fonts.load(`13px ${FONT}`).finally(() => {
      if (disposed) return;
      term.open(body);
      term.onData((d) => session.terminalInput(terminalId, d));
      term.onBinary((d) => session.terminalInput(terminalId, Uint8Array.from(d, (c) => c.charCodeAt(0))));
      unsubscribe = session.subscribeTerminal(terminalId, {
        onReplay: (data) => {
          term.reset();
          term.write(data);
        },
        onData: (data) => {
          term.write(data);
          if (collapsedRef.current && data.length) setUnread(true);
        },
      });
      observer = new ResizeObserver(refit);
      observer.observe(body);
      refit();
      if (activeRef.current) term.focus();
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
      term.dispose();
      termRef.current = null;
    };
  }, [session, terminalId]);

  // Someone else resized the window: follow the PTY's grid.
  useEffect(() => {
    const term = termRef.current;
    if (term && info && (info.cols !== term.cols || info.rows !== term.rows) && term.element) term.resize(info.cols, info.rows);
  }, [info?.cols, info?.rows]);

  useEffect(() => {
    if (active && !collapsed) termRef.current?.focus();
    else termRef.current?.blur();
  }, [active, collapsed]);

  // Clicking a selected tile activates it: that is the "open" gesture.
  useEffect(() => {
    if (active && collapsed) onToggleCollapsed?.();
  }, [active, collapsed, onToggleCollapsed]);

  useEffect(() => {
    if (!collapsed) setUnread(false);
  }, [collapsed]);

  // Keep keys, clipboard and wheel inside the terminal instead of reaching the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    const events = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, []);

  const status = info?.status;
  const kill = async () => {
    const ok = await confirmDialog({
      title: "Fermer le terminal ?",
      text: "Le shell et les programmes qui tournent dedans seront arrêtés.",
      confirm: "Fermer",
      danger: true,
    });
    if (ok) session.closeTerminal(terminalId);
  };

  const dot = `dot ${status === "running" ? "on" : status === "starting" ? "warn" : ""}`;
  const label = info?.label ?? "Terminal";
  const name = title || label;

  return (
    <div className={`term ${collapsed ? "collapsed" : ""}`} ref={rootRef}>
      {collapsed && (
        <div className={`term-tile ${unread ? "unread" : ""} ${iconSrc ? "custom" : ""}`} title={`${name} (${label}) — clique pour ouvrir le shell`}>
          {iconSrc ? (
            <div className="tile-art">
              <img src={iconSrc} alt="" draggable={false} />
              <span className={dot} />
            </div>
          ) : (
            <div className="tile-icon">
              <Monitor size={40} strokeWidth={1.6} />
              <span className="prompt">&gt;_</span>
              <span className={dot} />
            </div>
          )}
          <div className="tile-name">{name}</div>
          {!iconSrc && <div className="tile-status">{unread ? "nouvelle sortie" : status ? STATUS_LABEL[status] : "introuvable"}</div>}
          {onToggleCollapsed && (
            <span className="tile-expand">
              <Maximize2 size={12} />
            </span>
          )}
        </div>
      )}
      <div className="term-head">
        <span className={dot} />
        {isRemoteLabel(label) ? <Cable size={14} /> : <TerminalSquare size={14} />}
        <span className="name" title={label}>
          {name.split("\n")[0]}
          {title && <span className="status"> · {label}</span>}
        </span>
        {!session.canEdit && <span className="status">lecture seule</span>}
        <span className="status">{status ? STATUS_LABEL[status] : "introuvable"}</span>
        {status === "exited" && session.canEdit && (
          <button title="Relancer" onClick={() => session.restartTerminal(terminalId)}>
            <RotateCcw size={14} />
          </button>
        )}
        {onCustomize && (
          <button title="Icône et libellé de la tuile" onClick={() => setCustomizing(true)}>
            <Palette size={14} />
          </button>
        )}
        {onToggleCollapsed && (
          <button title={toggleTitle ?? "Réduire en tuile"} onClick={onToggleCollapsed}>
            <Minimize2 size={14} />
          </button>
        )}
        {(status === "running" || status === "starting") && session.canEdit && (
          <button title="Fermer le shell" onClick={kill}>
            <Power size={14} />
          </button>
        )}
      </div>
      {customizing && onCustomize && (
        <TileCustomizer machineLabel={label} title={title ?? null} icon={icon ?? null} onSave={onCustomize} onClose={() => setCustomizing(false)} />
      )}
      <div className="term-body" ref={bodyRef}>
        {(!info || status === "exited" || status === "offline") && (
          <div className={`term-veil ${status === "exited" ? "bottom" : ""}`}>
            {!info ? (
              <span>Terminal introuvable (fermé, supprimé ou appartenant à un autre tableau).</span>
            ) : status === "offline" ? (
              <span>
                {info.label} est hors ligne.
                <br />
                <small style={{ opacity: 0.7 }}>Le shell reprendra dès que l'agent se reconnecte.</small>
              </span>
            ) : (
              <>
                <span>Session terminée{info.exitCode !== null ? ` (code ${info.exitCode})` : ""}</span>
                {session.canEdit && (
                  <button className="btn btn-sm btn-primary" onClick={() => session.restartTerminal(terminalId)}>
                    <RotateCcw size={14} /> Relancer
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
