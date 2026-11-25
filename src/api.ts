import { config } from "./config.js";

/**
 * Client for the mailbox.org account interface (JSON-RPC 2.0 at api.mailbox.org/v1/).
 * Uses an API key from the mailbox.org console (user profile > API access),
 * which also works with two-factor sign-in.
 */
export async function accountApi<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!config.apiKey) {
    throw new Error(
      `The mailbox.org account interface needs MAILBOX_API_KEY, which only business accounts get (manage.mailbox.org > API access); personal accounts have none. Do this in the browser instead: manage.mailbox.org (Email Aliases, Disposable addresses, Settings spamprotection, Block unwanted email, Email recovery) or app.mailbox.org All settings.`,
    );
  }
  let res: Response;
  try {
    res = await fetch(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": config.apiKey },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`mailbox.org account interface did not answer (${(e as Error).message}). Try again shortly.`);
  }
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (body.error) {
    const hints: Record<number, string> = {
      493: "The API key was refused; check MAILBOX_API_KEY or create a new key.",
      488: "Two-factor sign-in is on, so password login is disabled; use an API key.",
      2: "Access denied for this method with this key.",
    };
    throw new Error(`mailbox.org ${method} failed: ${body.error.message} (code ${body.error.code}). ${hints[body.error.code] ?? ""}${body.error.data ? ` Details: ${JSON.stringify(body.error.data)}` : ""}`.trim());
  }
  if (!res.ok) throw new Error(`mailbox.org account interface returned HTTP ${res.status}.`);
  return body.result as T;
}

export interface MailAccount {
  mail?: string;
  aliases?: (string | { mail?: string; alias?: string; [k: string]: unknown })[];
  forwards?: string[];
  type?: string;
  plan?: string;
  [k: string]: unknown;
}

export const getAccount = (extra: Record<string, unknown> = {}) => accountApi<MailAccount>("mail.get", { mail: config.email, ...extra });

/** Alias addresses as plain strings; tolerates either strings or objects in the API's array. */
export function aliasAddresses(account: MailAccount): string[] {
  return (account.aliases ?? []).map((a) => (typeof a === "string" ? a : String(a.mail ?? a.alias ?? ""))).filter(Boolean);
}

export async function setAliases(aliases: string[]): Promise<void> {
  await accountApi("mail.set", { mail: config.email, aliases });
}
