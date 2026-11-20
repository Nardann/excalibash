import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.ts";

export function emailEnabled(): boolean {
  return !!config.smtp.host || config.smtp.transport === "log";
}

let transport: Transporter | null = null;

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!config.smtp.host) {
    // Log transport: development and tests read the code from the server output.
    const code = text.match(/\b\d{6}\b/)?.[0] ?? "";
    console.log(`[mail] to=${to} subject=${subject} code=${code}`);
    return;
  }
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text });
}

export function sendVerificationCode(to: string, code: string): Promise<void> {
  return sendMail(to, "Ton code Excalibash", `Ton code Excalibash : ${code} (valable 15 minutes)\n\nSi tu n'as pas créé de compte, ignore ce message.`);
}
