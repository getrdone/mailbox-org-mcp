import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { formatArg, respond, text } from "../format.js";

/**
 * mailbox.org account settings that live only in the web console (manage.mailbox.org,
 * session login with two-factor). Personal accounts get no API key, so the server cannot
 * change these itself: this map tells Claude where each one is and what the server can do instead.
 */
const CONSOLE = "https://manage.mailbox.org/index.php?p=";

interface Setting { key: string; name: string; page: string; controls: string; in_server: string; browser: string }

const SETTINGS: Setting[] = [
  { key: "aliases", name: "Email aliases", page: "account_aliases", controls: "Add or delete @mailbox.org aliases (25 on Standard), memo per alias, custom-domain aliases, change the main (login) address, unblock deleted aliases (deleted names are blocked about 4.5 years).", in_server: "mailbox_list_aliases / mailbox_add_alias / mailbox_update_alias record and remind; sending as any alias works (from).", browser: "Add: type the name in 'Add new alias' (+ memo), click Add. Delete: Delete beside it. Memo: edit and Save." },
  { key: "disposable", name: "Disposable addresses", page: "account_disposable_aliases", controls: "Up to 25 receive-only @temp.mailbox.org addresses, 90-day life, Extend adds time, Delete, memo.", in_server: "Register, expiry tracking and inbox reminders (mailbox_add_alias, mailbox_update_alias, mailbox_alias_reminders).", browser: "New disposable address; per address: Extend, Delete, memo + Save. Then record the address and new expiry with mailbox_add_alias / mailbox_update_alias expires_on." },
  { key: "alternative_sender", name: "Alternative sender", page: "account_aliasextern", controls: "Send as an external address (Gmail etc.) after an activation link is confirmed.", in_server: "Once activated, use it as `from` in mailbox_send_message.", browser: "Enter the address, Send activation link, click the link in that mailbox." },
  { key: "pop3_fetch", name: "Fetch external POP3 accounts", page: "account_pop3fetch", controls: "Jobs that pull mail from other accounts into INBOX every 30 minutes (password stored unencrypted at mailbox.org).", in_server: "Fetched mail is ordinary INBOX mail for every tool.", browser: "Email address > Discover server settings > fill in > save." },
  { key: "encrypted_sending", name: "Encrypted sending (transport)", page: "account_crypt", controls: "Off / On / On with expert settings: only deliver over encrypted (TLS) connections; can fail with some providers.", in_server: "Not settable. End-to-end encryption is separate: encrypt/sign on the sending tools.", browser: "Pick the radio button, Save." },
  { key: "pgp_method", name: "PGP in webmailer", page: "account_pgp_method", controls: "Webmail PGP via mailbox.org Guard (active) or Mailvelope.", in_server: "Independent PGP: mailbox_pgp_keys, encrypt/sign when sending, automatic decrypt/verify when reading.", browser: "Switching method needs a backup of the current key first." },
  { key: "spam", name: "Spam protection", page: "account_spam_settings", controls: "Greylisting, SMTP plausibility check, real-time blocklist (RBL), block executable attachments, content filter Lenient/Normal/Strict, spam action Reject or flag + move to a folder (Junk), reset to defaults.", in_server: "Junk handling per message (mailbox_move_messages to junk / not_junk) and server-side filters.", browser: "Set the radio buttons / folder, Save." },
  { key: "blocklist", name: "Block senders (blacklist)", page: "account_spam_blacklist", controls: "Reject (bounce) mail from addresses or whole domains (@example.com), for the main address and all aliases.", in_server: "Same effect per account with a filter: mailbox_create_filter actions.reject (bounce) or move_to Trash.", browser: "Type address or @domain, Block. Remove: select, Delete." },
  { key: "trash", name: "Trash auto-delete", page: "account_folder", controls: "Delete Trash messages after 30 days (Yes/No).", in_server: "Empty Trash any time: mailbox_delete_messages folder Trash, query '' (confirm).", browser: "Yes/No, Save." },
  { key: "recovery", name: "Email recovery (backups)", page: "account_recover", controls: "Restore from about 6 recent daily backups, Inbox only or all folders, into a new BACKUP-<date> folder.", in_server: "After restoring: search and move from the BACKUP folder with the normal tools, then delete it (mailbox_manage_folder).", browser: "Pick a backup date, click Inbox only or All folders. Needs free quota; can take an hour." },
  { key: "app_passwords", name: "App passwords", page: "account_mail_apppasswords", controls: "Mail app passwords (IMAP / SMTP rights). Calendar/contacts and WebDAV passwords are in app.mailbox.org All settings > Security > Application Passwords.", in_server: "Uses MAILBOX_PASSWORD (mail), MAILBOX_DAV_PASSWORD (contacts/tasks/calendar), MAILBOX_DRIVE_PASSWORD (Drive).", browser: "Memo + rights, Generate password; copy it into the secrets file yourself." },
  { key: "two_factor", name: "Two-factor authentication / password", page: "account_2fa", controls: "Login protection; app passwords keep working with 2FA.", in_server: "Not applicable (never changed by agents).", browser: "Owner only." },
  { key: "notes", name: "Shared notes", page: "account_shared_notes", controls: "Live shared notes (anyone with the link can edit); create, delete, copy link.", in_server: "mailbox_read_note reads a note by its link (text or HTML).", browser: "Create new note (name), Delete note, Copy link." },
  { key: "newsletter", name: "mailbox.org newsletters", page: "account_newsletter", controls: "News, Tech News, System Operation, Topic newsletters from mailbox.org itself.", in_server: "Unsubscribe from any newsletter with mailbox_unsubscribe; this page only covers mailbox.org's own.", browser: "Tick boxes, Save." },
  { key: "plan", name: "Plan, storage and billing", page: "account_info", controls: "Plan (Light/Standard/Premium), extra mail and cloud storage, contract term; statements and invoices on account_konto / account_invoice.", in_server: "mailbox_get_storage shows mail quota use; Drive use in mailbox_drive_list.", browser: "Owner only (payments)." },
];

export function registerSettingsTools(server: McpServer): void {
  server.registerTool(
    "mailbox_account_settings",
    {
      title: "Account settings map",
      description: "Where every mailbox.org account setting lives (aliases, disposable addresses, spam, blocklist, encrypted sending, trash auto-delete, backup recovery, POP3 fetch, alternative sender, app passwords, notes, newsletters, plan) with its console address, what it controls, what this server can do instead, and the browser steps. These pages need the owner's signed-in browser; personal accounts have no API for them.",
      inputSchema: z.object({ topic: z.string().optional().describe("Filter by word, e.g. spam, alias, disposable, trash, backup"), response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic, response_format }) => {
      const q = topic?.toLowerCase();
      const rows = SETTINGS.filter((s) => !q || `${s.key} ${s.name} ${s.controls}`.toLowerCase().includes(q)).map((s) => ({ ...s, url: `${CONSOLE}${s.page}` }));
      return respond(response_format, { settings: rows }, () => [
        `## mailbox.org account settings${q ? ` matching "${topic}"` : ""}`,
        ...rows.map((s) => `### ${s.name}\n${s.url}\n- Controls: ${s.controls}\n- In this server: ${s.in_server}\n- In the browser: ${s.browser}`),
        rows.length ? "" : "_No setting matches; call without topic for the full list._",
      ].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_read_note",
    {
      title: "Read a shared note",
      description: "Read a mailbox.org shared note (notes.mailbox.org link or note id) as plain text or HTML. Note links are listed on the console Notes page (mailbox_account_settings topic notes).",
      inputSchema: z.object({
        note: z.string().describe("Note link https://notes.mailbox.org/p/<id> or just the id"),
        format: z.enum(["txt", "html"]).default("txt"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ note, format }) => {
      const id = /\/p\/([^/?#]+)/.exec(note)?.[1] ?? note.trim();
      if (!/^[\w-]+$/.test(id)) throw new Error("That does not look like a note link or id.");
      const res = await fetch(`https://notes.mailbox.org/p/${id}/export/${format}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`notes.mailbox.org returned HTTP ${res.status} for that note.`);
      return text(await res.text());
    },
  );
}
