// A code window: Monaco (open-source core of VS Code) bound to an end-to-end encrypted shared
// Yjs document (sharedDoc.ts). The text and the cursors travel sealed; the file itself lives on
// the node's machine, read and written through the sealed file channel of a local shell.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Download, FileCode2, FolderOpen, Minimize2, Play, Power, RefreshCw, Save, SaveAll } from "lucide-react";
import { MonacoBinding } from "y-monaco";
import type * as Monaco from "monaco-editor";
import { monaco } from "./monacoEnv.ts";
import type { BoardSession } from "./collab.ts";
import { openSharedDoc, type SharedDoc } from "./sharedDoc.ts";
import {
  LANGUAGES,
  cursorStyleSheet,
  initBlank,
  initFromFile,
  isDirty,
  markSaved,
  readMeta,
  runCommand,
  safeColor,
  safeLabel,
  sha256Hex,
  takeInit,
  type CodeMeta,
} from "./codeDoc.ts";
import { openMachineFile, pickLocalShell, saveMachineFile, sendCommand } from "./machineFiles.ts";

/** What the window needs from the app's UI kit, handed in by the board page (this chunk must not import it: see BoardPage). */
export type CodeHost = {
  theme: "light" | "dark";
  confirm: (o: { title: string; text: string; confirm: string; danger?: boolean }) => Promise<boolean>;
  toast: (text: string) => void;
};

type Props = {
  host: CodeHost;
  session: BoardSession;
  docId: string;
  active: boolean;
  /** The node's shells, the ones whose window is open first: the file goes through the first running local one. */
  shells: string[];
  title?: string | null;
  onHide?: () => void;
  onRemove?: () => void;
};

type Person = { clientId: number; name: string; color: string; self: boolean };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

const WHEEL_AND_KEYS = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];

/** The document handle of this window: opened with it, released with it. */
function useDoc(session: BoardSession, docId: string) {
  const [doc, setDoc] = useState<SharedDoc | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const d = openSharedDoc(session, docId);
    setDoc(d);
    setReady(false);
    const off = d.onError((m) => live && setError(m));
    d.synced.then(() => {
      if (!live) return;
      // A file opened from the machine (or a new blank one) fills the document once, here.
      if (!d.readOnly) {
        const init = takeInit(docId);
        if (init === "blank") initBlank(d.ydoc);
        else if (init) initFromFile(d.ydoc, { ...init, by: session.you?.name });
      }
      setReady(true);
    });
    return () => {
      live = false;
      off();
      d.destroy();
    };
  }, [session, docId]);
  return { doc, ready, error };
}

export default function CodeEmbed({ host, session, docId, active, shells, title, onHide, onRemove }: Props) {
  const { doc, ready, error } = useDoc(session, docId);
  const { theme, confirm: confirmDialog, toast } = host;
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [meta, setMeta] = useState<CodeMeta>({ name: "sans-titre", language: "plaintext" });
  const [sha, setSha] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const readOnly = !session.canEdit || !!doc?.readOnly;

  // Shell statuses live in the session: re-render when they change.
  useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => [...session.terminals.values()].map((t) => t.status).join(),
  );
  const shell = pickLocalShell(session, { shells: shells.map((terminalId) => ({ terminalId })) });
  const noShell = "Aucun shell local en cours sur cette machine";

  // Keep keys, clipboard and wheel inside the editor instead of reaching the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    for (const ev of WHEEL_AND_KEYS) el.addEventListener(ev, stop);
    return () => {
      for (const ev of WHEEL_AND_KEYS) el.removeEventListener(ev, stop);
    };
  }, []);

  // Metadata, content hash (for the dirty state) and people, from the document.
  useEffect(() => {
    if (!doc || !ready) return;
    const text = doc.ydoc.getText("content");
    const map = doc.ydoc.getMap("meta");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gen = 0;
    const hash = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const g = ++gen;
        const h = await sha256Hex(text.toString());
        if (g === gen) setSha(h);
      }, 120);
    };
    const readM = () => setMeta(readMeta(map));
    readM();
    hash();
    map.observe(readM);
    text.observe(hash);
    const aw = doc.awareness;
    const readP = () => {
      const list: Person[] = [];
      aw.getStates().forEach((s: any, clientId) => {
        if (s?.user) list.push({ clientId, name: safeLabel(s.user.name), color: safeColor(s.user.color), self: clientId === aw.clientID });
      });
      setPeople((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
    };
    readP();
    aw.on("change", readP);
    return () => {
      clearTimeout(timer);
      gen++;
      map.unobserve(readM);
      text.unobserve(hash);
      aw.off("change", readP);
    };
  }, [doc, ready]);

  // Remote cursors: y-monaco tags them with per-client classes; colour and name come from awareness.
  const styleRef = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    styleRef.current = style;
    return () => style.remove();
  }, []);
  useEffect(() => {
    if (styleRef.current) styleRef.current.textContent = cursorStyleSheet(people.filter((p) => !p.self));
  }, [people]);

  // The editor itself.
  useEffect(() => {
    if (!doc || !ready || !hostRef.current) return;
    const model = monaco.editor.createModel("", readMeta(doc.ydoc.getMap("meta")).language);
    const editor = monaco.editor.create(hostRef.current, {
      model,
      readOnly,
      theme: theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 4,
      domReadOnly: readOnly,
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(doc.ydoc.getText("content"), model, new Set([editor]), doc.awareness);
    return () => {
      binding.destroy();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // `theme` and `readOnly` are applied by the effects below, without rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, ready]);
  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly, ready]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== meta.language) monaco.editor.setModelLanguage(model, meta.language);
  }, [meta.language, ready]);

  const dirty = sha !== null && isDirty(sha, meta.savedSha);
  const text = () => doc!.ydoc.getText("content").toString();

  const guard = async (what: string, f: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    try {
      await f();
    } catch (e: any) {
      toast(e?.message ?? "Erreur");
    } finally {
      setBusy(null);
    }
  };

  /** Writes the document to the machine; resolves true once it is saved. */
  const write = async (path: string): Promise<boolean> => {
    if (!doc || !shell) return false;
    const r = await saveMachineFile(shell.client, path, text(), {
      baseSha: path === meta.path ? meta.savedSha : undefined,
      confirm: (reason) =>
        confirmDialog({
          title: "Écraser le fichier ?",
          text:
            reason === "changed"
              ? `« ${path} » a été modifié sur la machine depuis l'ouverture — écraser ?`
              : `« ${path} » existe déjà sur la machine — écraser ?`,
          confirm: "Écraser",
          danger: true,
        }),
    });
    if (!r) return false;
    markSaved(doc.ydoc, { path: r.path, sha: r.sha, by: session.you?.name });
    toast(`Enregistré : ${r.path}`);
    return true;
  };

  const save = useCallback(
    (as = false) => {
      if (!doc || readOnly) return Promise.resolve(false);
      if (!shell) {
        toast(noShell);
        return Promise.resolve(false);
      }
      if (!meta.path || as) {
        setSaveAs(meta.path ?? meta.name);
        return Promise.resolve(false);
      }
      let saved = false;
      return guard("save", async () => void (saved = await write(meta.path!))).then(() => saved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, readOnly, shell?.terminalId, meta.path, meta.name, meta.savedSha, busy],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl+S, from the editor or from anywhere in the window.
  useEffect(() => {
    const el = rootRef.current!;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "s" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      void saveRef.current(e.shiftKey);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !ready) return;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(false));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => void saveRef.current(true));
  }, [ready, doc]);

  const submitSaveAs = (path: string) => {
    const p = path.trim();
    setSaveAs(null);
    if (!p || /[\0]/.test(p) || p.endsWith("/")) return toast("Chemin invalide");
    void guard("save", async () => void (await write(p)));
  };

  const reload = async () => {
    if (!doc || !shell || !meta.path || readOnly) return;
    if (dirty && !(await confirmDialog({ title: "Recharger depuis la machine ?", text: "Les modifications non enregistrées du document, pour tout le monde, seront perdues.", confirm: "Recharger", danger: true }))) return;
    await guard("reload", async () => {
      const f = await openMachineFile(shell.client, meta.path!);
      const t = doc.ydoc.getText("content");
      doc.ydoc.transact(() => {
        t.delete(0, t.length);
        t.insert(0, f.text);
        const m = doc.ydoc.getMap("meta");
        m.set("savedSha", f.sha);
        m.set("savedAt", Date.now());
        if (session.you?.name) m.set("savedBy", session.you.name);
      });
    });
  };

  const download = () => {
    if (!doc) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text()], { type: "text/plain;charset=utf-8" }));
    a.download = meta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const cmd = meta.path ? runCommand(meta.path, meta.language) : runCommand(meta.name, meta.language);
  const runnable = !!runCommand(meta.name, meta.language);
  const run = async () => {
    if (!doc || !shell || !runnable) return;
    // Save first (the file on the machine must be what is on screen), then run what it became.
    if (!meta.path || dirty) {
      if (!meta.path) return void setSaveAs(meta.name);
      if (!(await saveRef.current(false))) return;
    }
    const path = doc.ydoc.getMap("meta").get("path");
    const line = typeof path === "string" ? runCommand(path, meta.language) : cmd;
    if (!line) return;
    const ok = await confirmDialog({
      title: "Exécuter dans le terminal ?",
      text: `La ligne suivante sera tapée dans le shell « ${session.terminals.get(shell.terminalId)?.label ?? "local"} » : ${line}`,
      confirm: "Exécuter",
    });
    if (ok) sendCommand(session, shell.terminalId, line);
  };

  const label = title || meta.name;
  const needsShell = (action: string) => (readOnly ? "Lecture seule" : shell ? action : noShell);
  const bg = theme === "dark" ? "#1e1e1e" : "#ffffff";

  return (
    <div className={`term code ${active ? "active" : ""}`} ref={rootRef} style={{ ["--term-bg" as any]: bg }}>
      <div className="term-head">
        <FileCode2 size={14} />
        <span className="name" title={meta.path ?? meta.name}>
          {meta.name}
          {dirty && <span className="code-dirty" title="Modifications non enregistrées sur la machine" />}
          {title && <span className="status"> · {title.split("\n")[0]}</span>}
        </span>
        <select
          className="code-lang"
          value={meta.language}
          disabled={readOnly || !ready}
          title="Langage"
          aria-label="Langage"
          onChange={(e) => doc?.ydoc.getMap("meta").set("language", e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <div className="code-people" aria-label="Personnes dans le document">
          {people.slice(0, 5).map((p) => (
            <div key={p.clientId} className="avatar" style={{ background: p.color }} title={p.self ? `${p.name} (vous)` : p.name}>
              {initials(p.name)}
            </div>
          ))}
          {people.length > 5 && <span className="code-more">+{people.length - 5}</span>}
        </div>
        <button title={needsShell("Enregistrer sur la machine (Ctrl+S)")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void save(false)}>
          <Save size={14} />
        </button>
        <button title={needsShell("Enregistrer sous… (Ctrl+Maj+S)")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void save(true)}>
          <SaveAll size={14} />
        </button>
        <button
          title={!meta.path ? "Ce document n'est lié à aucun fichier de la machine" : needsShell("Recharger depuis la machine")}
          disabled={readOnly || !shell || !meta.path || !!busy || !ready}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
        </button>
        <button title="Télécharger" disabled={!ready} onClick={download}>
          <Download size={14} />
        </button>
        {runnable && (
          <button title={needsShell("Enregistrer puis exécuter dans le terminal")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void run()}>
            <Play size={14} />
          </button>
        )}
        {onHide && (
          <button title="Masquer (le document reste partagé, l'icône aussi)" onClick={onHide}>
            <Minimize2 size={14} />
          </button>
        )}
        {onRemove && (
          <button
            title="Retirer ce fichier de la machine"
            onClick={async () => {
              if (await confirmDialog({ title: "Retirer ce fichier du schéma ?", text: `« ${label} » disparaît du schéma. Le fichier sur la machine n'est pas touché.`, confirm: "Retirer", danger: true })) onRemove();
            }}
          >
            <Power size={14} />
          </button>
        )}
      </div>
      {saveAs !== null && (
        <form
          className="code-saveas"
          onSubmit={(e) => {
            e.preventDefault();
            submitSaveAs(saveAs);
          }}
        >
          <FolderOpen size={14} />
          <input
            autoFocus
            value={saveAs}
            spellCheck={false}
            placeholder="chemin/fichier.py (relatif au dossier du shell, ou absolu)"
            aria-label="Chemin du fichier sur la machine"
            onChange={(e) => setSaveAs(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSaveAs(null)}
          />
          <button type="submit" className="btn btn-sm btn-primary">
            Enregistrer
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSaveAs(null)}>
            Annuler
          </button>
        </form>
      )}
      <div className="term-body code-body">
        <div ref={hostRef} className="code-host" />
        {!ready && <div className="term-veil">{error ?? "Connexion au document…"}</div>}
        {ready && error && <div className="term-veil bottom">{error}</div>}
      </div>
    </div>
  );
}
