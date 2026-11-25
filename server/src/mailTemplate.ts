/**
 * Email layout: one HTML version (inline styles and tables, for mail clients) and a plain-text
 * version built from the same content. Every value is escaped; `**word**` makes it bold.
 */
export type MailLink = { label: string; url: string };
export type MailBody = {
  title: string;
  lines: string[];
  /** Verification code, shown large. */
  code?: string;
  button?: MailLink;
  /** Small grey text under the content (advice, why this email). */
  note?: string;
  footer?: { text: string; link?: MailLink };
};

const C = {
  bg: "#f8fafc",
  surface: "#ffffff",
  ink: "#1e293b",
  text: "#0f172a",
  text2: "#475569",
  muted: "#94a3b8",
  brand: "#4f46e5",
  brandSoft: "#eef2ff",
  brandText: "#312e81",
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.text}">$1</strong>`);
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1");

function button(b: MailLink): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px">
  <tr><td style="border-radius:10px;background:${C.brand};border:2px solid ${C.ink}">
    <a href="${esc(b.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(b.label)}</a>
  </td></tr>
</table>`;
}

export function renderMail(m: MailBody): { text: string; html: string } {
  const text = [
    plain(m.title),
    "",
    ...m.lines.map(plain).flatMap((l) => [l, ""]),
    ...(m.code ? [m.code, ""] : []),
    ...(m.button ? [`${m.button.label} : ${m.button.url}`, ""] : []),
    ...(m.note ? [plain(m.note), ""] : []),
    ...(m.footer ? ["—", m.footer.text + (m.footer.link ? ` ${m.footer.link.label} : ${m.footer.link.url}` : "")] : []),
  ]
    .join("\n")
    .trim();

  const p = (s: string) => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text2}">${rich(s)}</p>`;
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(plain(m.title))}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(plain(m.lines[0] ?? m.title))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
      <tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:18px;font-weight:700;color:${C.ink};letter-spacing:-0.2px">
        <span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border:2px solid ${C.ink};border-radius:6px;background:${C.brandSoft};color:${C.brand};font-family:${MONO};font-size:12px;vertical-align:-3px;margin-right:8px">&gt;_</span>Excalibash
      </td></tr>
      <tr><td style="background:${C.surface};border:2px solid ${C.ink};border-radius:14px;box-shadow:3px 3px 0 0 ${C.ink};padding:28px 28px 22px">
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:700;color:${C.text}">${rich(m.title)}</h1>
        ${m.lines.map(p).join("\n        ")}
        ${
          m.code
            ? `<div style="margin:6px 0 18px;padding:16px;text-align:center;background:${C.brandSoft};border:2px dashed ${C.brand};border-radius:10px;font-family:${MONO};font-size:32px;font-weight:700;letter-spacing:8px;color:${C.brandText}">${esc(m.code)}</div>`
            : ""
        }
        ${m.button ? button(m.button) : ""}
        ${m.note ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted}">${rich(m.note)}</p>` : ""}
      </td></tr>
      ${
        m.footer
          ? `<tr><td style="padding:16px 6px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${C.muted}">${esc(m.footer.text)}${
              m.footer.link ? ` <a href="${esc(m.footer.link.url)}" style="color:${C.brand};text-decoration:underline">${esc(m.footer.link.label)}</a>` : ""
            }</td></tr>`
          : ""
      }
    </table>
  </td></tr>
</table>
</body>
</html>`;
  return { text, html };
}
