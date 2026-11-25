import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import { config, requireMailCredentials } from "./config.js";
import { appendMessage, specialFolder } from "./imap.js";

let transport: Transporter | null = null;

function smtp(): Transporter {
  requireMailCredentials();
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.email, pass: config.password },
    pool: true,
    maxConnections: 2,
  });
  return transport;
}

export const defaultFrom = () => (config.fromName ? { name: config.fromName, address: config.defaultFrom } : config.defaultFrom);

/** Builds the raw RFC 822 message so the exact bytes sent are also saved to Sent or Drafts. */
export async function compose(options: Mail.Options): Promise<Buffer> {
  const mail = new MailComposer({ from: defaultFrom(), ...options });
  return mail.compile().build();
}

/** Sends a composed message and stores a copy in Sent. */
export async function sendRaw(raw: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId: string; accepted: string[]; rejected: string[]; sentUid?: number }> {
  if (!envelope.to.length) throw new Error("No recipients. Give at least one address in to, cc or bcc.");
  const info = await smtp().sendMail({ envelope, raw });
  const sentUid = await appendMessage(await specialFolder("\\Sent"), raw, ["\\Seen"]).catch(() => undefined);
  return {
    messageId: info.messageId,
    accepted: (info.accepted as (string | { address: string })[]).map((a) => (typeof a === "string" ? a : a.address)),
    rejected: (info.rejected as (string | { address: string })[]).map((a) => (typeof a === "string" ? a : a.address)),
    sentUid,
  };
}

const emailOf = (a: string | Mail.Address): string => (typeof a === "string" ? (/<([^>]+)>/.exec(a)?.[1] ?? a).trim() : a.address ?? "");
const list = (v: Mail.Options["to"]): string[] => (!v ? [] : Array.isArray(v) ? v : String(v).split(",")).map((a) => emailOf(a as string | Mail.Address)).filter(Boolean);

export interface Protection { encrypt?: boolean; sign?: boolean; keyserver?: boolean }

/** Composes, then signs/encrypts with PGP/MIME when asked. */
export async function composeProtected(options: Mail.Options, p: Protection = {}): Promise<{ raw: Buffer; note: string; from: string; to: string[] }> {
  const from = emailOf((options.from as string | Mail.Address | undefined) ?? config.defaultFrom);
  const to = [...list(options.to), ...list(options.cc), ...list(options.bcc)];
  const raw = await compose(options);
  if (!p.encrypt && !p.sign) return { raw, note: "", from, to };
  const { protect } = await import("./pgp.js");
  const out = await protect(raw, { encrypt: Boolean(p.encrypt), sign: Boolean(p.sign), recipients: to, sender: from, keyserver: p.keyserver });
  return { ...out, from, to };
}

/** Composes and sends; envelope comes from the headers (bcc included, never shown). */
export async function sendMessage(options: Mail.Options, p: Protection = {}) {
  const { raw, note, from, to } = await composeProtected(options, p);
  return { ...(await sendRaw(raw, { from, to })), protection: note };
}

export async function verifySmtp(): Promise<void> {
  await smtp().verify();
}
