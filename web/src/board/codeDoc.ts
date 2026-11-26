// Shared code documents: schema, language detection and dirty state. Pure (no DOM, no Monaco),
// so the same rules are tested in Node and used by the editor window.
//
// A code document is a Y.Doc with
//   Y.Text "content"
//   Y.Map  "meta": { path?, name, language, savedSha?, savedAt?, savedBy? }
// `path` is absolute on the machine, or relative to the shell's working directory (as `ls` returns it).
import * as Y from "yjs";

export type CodeMeta = {
  path?: string;
  name: string;
  language: string;
  /** SHA-256 (hex) of the content as last read from / written to the machine. */
  savedSha?: string;
  savedAt?: number;
  savedBy?: string;
};

export const MAX_CODE_BYTES = 2 * 1024 * 1024;

export type Language = { id: string; label: string };
/** Languages offered in the header (Monaco ids). */
export const LANGUAGES: Language[] = [
  { id: "plaintext", label: "Texte brut" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "json", label: "JSON" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "java", label: "Java" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "shell", label: "Shell" },
  { id: "yaml", label: "YAML" },
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "sql", label: "SQL" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "ini", label: "INI / cfg" },
  { id: "xml", label: "XML" },
];

const BY_EXT: Record<string, string> = {
  py: "python",
  pyw: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  json: "json",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  java: "java",
  go: "go",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  sql: "sql",
  ini: "ini",
  conf: "ini",
  xml: "xml",
  // Network device configurations (Cisco-like) have no grammar: plain text is the honest choice.
  cfg: "plaintext",
  txt: "plaintext",
};

/** The Monaco language of a file name ("plaintext" when unknown). */
export function languageForName(name: string): string {
  const base = name.split("/").pop()!.toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "dockerfile";
  if (base === "makefile") return "plaintext";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base === ".bashrc" || base === ".profile" ? "shell" : "plaintext";
  return BY_EXT[base.slice(dot + 1)] ?? "plaintext";
}

export const isLanguage = (id: unknown): id is string => typeof id === "string" && LANGUAGES.some((l) => l.id === id);

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (text: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
/** SHA-256 of the empty string: what a document that was never saved is compared to. */
export const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A document is dirty when its content differs from what the machine last had (or from empty if never saved). */
export const isDirty = (contentSha: string, savedSha: string | undefined): boolean => contentSha !== (savedSha ?? EMPTY_SHA);

/** Splits "a/b/c.py" into its folder ("a/b", "" for none, "/" for the root) and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { dir: "", name: path };
  return { dir: i === 0 ? "/" : path.slice(0, i), name: path.slice(i + 1) };
}

export const joinPath = (dir: string, name: string) => (!dir ? name : `${dir.replace(/\/+$/, "")}/${name}`);

/** Single-quotes a word for POSIX shells. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command line that runs a file, or null for languages we do not run. */
export function runCommand(path: string, language: string): string | null {
  const prog = language === "python" ? "python3" : language === "shell" ? "bash" : language === "javascript" ? "node" : null;
  if (!prog) return null;
  // Unquoted when harmless, so the line reads naturally in the terminal.
  const arg = /^[A-Za-z0-9_./@%+=:,-]+$/.test(path) && !path.startsWith("-") ? path : shQuote(path.startsWith("-") ? `./${path}` : path);
  return `${prog} ${arg}`;
}

/** Document metadata as stored in the shared map (any editor can write it: read it defensively). */
export function readMeta(meta: { get(k: string): unknown }): CodeMeta {
  const s = (v: unknown) => (typeof v === "string" && v.length <= 4096 ? v : undefined);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const sha = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : undefined);
  const name = s(meta.get("name")) || "sans-titre";
  const language = meta.get("language");
  return {
    ...(s(meta.get("path")) ? { path: s(meta.get("path")) } : {}),
    name,
    language: isLanguage(language) ? language : languageForName(name),
    ...(sha(meta.get("savedSha")) ? { savedSha: sha(meta.get("savedSha")) } : {}),
    ...(n(meta.get("savedAt")) !== undefined ? { savedAt: n(meta.get("savedAt")) } : {}),
    ...(s(meta.get("savedBy")) ? { savedBy: s(meta.get("savedBy")) } : {}),
  };
}

export type FileInit = { path?: string; name: string; text: string; sha: string; by?: string };

/**
 * Fills a freshly opened document with a file read from a machine, in ONE transaction setting
 * meta and content. Only when the document is empty (never initialised): two people opening the
 * same new window, or a late join, can't duplicate the text. Call it once the doc is synced.
 * Returns whether it wrote.
 */
export function initFromFile(ydoc: Y.Doc, init: FileInit): boolean {
  const content = ydoc.getText("content");
  const meta = ydoc.getMap("meta");
  if (content.length > 0 || meta.has("name")) return false;
  ydoc.transact(() => {
    if (init.path) meta.set("path", init.path);
    meta.set("name", init.name);
    meta.set("language", languageForName(init.name));
    meta.set("savedSha", init.sha);
    meta.set("savedAt", Date.now());
    if (init.by) meta.set("savedBy", init.by);
    if (init.text) content.insert(0, init.text);
  });
  return true;
}

/** A blank document: a name, nothing saved yet. Same emptiness rule as initFromFile. */
export function initBlank(ydoc: Y.Doc, name = "sans-titre.txt"): boolean {
  const meta = ydoc.getMap("meta");
  if (ydoc.getText("content").length > 0 || meta.has("name")) return false;
  ydoc.transact(() => {
    meta.set("name", name);
    meta.set("language", languageForName(name));
  });
  return true;
}

/** Records a successful write to the machine (and the path it landed on). */
export function markSaved(ydoc: Y.Doc, o: { path: string; sha: string; by?: string }) {
  const meta = ydoc.getMap("meta");
  ydoc.transact(() => {
    const name = splitPath(o.path).name;
    if (meta.get("path") !== o.path) meta.set("path", o.path);
    if (meta.get("name") !== name) {
      meta.set("name", name);
      meta.set("language", languageForName(name));
    }
    meta.set("savedSha", o.sha);
    meta.set("savedAt", Date.now());
    if (o.by) meta.set("savedBy", o.by);
  });
}

/** Documents about to be filled by a window that mounts a moment later (see initFromFile). */
const pendingInit = new Map<string, FileInit | "blank">();
export const queueInit = (docId: string, init: FileInit | "blank") => void pendingInit.set(docId, init);
export function takeInit(docId: string): FileInit | "blank" | undefined {
  const v = pendingInit.get(docId);
  pendingInit.delete(docId);
  return v;
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|(?:hsl|rgb)a?\([0-9.,%\s/a-z-]{1,40}\))$/i;
/** Peers' names and colours come from awareness (any member can write them): never trust them in CSS. */
export const safeColor = (c: unknown): string => (typeof c === "string" && COLOR_RE.test(c) ? c : "#6366f1");
export const safeLabel = (n: unknown): string => (typeof n === "string" ? n.replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, 24) : "") || "Anonyme";

/**
 * CSS for y-monaco's remote cursors (`yRemoteSelection-<clientId>` for the selection,
 * `yRemoteSelectionHead-<clientId>` for the caret), one rule set per peer, in the peer's colour with its name above the caret.
 */
export function cursorStyleSheet(peers: { clientId: number; name: unknown; color: unknown }[]): string {
  return peers
    .filter((p) => Number.isSafeInteger(p.clientId) && p.clientId >= 0)
    .map((p) => {
      const color = safeColor(p.color);
      const name = safeLabel(p.name);
      const id = p.clientId;
      return [
        `.yRemoteSelection-${id}{background-color:color-mix(in srgb,${color} 30%,transparent)}`,
        `.yRemoteSelectionHead-${id}{position:absolute;box-sizing:border-box;height:100%;border-left:2px solid ${color}}`,
        `.yRemoteSelectionHead-${id}::after{content:"${name}";position:absolute;top:-1.5em;left:-2px;padding:0 4px;border-radius:3px;background:${color};color:#fff;font:600 10px/1.5 system-ui,sans-serif;white-space:nowrap;pointer-events:none;z-index:5}`,
      ].join("\n");
    })
    .join("\n");
}
