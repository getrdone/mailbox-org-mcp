import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reads KEY=value lines into process.env without overriding values already set. */
function loadSecretsFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 1) continue;
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

/** KEY=value file with credentials; override with MAILBOX_SECRETS_FILE. Environment variables always win. */
const secretsFile = process.env.MAILBOX_SECRETS_FILE ?? join(homedir(), ".mailbox-org-mcp", ".env");
loadSecretsFile(secretsFile);

const env = process.env;
const num = (value: string | undefined, fallback: number) => (value ? Number(value) : fallback);

export const config = {
  secretsFile,
  email: env.MAILBOX_EMAIL ?? "",
  /** App password with IMAP and SMTP rights. */
  password: env.MAILBOX_PASSWORD ?? "",
  /** Optional app password with CalDAV/CardDAV/WebDAV rights; falls back to MAILBOX_PASSWORD. */
  davPassword: env.MAILBOX_DAV_PASSWORD || env.MAILBOX_PASSWORD || "",
  /** Optional app password of type "WebDAV Client" for Drive; falls back to MAILBOX_DAV_PASSWORD. */
  drivePassword: env.MAILBOX_DRIVE_PASSWORD || env.MAILBOX_DAV_PASSWORD || env.MAILBOX_PASSWORD || "",
  /** Optional key from the mailbox.org console (user profile > API access). Needed for aliases and account settings. */
  apiKey: env.MAILBOX_API_KEY ?? "",
  fromName: env.MAILBOX_FROM_NAME ?? "",
  defaultFrom: env.MAILBOX_FROM || env.MAILBOX_EMAIL || "",
  imap: { host: env.MAILBOX_IMAP_HOST ?? "imap.mailbox.org", port: num(env.MAILBOX_IMAP_PORT, 993) },
  smtp: { host: env.MAILBOX_SMTP_HOST ?? "smtp.mailbox.org", port: num(env.MAILBOX_SMTP_PORT, 465) },
  sieve: { host: env.MAILBOX_SIEVE_HOST ?? "imap.mailbox.org", port: num(env.MAILBOX_SIEVE_PORT, 4190) },
  davBase: env.MAILBOX_DAV_URL ?? "https://dav.mailbox.org",
  apiUrl: env.MAILBOX_API_URL ?? "https://api.mailbox.org/v1/",
  /** Folder where downloaded attachments go when no path is given. */
  downloadDir: env.MAILBOX_DOWNLOAD_DIR ?? "",
};

export function requireMailCredentials(): void {
  if (!config.email || !config.password) {
    throw new Error(
      `mailbox.org credentials are missing. Set MAILBOX_EMAIL and MAILBOX_PASSWORD (an app password with IMAP and SMTP rights) in the environment or in ${secretsFile}.`,
    );
  }
}
