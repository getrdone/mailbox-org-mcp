import { config } from "./config.js";
import { aliasAddresses, getAccount } from "./api.js";
import { appendMessage, listFolders, searchUids, fetchSummaries } from "./imap.js";
import { compose } from "./smtp.js";
import { aliasStore, daysUntil, localDate, type AliasRow } from "./store.js";

/** Brings the local register in line with the aliases mailbox.org reports (when an API key is set). */
export async function syncFromServer(): Promise<{ synced: boolean; server: string[] }> {
  if (!config.apiKey) return { synced: false, server: [] };
  const server = aliasAddresses(await getAccount()).map((a) => a.toLowerCase());
  for (const address of server) {
    const row = aliasStore.get(address);
    aliasStore.upsert(address, { on_server: 1, ...(row?.status === "removed" ? { status: "active" } : {}) });
  }
  for (const row of aliasStore.all()) {
    if (!server.includes(row.address.toLowerCase()) && row.on_server) aliasStore.upsert(row.address, { on_server: 0, status: row.status === "active" ? "removed" : row.status });
  }
  return { synced: true, server };
}

/** Marks temporary aliases whose date has passed as expired. */
export function markExpired(): void {
  for (const row of aliasStore.all()) {
    if (row.kind === "temporary" && row.status === "active" && row.expires_at && daysUntil(row.expires_at) < 0) aliasStore.upsert(row.address, { status: "expired" });
  }
}

/** Counts mail addressed to an alias in the last 90 days across all folders except Trash and Junk. */
export async function refreshUsage(address: string): Promise<AliasRow> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const query = { since, or: [{ to: address }, { cc: address }, { header: { "delivered-to": address } }] };
  const folders = (await listFolders()).filter((f) => !f.flags.has("\\Noselect") && f.specialUse !== "\\Trash" && f.specialUse !== "\\Junk" && f.specialUse !== "\\Sent");
  let count = 0;
  let latest = "";
  for (const f of folders) {
    const uids = await searchUids(f.path, query);
    count += uids.length;
    if (uids.length) {
      const [newest] = await fetchSummaries(f.path, uids.slice(0, 1));
      if (newest && newest.date > latest) latest = newest.date;
    }
  }
  return aliasStore.upsert(address, { mail_count_90d: count, ...(latest ? { last_mail_at: latest.slice(0, 10) } : {}) });
}

/** Temporary aliases due a reminder: inside their reminder window, at 1 day left, or just expired; at most one note per alias per 3 days, plus the last-day note. */
export function dueReminders(): AliasRow[] {
  markExpired();
  const today = localDate();
  return aliasStore.all().filter((r) => {
    if (r.kind !== "temporary" || !r.expires_at || r.status === "removed") return false;
    const left = daysUntil(r.expires_at);
    if (left > r.remind_days || left < -7) return false;
    if (r.status === "expired" && r.last_reminded && r.last_reminded >= r.expires_at) return false; // one note after expiry
    if (!r.last_reminded) return true;
    if (r.last_reminded === today) return false;
    const sinceLast = -daysUntil(r.last_reminded);
    return sinceLast >= 3 || left <= 1;
  });
}

export function describeAlias(r: AliasRow): string {
  const left = r.expires_at ? daysUntil(r.expires_at) : undefined;
  const when = r.kind !== "temporary" ? "permanent" : left === undefined ? "temporary, no expiry date recorded" : left < 0 ? `EXPIRED ${-left} day(s) ago (${r.expires_at})` : left === 0 ? `expires TODAY (${r.expires_at})` : `expires in ${left} day(s) (${r.expires_at})`;
  const use = r.mail_count_90d !== null ? ` · ${r.mail_count_90d} mails in 90 days${r.last_mail_at ? `, last ${r.last_mail_at}` : ""}` : "";
  return `**${r.address}** — ${when}${r.purpose ? ` · for: ${r.purpose}` : ""}${use}${r.status !== "active" ? ` · ${r.status}` : ""}${r.on_server ? "" : " · not on server"}`;
}

/** Puts one reminder note in the inbox (flagged, unread). It is stored, not sent. */
export async function deliverReminder(rows: AliasRow[]): Promise<number | undefined> {
  // Usage counts are shown when already known (mailbox_list_aliases check_usage); counting here would take minutes.
  const fresh = rows.map((r) => aliasStore.get(r.address)!);
  const lines = fresh.map((r) => `- ${describeAlias(r).replace(/\*\*/g, "")}`);
  const body = [
    "These temporary mailbox.org aliases are close to expiring (or have just expired):",
    "",
    ...lines,
    "",
    "What would you like to do with each one?",
    "- Extend it: ask Claude \"extend <address>\". For a disposable address (@temp.mailbox.org) Claude clicks Extend in mailbox.org (All settings > Email addresses > Disposable addresses, +90 days) and records the new date; otherwise it only updates the register.",
    "- Let it expire: do nothing; mailbox.org deletes disposable addresses on their expiry date. Or ask Claude to delete it now.",
    "- Keep it for good: ask Claude to create a permanent alias instead (disposable addresses cannot be made permanent and cannot send mail).",
    "",
    "This note was placed in your inbox by the mailbox-org-mcp alias reminder; it was not sent over the internet.",
  ].join("\n");
  const raw = await compose({
    from: { name: "Alias reminder", address: config.email },
    to: config.email,
    subject: `Alias reminder: ${fresh.length} temporary alias${fresh.length === 1 ? "" : "es"} expiring — extend or let expire?`,
    text: body,
    headers: { "X-Mailbox-Org-Mcp": "alias-reminder" },
  });
  const uid = await appendMessage("INBOX", raw, ["\\Flagged"]);
  const today = localDate();
  for (const r of fresh) aliasStore.upsert(r.address, { last_reminded: today });
  return uid;
}
