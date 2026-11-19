import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// ---- Theme ------------------------------------------------------------------------

export type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({ theme: "light", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("eb-theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

// ---- Toasts -----------------------------------------------------------------------

type Toast = { id: number; text: string; kind: "info" | "error" };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};

export function toast(text: string) {
  pushToast({ text, kind: "info" });
}
toast.error = (e: unknown) => pushToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === "error" ? 5000 : 2800);
    };
  }, []);
  return createPortal(
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---- Modal ------------------------------------------------------------------------

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog">
        {children}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOpts = { title: string; text: string; confirm: string; danger?: boolean };
let openConfirm: (o: ConfirmOpts) => Promise<boolean> = async () => false;

export const confirmDialog = (o: ConfirmOpts) => openConfirm(o);

export function ConfirmHost() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  useEffect(() => {
    openConfirm = (o) => new Promise((resolve) => setState({ ...o, resolve }));
  }, []);
  if (!state) return null;
  const done = (v: boolean) => {
    state.resolve(v);
    setState(null);
  };
  return (
    <Modal onClose={() => done(false)}>
      <h2 className="display">{state.title}</h2>
      <p>{state.text}</p>
      <div className="modal-actions">
        <button className="btn" onClick={() => done(false)}>
          Annuler
        </button>
        <button className={`btn ${state.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => done(true)}>
          {state.confirm}
        </button>
      </div>
    </Modal>
  );
}

// ---- Floating menu ----------------------------------------------------------------

export type MenuAnchor = { x: number; y: number } | HTMLElement;

export function Menu({ anchor, onClose, children, align = "left" }: { anchor: MenuAnchor; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      left = align === "right" ? r.right - width : r.left;
      top = r.bottom + 6;
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    if (top + height > innerHeight - 8) top = Math.max(8, innerHeight - height - 8);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="menu" style={pos} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

// ---- Small bits -------------------------------------------------------------------

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="4" y="6" width="56" height="52" rx="12" fill="#4f46e5" stroke="var(--ink)" strokeWidth="4" />
      <path d="M18 24l10 8-10 8" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 42h13" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <path d="M44 16c4 1 7 3 9 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" opacity=".6" />
    </svg>
  );
}

export function Avatar({ name, color, title }: { name: string; color: string; title?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div className="avatar" style={{ background: color }} title={title ?? name}>
      {initials || "?"}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copié dans le presse-papiers");
  } catch {
    toast.error("Impossible de copier — sélectionne le texte manuellement");
  }
}
