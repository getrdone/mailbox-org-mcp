#!/usr/bin/env node
/**
 * mailbox-org-mcp: MCP server for mailbox.org.
 * Mail (IMAP/SMTP), filters and vacation (ManageSieve), aliases and account settings
 * (api.mailbox.org), contacts, tasks and calendar (CardDAV/CalDAV) and Drive (WebDAV).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { config } from "./config.js";
import { text } from "./format.js";
import { registerAccountTools } from "./tools/account.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerFilterTools } from "./tools/filters.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerMailTools } from "./tools/mail.js";
import { registerPimTools } from "./tools/pim.js";
import { registerSubscriptionTools } from "./tools/subscriptions.js";
import { registerPgpTools } from "./tools/pgp-tools.js";
import { registerSettingsTools } from "./tools/settings.js";
import { checkConnections } from "./doctor.js";

const INSTRUCTIONS = `mailbox.org account ${config.email}. Messages are addressed by folder + uid (from mailbox_search_messages).
Search uses Gmail syntax (from:, to:, subject:, is:unread, has:attachment, newer_than:7d, larger:5M, label:, color:, in:folder, OR, -negation).
Bulk tools take uids or a query, have a max cap and dry_run. Prefer drafts (mode "draft") for replies unless the user asked to send.
PGP: encrypt/sign on send, reply, forward and drafts; mailbox_get_message decrypts and verifies; keys via mailbox_pgp_keys.
Filters are server-side Sieve rules; aliases and temporary-alias expiry live in mailbox_list_aliases / mailbox_alias_reminders.
Contacts/tasks/calendar and Drive need their own app passwords. Personal accounts have no API key: account settings (aliases, disposable addresses, spam, blocklist, recovery...) are changed in the browser; mailbox_account_settings gives each page address and steps, then record them with mailbox_add_alias / mailbox_update_alias. mailbox_check_connection shows which parts work.`;

function createServer(): McpServer {
  const server = new McpServer({ name: "mailbox-org-mcp", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  registerMailTools(server);
  registerFolderTools(server);
  registerFilterTools(server);
  registerSubscriptionTools(server);
  registerAccountTools(server);
  registerPimTools(server);
  registerDriveTools(server);
  registerPgpTools(server);
  registerSettingsTools(server);
  server.registerTool(
    "mailbox_check_connection",
    {
      title: "Check connection",
      description: "Check which mailbox.org services work with the configured credentials (mail, sending, filters, contacts/calendar/drive, account interface) and what to set up for the rest. Sends no mail.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => text(await checkConnections()),
  );
  return server;
}

serveStdio(createServer);
console.error("mailbox-org-mcp running on stdio");
