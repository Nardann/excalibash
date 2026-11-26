// Output items as DOM, shared by the notebook window and the code window (the output of a run).
//
// Outputs are DATA written by whatever code anybody ran: text becomes text nodes, images <img data:>
// after a base64 check, everything else (HTML, SVG, Markdown, JavaScript) a sandboxed iframe
// (sandbox="", no script, no same-origin). Nothing here uses innerHTML or runs provided code.
import { parseAnsi, type RenderItem } from "./notebookRender.ts";

export function AnsiText({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((s, i) =>
        s.fg || s.bg || s.bold || s.dim || s.italic || s.underline ? (
          <span key={i} style={{ color: s.fg, background: s.bg, fontWeight: s.bold ? 700 : undefined, opacity: s.dim ? 0.7 : undefined, fontStyle: s.italic ? "italic" : undefined, textDecoration: s.underline ? "underline" : undefined }}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

/** Output items as DOM: text nodes, data: images and sandboxed frames. Never innerHTML. */
export function Outputs({ items }: { items: RenderItem[] }) {
  return (
    <>
      {items.map((it, i) => {
        switch (it.kind) {
          case "text":
            return (
              <pre key={i} className={`nb-text ${it.stream === "stderr" ? "err" : ""}`}>
                <AnsiText text={it.text} />
              </pre>
            );
          case "error":
            return (
              <pre key={i} className="nb-text nb-error">
                <b>{it.ename}</b>
                {it.evalue ? `: ${it.evalue}` : ""}
                {it.traceback ? `\n${it.traceback}` : ""}
              </pre>
            );
          case "image":
            return <img key={i} className="nb-img" src={it.src} alt="Sortie du notebook" />;
          case "frame":
            // sandbox="" : no script, no same-origin, no forms, no popups, no top navigation.
            return <iframe key={i} className="nb-frame" sandbox="" srcDoc={it.srcdoc} title={it.label} style={{ height: it.height }} referrerPolicy="no-referrer" loading="lazy" />;
          case "note":
            return (
              <div key={i} className="nb-note">
                {it.text}
              </div>
            );
        }
      })}
    </>
  );
}

