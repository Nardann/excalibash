// Python completion and docstrings in Monaco, answered by a Jupyter kernel session (kernelSession.ts).
//
// The providers are registered once for the "python" language; each editor model says which kernel
// answers for it (`bindPythonKernel`). Completion is triggered by "." and Ctrl+Espace only (no request per
// keystroke), Tab accepts. Requests are debounced, cancelled when Monaco cancels them, answered within 3 s
// at the latest, and never block typing: everything is asynchronous and a missing answer is just no list.
// Docstrings (the kernel's `inspect`) show in the hover and on Maj+Tab as plain text in a code block.
import { monaco } from "./monacoEnv.ts";
import type * as Monaco from "monaco-editor";
import { wordAt, type CompleteReply } from "./pyComplete.ts";

type Signal = { aborted: boolean; addEventListener(t: "abort", f: () => void, o?: { once: boolean }): void };

/** What an editor needs from a kernel session (KernelSession implements it). */
export type KernelQuery = {
  readonly canQuery: boolean;
  complete(code: string, pos: number, o?: { signal?: Signal }): Promise<CompleteReply | null>;
  inspect(code: string, pos: number, o?: { signal?: Signal }): Promise<string | null>;
};

const models = new WeakMap<Monaco.editor.ITextModel, () => KernelQuery | null | undefined>();
const DEBOUNCE_MS = 80;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let registered = false;
const withCommand = new WeakSet<Monaco.editor.IStandaloneCodeEditor>();

/** Editor options for a Python editor that completes from a kernel: on demand only, Tab accepts. */
export const kernelEditorOptions = {
  quickSuggestions: false,
  suggestOnTriggerCharacters: true,
  wordBasedSuggestions: "off",
  tabCompletion: "on",
  acceptSuggestionOnEnter: "off",
  parameterHints: { enabled: false },
} as const satisfies Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions;

function abortOnCancel(token: Monaco.CancellationToken): { signal: Signal; dispose(): void } {
  const ac = new AbortController();
  const sub = token.onCancellationRequested(() => ac.abort());
  return { signal: ac.signal, dispose: () => sub.dispose() };
}

function ensureProviders() {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position, context, token) {
      const none = { suggestions: [] };
      const kernel = models.get(model)?.();
      if (!kernel?.canQuery) return none;
      // Typing a "." right after another request: wait a beat so that only the last one goes out.
      if (context.triggerKind !== monaco.languages.CompletionTriggerKind.Invoke) await sleep(DEBOUNCE_MS);
      if (token.isCancellationRequested) return none;
      const code = model.getValue();
      const pos = model.getOffsetAt(position);
      const c = abortOnCancel(token);
      try {
        const reply = await kernel.complete(code, pos, { signal: c.signal });
        // The text moved on while the kernel was thinking: the answer would apply to something else.
        if (!reply || token.isCancellationRequested || model.getValue() !== code) return none;
        const range = monaco.Range.fromPositions(model.getPositionAt(reply.start), model.getPositionAt(reply.end));
        return {
          suggestions: reply.matches.map((label, i) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Variable,
            insertText: label,
            filterText: label,
            sortText: String(i).padStart(4, "0"),
            range,
          })),
        };
      } finally {
        c.dispose();
      }
    },
  });
  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position, token) {
      const kernel = models.get(model)?.();
      if (!kernel?.canQuery) return null;
      const code = model.getValue();
      const word = wordAt(code, model.getOffsetAt(position));
      if (!word) return null;
      await sleep(DEBOUNCE_MS);
      if (token.isCancellationRequested) return null;
      const c = abortOnCancel(token);
      try {
        const md = await kernel.inspect(code, word.end, { signal: c.signal });
        if (!md || token.isCancellationRequested || model.getValue() !== code) return null;
        const range = monaco.Range.fromPositions(model.getPositionAt(word.start), model.getPositionAt(word.end));
        // Not trusted, no HTML: the text is data written by the kernel (docstrings of whatever was imported).
        return { range, contents: [{ value: md, isTrusted: false, supportHtml: false }] };
      } finally {
        c.dispose();
      }
    },
  });
}

/**
 * Makes `model` complete and show docstrings through the kernel `get()` returns (looked up at each request, it
 * may appear and go). Maj+Tab shows the docstring at the cursor (and still outdents at the start of a line).
 * Returns what to call when the editor goes away.
 */
export function bindPythonKernel(editor: Monaco.editor.IStandaloneCodeEditor, model: Monaco.editor.ITextModel, get: () => KernelQuery | null | undefined): () => void {
  ensureProviders();
  models.set(model, get);
  editor.updateOptions(kernelEditorOptions);
  // One command per editor, however many times it is bound: it looks the kernel up at the time of the key.
  if (!withCommand.has(editor)) {
    withCommand.add(editor);
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Tab, () => {
      const m = editor.getModel();
      const p = editor.getPosition();
      const sel = editor.getSelection();
      const before = m && p ? m.getLineContent(p.lineNumber).slice(0, p.column - 1) : "";
      const kernel = m ? models.get(m)?.() : undefined;
      if (!p || (sel && !sel.isEmpty()) || !before.trim() || !kernel?.canQuery) return void editor.trigger("keyboard", "outdent", null);
      editor.trigger("kernel", "editor.action.showHover", null);
    });
  }
  return () => {
    models.delete(model);
    try {
      // Back to Monaco's defaults (the language of a code window can change under the same editor).
      editor.updateOptions({ quickSuggestions: { other: true, comments: false, strings: false }, wordBasedSuggestions: "matchingDocuments", acceptSuggestionOnEnter: "on", parameterHints: { enabled: true } });
    } catch {
      /* the editor is already disposed */
    }
  };
}
