import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { renderMail, type MailBody } from "./mailTemplate.ts";

export function emailEnabled(): boolean {
  return !!config.smtp.host || config.smtp.transport === "log";
}

/** New accounts confirm their email with a code: on by default, admins may turn it off. */
export function verificationRequired(): boolean {
  return emailEnabled() && getSetting("email_verification", "true") === "true";
}

let transport: Transporter | null = null;

function smtpTransport(): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transport;
}

/** Outcome of the last email the server tried to send, shown to admins. */
export type MailOutcome = { at: number; ok: boolean; error?: string };

function record(outcome: MailOutcome) {
  setSetting(outcome.ok ? "mail_last_ok" : "mail_last_error", JSON.stringify(outcome));
}

function readOutcome(key: string): MailOutcome | null {
  try {
    return JSON.parse(getSetting(key, "null"));
  } catch {
    return null;
  }
}

export async function sendMail(to: string, subject: string, body: MailBody): Promise<void> {
  const { text, html } = renderMail(body);
  if (!config.smtp.host) {
    // Log transport: development and tests read the code from the server output.
    const code = text.match(/\b\d{6}\b/)?.[0] ?? "";
    console.log(`[mail] to=${to} subject=${subject} code=${code}`);
    return;
  }
  try {
    await smtpTransport().sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
    record({ at: Date.now(), ok: true });
  } catch (e) {
    record({ at: Date.now(), ok: false, error: (e as Error).message.slice(0, 300) });
    throw e;
  }
}

export function sendVerificationCode(to: string, code: string): Promise<void> {
  return sendMail(to, "Ton code Excalibash", {
    title: "Confirme ton adresse email",
    lines: ["Voici ton code pour activer ton compte Excalibash. Il est valable **15 minutes**."],
    code,
    note: "Si tu n'as pas créé de compte, ignore ce message : sans ce code, le compte ne sera jamais activé.",
  });
}

/** What admins see of the email setup: never the password. */
export function smtpStatus() {
  const mode = config.smtp.host ? "smtp" : config.smtp.transport === "log" ? "log" : "off";
  return {
    mode,
    host: config.smtp.host || null,
    port: config.smtp.host ? config.smtp.port : null,
    secure: config.smtp.secure,
    user: config.smtp.user || null,
    from: config.smtp.from || config.smtp.user || null,
    lastOk: readOutcome("mail_last_ok"),
    lastError: readOutcome("mail_last_error"),
  };
}

/** Checks the connection to the SMTP server, then sends a test email to `to`. */
export async function sendTestMail(to: string): Promise<void> {
  if (config.smtp.host) {
    try {
      await smtpTransport().verify();
    } catch (e) {
      record({ at: Date.now(), ok: false, error: (e as Error).message.slice(0, 300) });
      throw e;
    }
  }
  await sendMail(to, "Test d'envoi Excalibash", {
    title: "L'envoi d'emails fonctionne",
    lines: [
      "Cet email de test a été envoyé depuis la page d'administration d'Excalibash.",
      "S'il est bien arrivé dans ta boîte de réception, les codes de vérification et les notifications arriveront aussi.",
    ],
    note: `Envoyé le ${new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" })}.`,
  });
}
