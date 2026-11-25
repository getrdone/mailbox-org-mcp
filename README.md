# mailbox-org-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants (Claude, Codex and other MCP clients) Gmail-style control of a [mailbox.org](https://mailbox.org) account: search, sort, label, filter, unsubscribe, aliases with expiry reminders, PGP, contacts, tasks, calendar and Drive.

> Unofficial community project. Not affiliated with or endorsed by mailbox.org (Heinlein Hosting GmbH).

It talks to mailbox.org only through standard protocols (IMAP, SMTP, ManageSieve, CalDAV, CardDAV, WebDAV) with app passwords, so your main password is never needed.

## Features (50 tools)

| Area | What you can do |
|---|---|
| **Search and read** | Gmail-style queries (`from:`, `to:`, `subject:`, `is:unread`, `is:starred`, `has:attachment`, `has:unsubscribe`, `newer_than:7d`, `older_than:1y`, `larger:5M`, `label:`, `color:`, `in:folder`, `OR`, `-negation`); counts; top senders; read messages and whole conversations; save attachments |
| **Write** | Send, reply, reply-all, forward, drafts, send drafts; send as any alias; copies saved in Sent |
| **Organize in bulk** | Read/unread, star, webmail color labels, labels/categories (IMAP keywords), move, archive, trash, spam / not spam, permanent delete. Every bulk action takes UIDs or a query, has a safety cap and a dry run |
| **Folders and storage** | List with counts and sizes, create, rename, delete, subscribe; quota used vs. plan and largest folders |
| **Filters** | Server-side Sieve rules: list, create (optionally applied to existing mail), edit, enable/disable, reorder, delete, bounce senders; out-of-office reply. Every change is validated by the server and the previous script is backed up locally |
| **Newsletters** | List subscriptions by sender, one-click unsubscribe (RFC 8058) or by email, re-subscribe, auto-file future mail from a sender |
| **Aliases** | Register of permanent aliases and disposable `@temp.mailbox.org` addresses with expiry dates; a flagged reminder note in your inbox before one expires, asking whether to extend it or let it go |
| **PGP** | PGP/MIME encrypt and sign on send/reply/forward/drafts, automatic decrypt and signature check when reading, key lookup through the recipient's Web Key Directory, import/export keys. Refuses to fall back to clear text |
| **Contacts, tasks, calendar** | Search/create/edit/delete contacts (edits keep untouched fields); list/create/complete/delete tasks; list/create/delete events, including repeating ones |
| **Drive** | List, upload, download, rename, delete files (documents, spreadsheets, presentations) |
| **Notes** | Read mailbox.org shared notes |
| **Account settings map** | Every manage.mailbox.org setting (aliases, disposable addresses, spam, blocklist, encrypted sending, trash, backup recovery, POP3 fetch...) with its address, what it controls and the steps, for assistants that can drive a browser |

Not covered: Chat, Meet and Polls (no interface). Account settings on manage.mailbox.org have no API for personal accounts; business accounts can set `MAILBOX_API_KEY` to enable alias, spam, blocklist and backup tools.

## Install

Requires Node.js 20.3 or later.

```sh
git clone https://github.com/getrdone/mailbox-org-mcp.git
cd mailbox-org-mcp
npm install
npm run build
```

## Configure

1. In mailbox.org create an app password with IMAP and SMTP rights (manage.mailbox.org > Email app-passwords). For contacts/tasks/calendar and Drive, also create "Calendar and Addressbook Client (CalDAV/CardDAV)" and "WebDAV Client" passwords (app.mailbox.org > All settings > Security > Application Passwords).
2. Copy `.env.example` to `~/.mailbox-org-mcp/.env` and fill it in (or set the same variables in your MCP client's `env`).
3. Check: `node dist/cli.js doctor` shows which services work and what is missing. It sends no mail.

## Add to your MCP client

Claude Code:

```sh
claude mcp add mailbox-org -- node /path/to/mailbox-org-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`) and most other clients:

```json
{
  "mcpServers": {
    "mailbox-org": {
      "command": "node",
      "args": ["/path/to/mailbox-org-mcp/dist/index.js"],
      "env": { "MAILBOX_SECRETS_FILE": "/path/to/your/.env" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.mailbox_org]
command = "node"
args = ["/path/to/mailbox-org-mcp/dist/index.js"]
```

## Alias expiry reminders

mailbox.org disposable addresses are receive-only, live 90 days and are deleted unless extended. The server keeps a local register (`var/mailbox-org-mcp.sqlite`) of aliases you record, and `node dist/cli.js alias-reminders` (or the `mailbox_alias_reminders` tool) puts one flagged note in your inbox when any are close to expiry. Run it daily from Task Scheduler or cron. The note is stored with IMAP, never sent.

## Safety

- Replies and forwards default to drafts; permanent deletion needs `confirm: true`.
- Bulk tools cap how many messages a query may touch and support `dry_run`.
- Filter changes are validated by the server first; the last 10 scripts are kept in `var/sieve-backups/`.
- Encryption never silently falls back to clear text; replies to encrypted mail are encrypted.
- Keyserver lookups (which reveal recipient addresses to keys.openpgp.org) are off unless you enable them.
- Credentials stay in your local `.env` or client config; `var/` and `.env` are git-ignored.

## Development

```sh
npm run build                      # compile
node scripts/test.mjs              # offline tests (query parser, Sieve editor, vCard)
node scripts/test.mjs --live       # also validates your real filter script with the server (saves nothing)
node scripts/smoke.mjs TOOL '{"arg":1}'   # call tools through a real MCP client
```

## License

MIT
