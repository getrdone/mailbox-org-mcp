import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { config } from "../config.js";
import { accountApi, aliasAddresses, getAccount, setAliases } from "../api.js";
import { deliverReminder, describeAlias, dueReminders, markExpired, refreshUsage, syncFromServer } from "../aliases.js";
import { bytes, formatArg, respond, text } from "../format.js";
import { addDays, aliasStore, daysUntil, localDate } from "../store.js";

const SETTINGS_HINT = "https://manage.mailbox.org/index.php?p=account_aliases";
const DISPOSABLE_HINT = "https://manage.mailbox.org/index.php?p=account_disposable_aliases (or app.mailbox.org All settings > Email addresses > Disposable addresses; receive-only, 90-day life, up to 25). Claude can click New disposable address / Extend / Delete there in your browser, then record the result here.";
/** mailbox.org disposable addresses: receive-only, 90 days, managed only in the web settings. */
export const isDisposable = (address: string) => /@temp\.mailbox\.org$/i.test(address.trim());
const DISPOSABLE_DAYS = 90;

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "mailbox_list_aliases",
    {
      title: "List aliases",
      description: "List your email aliases: permanent and temporary, purpose, expiry and days left, and (with check_usage) how much mail each received in the last 90 days, so you can decide what to keep. Syncs with mailbox.org when MAILBOX_API_KEY is set; otherwise shows the local alias register.",
      inputSchema: z.object({
        check_usage: z.boolean().default(false).describe("Count recent mail per alias (searches all folders; slower)"),
        include_removed: z.boolean().default(false),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ check_usage, include_removed, response_format }) => {
      const sync = await syncFromServer().catch((e: Error) => ({ synced: false, server: [] as string[], error: e.message }));
      markExpired();
      let rows = aliasStore.all().filter((r) => include_removed || r.status !== "removed");
      if (check_usage) { for (const r of rows) await refreshUsage(r.address); rows = aliasStore.all().filter((r) => include_removed || r.status !== "removed"); }
      const note = "error" in sync ? `Could not read aliases from mailbox.org: ${sync.error}` : sync.synced ? "Synced with mailbox.org." : "Local register only (set MAILBOX_API_KEY to sync with mailbox.org).";
      return respond(response_format, { synced: sync.synced, aliases: rows.map((r) => ({ ...r, days_left: r.expires_at ? daysUntil(r.expires_at) : null })) }, () => [
        `## ${rows.length} aliases`,
        note,
        "",
        ...rows.map((r) => `- ${describeAlias(r)}`),
        rows.length ? "" : `_No aliases recorded yet. Add one with mailbox_add_alias, or record existing ones (${SETTINGS_HINT})._`,
      ].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_add_alias",
    {
      title: "Add an alias",
      description: `Create a new alias on mailbox.org (needs MAILBOX_API_KEY) or record one you made in the web settings, as permanent or temporary. Disposable addresses (...@temp.mailbox.org) are always temporary with a 90-day life and can only be created in the web settings; record them here after creating. For other temporary aliases give expires_in_days or expires_on, and a purpose (e.g. "signup for X shop"); you get an inbox reminder remind_days before it expires. Set create_on_server=false to only record an existing alias.`,
      inputSchema: z.object({
        address: z.string().describe("Full alias address, e.g. shop-2026@mailbox.org"),
        kind: z.enum(["permanent", "temporary"]).default("permanent"),
        purpose: z.string().default("").describe("What or who the alias is for"),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
        expires_on: z.string().optional().describe("YYYY-MM-DD"),
        remind_days: z.number().int().min(0).max(90).default(7).describe("Days before expiry to put a reminder in your inbox"),
        create_on_server: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ address, kind, purpose, expires_in_days, expires_on, remind_days, create_on_server }) => {
      if (isDisposable(address)) kind = "temporary";
      const days = expires_in_days ?? (isDisposable(address) ? DISPOSABLE_DAYS : undefined);
      const expires = kind === "temporary" ? expires_on ?? (days ? addDays(new Date(), days) : undefined) : undefined;
      if (kind === "temporary" && !expires) throw new Error("A temporary alias needs expires_in_days or expires_on so it can be tracked.");
      let serverNote = "Recorded locally only.";
      if (create_on_server && isDisposable(address)) serverNote = `Disposable addresses cannot be created through the account interface. If it does not exist yet: ${DISPOSABLE_HINT}`;
      else if (create_on_server) {
        if (!config.apiKey) serverNote = `Not created on mailbox.org (no MAILBOX_API_KEY). Create it there yourself (${SETTINGS_HINT}); it is now in the register.`;
        else {
          const current = aliasAddresses(await getAccount());
          if (!current.some((a) => a.toLowerCase() === address.toLowerCase())) await setAliases([...current, address]);
          serverNote = "Created on mailbox.org.";
        }
      }
      const row = aliasStore.upsert(address.toLowerCase(), { kind, purpose, expires_at: expires ?? null, remind_days, status: "active", on_server: !create_on_server || (config.apiKey && !isDisposable(address)) ? 1 : 0 });
      return text(`${serverNote}\n${describeAlias(row)}${kind === "temporary" ? `\nReminder goes to your inbox ${remind_days} day(s) before ${expires}.` : ""}`);
    },
  );

  server.registerTool(
    "mailbox_update_alias",
    {
      title: "Extend or change an alias",
      description: "Extend a temporary alias (extend_days or new expires_on), make it permanent or temporary, change its purpose or reminder lead time. Updates the local register. For a disposable address (...@temp.mailbox.org), extend it in the mailbox.org settings first (Disposable addresses > Extend) and pass the new expires_on it shows.",
      inputSchema: z.object({
        address: z.string(),
        extend_days: z.number().int().min(1).max(3650).optional().describe("Add days to the current expiry (or to today if already expired)"),
        expires_on: z.string().optional().describe("YYYY-MM-DD new expiry"),
        kind: z.enum(["permanent", "temporary"]).optional(),
        purpose: z.string().optional(),
        remind_days: z.number().int().min(0).max(90).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ address, extend_days, expires_on, kind, purpose, remind_days }) => {
      const row = aliasStore.get(address);
      if (!row) throw new Error(`${address} is not in the register. Add it with mailbox_add_alias (create_on_server=false if it already exists).`);
      let expires = expires_on ?? row.expires_at ?? undefined;
      if (extend_days) {
        const base = row.expires_at && daysUntil(row.expires_at) >= 0 ? row.expires_at : localDate();
        expires = addDays(base, extend_days);
      }
      const newKind = kind ?? (extend_days || expires_on ? "temporary" : row.kind);
      const updated = aliasStore.upsert(row.address, {
        kind: newKind,
        expires_at: newKind === "permanent" ? null : expires ?? null,
        purpose,
        remind_days,
        ...(newKind === "permanent" || (expires && daysUntil(expires) >= 0) ? { status: row.status === "removed" ? "removed" : "active", last_reminded: null } : {}),
      });
      const hint = isDisposable(row.address) && !expires_on ? `\nAlso extend it on mailbox.org, or it is deleted on the old date: ${DISPOSABLE_HINT}` : "";
      return text(`Updated: ${describeAlias(updated)}${hint}`);
    },
  );

  server.registerTool(
    "mailbox_remove_alias",
    {
      title: "Remove an alias",
      description: "Delete an alias from mailbox.org (needs MAILBOX_API_KEY; mail to it will bounce, and mailbox.org blocks the name for a while) and mark it removed in the register. Use this to let a temporary alias go now.",
      inputSchema: z.object({
        address: z.string(),
        confirm: z.literal(true).describe("Must be true"),
        forget_only: z.boolean().default(false).describe("Only delete the entry from the local register (for mistakes); mailbox.org is not touched"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ address, forget_only }) => {
      if (forget_only) return text(aliasStore.forget(address.toLowerCase()) ? `${address} removed from the local register.` : `${address} was not in the register.`);
      let note = `Remove it in mailbox.org yourself (${isDisposable(address) ? DISPOSABLE_HINT : SETTINGS_HINT}); marked removed locally.`;
      if (config.apiKey && !isDisposable(address)) {
        const current = aliasAddresses(await getAccount());
        const remaining = current.filter((a) => a.toLowerCase() !== address.toLowerCase());
        if (remaining.length === current.length) note = "It was not on mailbox.org; marked removed locally.";
        else { await setAliases(remaining); note = "Removed from mailbox.org."; }
      }
      aliasStore.upsert(address.toLowerCase(), { status: "removed", on_server: 0 });
      return text(`${address}: ${note}`);
    },
  );

  server.registerTool(
    "mailbox_alias_reminders",
    {
      title: "Check alias expiry reminders",
      description: "Find temporary aliases that expire soon (inside their reminder window) or just expired. deliver=true puts one flagged note in your INBOX listing them and asking whether to extend or let each expire (stored with IMAP, not sent). Safe to run daily; each alias is reminded at most every 3 days, plus on its last day and once after expiry.",
      inputSchema: z.object({ deliver: z.boolean().default(false), response_format: formatArg }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ deliver, response_format }) => {
      await syncFromServer().catch(() => undefined);
      const due = dueReminders();
      const uid = deliver && due.length ? await deliverReminder(due) : undefined;
      const upcoming = aliasStore.all().filter((r) => r.kind === "temporary" && r.status === "active" && r.expires_at);
      return respond(response_format, { due: due.map((r) => r.address), delivered_uid: uid ?? null, temporary: upcoming }, () => [
        due.length ? `## ${due.length} alias reminder(s) due` : "## No alias reminders due",
        ...due.map((r) => `- ${describeAlias(r)}`),
        uid ? `\nReminder placed in INBOX (uid ${uid}).` : due.length && !deliver ? "\nCall again with deliver=true to put a reminder note in the inbox." : "",
        upcoming.length ? "\n### All active temporary aliases" : "",
        ...upcoming.map((r) => `- ${describeAlias(r)}`),
      ].filter(Boolean).join("\n"));
    },
  );

  server.registerTool(
    "mailbox_get_account",
    {
      title: "Account details",
      description: "Show the mailbox.org account record: plan, aliases, forwarding, quota usage (mail and drive) and other settings. Needs MAILBOX_API_KEY.",
      inputSchema: z.object({ response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      const account = await getAccount({ include_quota_usage: true });
      return respond(response_format, account as Record<string, unknown>, () => [
        `## mailbox.org account ${config.email}`,
        ...Object.entries(account).map(([k, v]) => `- **${k}**: ${typeof v === "number" && /quota|usage|size/i.test(k) ? `${v} (${bytes(v)})` : typeof v === "object" ? JSON.stringify(v) : String(v)}`),
      ].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_spam_settings",
    {
      title: "Spam protection and blocked senders",
      description: "Read or change mailbox.org spam protection, and manage the blocked-sender list. action: get, set (greylist, rbl, smtp_plausibility, tag2level, killevel, route_to), list_blocked, block (address), unblock (id from list_blocked). Needs MAILBOX_API_KEY.",
      inputSchema: z.object({
        action: z.enum(["get", "set", "list_blocked", "block", "unblock"]),
        settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("For set: e.g. {\"greylist\": true, \"killevel\": 10}"),
        address: z.string().optional().describe("For block: sender address or *@domain"),
        id: z.union([z.string(), z.number()]).optional().describe("For unblock"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action, settings, address, id }) => {
      const mail = config.email;
      const call = {
        get: () => accountApi("mail.spamprotect.get", { mail }),
        set: () => accountApi("mail.spamprotect.set", { mail, ...(settings ?? {}) }),
        list_blocked: () => accountApi("mail.blacklist.list", { mail }),
        block: () => { if (!address) throw new Error("block needs address."); return accountApi("mail.blacklist.add", { mail, add_address: address }); },
        unblock: () => { if (id === undefined) throw new Error("unblock needs id from list_blocked."); return accountApi("mail.blacklist.del", { mail, id }); },
      }[action];
      return text(`${action}: ${JSON.stringify(await call(), null, 2)}`);
    },
  );

  server.registerTool(
    "mailbox_backups",
    {
      title: "Restore mail from mailbox.org backups",
      description: "mailbox.org keeps daily backups. action list shows available backup times; restore imports one back into the mailbox (optionally only a folder, via filter). Use when mail was deleted by mistake. Needs MAILBOX_API_KEY.",
      inputSchema: z.object({
        action: z.enum(["list", "restore"]),
        id: z.union([z.string(), z.number()]).optional().describe("Backup id from list"),
        time: z.union([z.string(), z.number()]).optional().describe("Backup time from list"),
        filter: z.string().optional().describe("Optional folder filter for restore"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action, id, time, filter }) => {
      const mail = config.email;
      const result = action === "list" ? await accountApi("mail.backup.list", { mail }) : await accountApi("mail.backup.import", { mail, id, time, ...(filter ? { filter } : {}) });
      return text(`${action}: ${JSON.stringify(result, null, 2)}`);
    },
  );
}
