// Pure helpers for Python completion and docstrings from a Jupyter kernel: offsets, mapping and the
// text shown in a hover. No DOM, no Monaco: tested by notebook.test.ts.
import { stripAnsi } from "./notebookRender.ts";

/**
 * Jupyter counts the cursor in Unicode code points ("cursor_pos ... in unicode characters"), Monaco and
 * JavaScript in UTF-16 units. `offset` is a UTF-16 offset into `text` (clamped, and moved off the middle of a
 * surrogate pair); the result is the number of code points before it.
 */
export function utf16ToCodePoints(text: string, offset: number): number {
  const end = Math.max(0, Math.min(text.length, Math.floor(offset)));
  let n = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        // The pair counts once, and only when it lies entirely before `end`.
        if (i + 1 < end) n++;
        i++;
        continue;
      }
    }
    n++;
  }
  return n;
}

/** The UTF-16 offset of the code point offset `cp` of `text` (clamped to the text). */
export function codePointsToUtf16(text: string, cp: number): number {
  const target = Math.max(0, Math.floor(cp));
  let i = 0;
  for (let n = 0; n < target && i < text.length; n++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff ? 2 : 1;
  }
  return i;
}

/** A kernel's answer to `complete`, in code points of the code that was sent. */
export type RawComplete = { matches?: unknown; start?: unknown; end?: unknown };
export type CompleteReply = {
  /** UTF-16 offsets into the code that was sent: what the matches replace. */
  start: number;
  end: number;
  matches: string[];
};

export const MAX_MATCHES = 200;
const MAX_MATCH_LENGTH = 300;

/** The kernel's matches as UTF-16 offsets and clean strings, or null when it has nothing to offer. */
export function mapComplete(code: string, pos: number, raw: RawComplete): CompleteReply | null {
  const list = Array.isArray(raw.matches) ? raw.matches : [];
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const m of list) {
    if (typeof m !== "string" || !m || m.length > MAX_MATCH_LENGTH || /[\r\n\0]/.test(m) || seen.has(m)) continue;
    seen.add(m);
    matches.push(m);
    if (matches.length >= MAX_MATCHES) break;
  }
  if (!matches.length) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const s = num(raw.start);
  const e = num(raw.end);
  let start = s !== undefined ? codePointsToUtf16(code, s) : pos;
  let end = e !== undefined ? codePointsToUtf16(code, e) : pos;
  // A reply that does not surround the cursor (or is upside down) would replace text far away: fall back to the cursor.
  if (start > end || start > pos || end < pos) (start = pos), (end = pos);
  return { start, end, matches };
}

/** Longest docstring shown in a hover (characters). */
export const MAX_DOC_CHARS = 8000;

/**
 * A kernel's `inspect` text/plain as Markdown for a hover: ANSI colours removed, cut to MAX_DOC_CHARS, inside a
 * fenced code block whose fence is longer than any run of backticks in the text (so nothing in it is ever
 * interpreted as Markdown, links and HTML included).
 */
export function docMarkdown(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = stripAnsi(text).replace(/\r\n?/g, "\n").replace(/\0/g, "");
  if (!t.trim()) return null;
  if (t.length > MAX_DOC_CHARS) t = t.slice(0, MAX_DOC_CHARS) + "\n…";
  t = t.replace(/\s+$/, "");
  let run = 0;
  for (const m of t.matchAll(/`+/g)) run = Math.max(run, m[0].length);
  const fence = "`".repeat(Math.max(3, run + 1));
  return `${fence}text\n${t}\n${fence}`;
}

/** Most sensible word under an offset: the start and end (UTF-16) of the identifier chain around it, or null. */
export function wordAt(code: string, offset: number): { start: number; end: number } | null {
  const isId = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);
  let s = Math.min(offset, code.length);
  let e = s;
  while (s > 0 && isId(code[s - 1]!)) s--;
  while (e < code.length && isId(code[e]!)) e++;
  return s === e ? null : { start: s, end: e };
}
