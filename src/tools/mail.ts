import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SearchObject } from "imapflow";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import * as z from "zod/v4";
import { config } from "../config.js";
import { clip, formatArg, respond, respondPage, shortDate, text, bytes } from "../format.js";
import {
  COLORS, appendMessage, fetchSource, fetchSummaries, inFolder, listFolders, resolveFolder, searchUids, specialFolder, type MessageSummary,
} from "../imap.js";
import { parseQuery } from "../search.js";
import { compose, composeProtected, sendMessage, sendRaw } from "../smtp.js";

const folderArg = z.string().default("INBOX").describe('Folder path, e.g. "INBOX", "Archive", "INBOX/newsletters". Names like archive, trash, junk, sent, drafts also work.');
const uidArg = z.number().int().positive().describe("Message UID from mailbox_search_messages (UIDs are per folder)");

export const QUERY_HELP =
  'Gmail-style query. Examples: from:amazon is:unread | subject:"invoice" newer_than:30d | has:attachment larger:5M | label:$purchases | color:red | is:starred -from:me | has:unsubscribe older_than:6m | (from:a OR from:b) | in:Archive. Bare words search headers and body. Empty = all messages.';

/** Folders to search: explicit list, in: terms in the query, "all" for every folder, else INBOX. */
async function searchFolders(folders: string[] | undefined, fromQuery: string[]): Promise<string[]> {
  const wanted = folders?.length ? folders : fromQuery.length ? fromQuery : ["INBOX"];
  if (wanted.some((f) => ["all", "anywhere", "*"].includes(f.toLowerCase()))) {
    return (await listFolders()).filter((f) => !f.flags.has("\\Noselect") && f.specialUse !== "\\Trash" && f.specialUse !== "\\Junk").map((f) => f.path);
  }
  return Promise.all(wanted.map(resolveFolder));
}

/** Runs a query across folders; returns all hits sorted newest first (by UID within a folder, by date across folders). */
async function runSearch(query: string, folders?: string[]) {
  const parsed = parseQuery(query ?? "");
  const targets = await searchFolders(folders, parsed.folders);
  const hits: { folder: string; uid: number }[] = [];
  for (const folder of targets) for (const uid of await searchUids(folder, parsed.query)) hits.push({ folder, uid });
  return { hits, targets };
}

async function summariesFor(hits: { folder: string; uid: number }[]): Promise<MessageSummary[]> {
  const byFolder = new Map<string, number[]>();
  for (const h of hits) byFolder.set(h.folder, [...(byFolder.get(h.folder) ?? []), h.uid]);
  const out: MessageSummary[] = [];
  for (const [folder, uids] of byFolder) out.push(...(await fetchSummaries(folder, uids)));
  return out;
}

export function renderSummary(m: MessageSummary): string {
  const marks = [m.read ? "" : "●unread", m.starred ? "★" : "", m.color ? `color:${m.color}` : "", m.attachments ? `📎${m.attachments}` : "", m.newsletter ? "newsletter" : "", ...m.labels.map((l) => `#${l}`)].filter(Boolean).join(" ");
  return `- **${clip(m.subject || "(no subject)", 110)}** — ${clip(m.from, 60)} · ${shortDate(m.date)} · ${m.folder} uid ${m.uid}${marks ? ` · ${marks}` : ""}`;
}

/** Selection shared by all bulk tools: explicit UIDs in one folder, or a query. */
export const selectionArgs = {
  folder: folderArg,
  uids: z.array(z.number().int().positive()).optional().describe("Exact message UIDs in `folder`. Give either uids or query."),
  query: z.string().optional().describe(`Select by query instead of UIDs (searches \`folder\` unless the query has in:...). ${QUERY_HELP}`),
  max: z.number().int().min(1).max(10_000).default(500).describe("Safety cap on how many messages a query may touch. The tool refuses when more match; raise it deliberately."),
  dry_run: z.boolean().default(false).describe("true = only report what would change"),
};

export async function resolveSelection(args: { folder: string; uids?: number[]; query?: string; max: number }) {
  if (args.uids?.length) return { groups: new Map([[await resolveFolder(args.folder), args.uids]]), total: args.uids.length };
  if (args.query === undefined) throw new Error("Give either uids or query to choose messages.");
  const { hits } = await runSearch(args.query, args.folder && args.folder !== "INBOX" ? [args.folder] : undefined);
  if (hits.length > args.max) throw new Error(`${hits.length} messages match, above max=${args.max}. Narrow the query or raise max deliberately.`);
  const groups = new Map<string, number[]>();
  for (const h of hits) groups.set(h.folder, [...(groups.get(h.folder) ?? []), h.uid]);
  return { groups, total: hits.length };
}

const describeGroups = (groups: Map<string, number[]>) => [...groups].map(([f, u]) => `${f}: ${u.length}`).join(", ") || "none";

function firstAddress(a: AddressObject | AddressObject[] | undefined) {
  return (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value);
}

/** Plain-text body of a parsed message; falls back to stripped HTML. */
function bodyText(m: ParsedMail): string {
  if (m.text?.trim()) return m.text;
  if (typeof m.html === "string") return m.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return "";
}

const looksProtected = (src: Buffer) => /multipart\/(encrypted|signed)|-----BEGIN PGP (MESSAGE|SIGNATURE)-----/i.test(src.subarray(0, 300_000).toString("latin1"));

/**
 * Fetches and parses a message; PGP-encrypted or signed mail is decrypted/verified
 * so body and attachments are the real content. pgp describes the result.
 */
export async function readMessage(folder: string, uid: number): Promise<{ path: string; m: ParsedMail; flags: Set<string>; pgp?: string; encrypted: boolean }> {
  const path = await resolveFolder(folder);
  const { source, flags } = await fetchSource(path, uid);
  const m = await simpleParser(source);
  if (!looksProtected(source)) return { path, m, flags, encrypted: false };
  const { unprotect } = await import("../pgp.js");
  try {
    const r = await unprotect(source, firstAddress(m.from)[0]?.address ?? "");
    if (!r) return { path, m, flags, encrypted: false };
    if (r.inner) {
      const inner = await simpleParser(r.inner);
      m.text = inner.text;
      m.html = inner.html;
      m.attachments = inner.attachments;
    } else if (r.text) {
      m.text = r.text;
      m.html = false;
      m.attachments = m.attachments.filter((a) => !/pgp|\.asc$/i.test(`${a.contentType} ${a.filename ?? ""}`));
    }
    return { path, m, flags, encrypted: r.kind === "encrypted", pgp: `${r.kind === "encrypted" ? "🔒 encrypted (decrypted here)" : "✍️ signed"} · ${r.signature}` };
  } catch (e) {
    return { path, m, flags, encrypted: true, pgp: `🔒 encrypted, not decrypted: ${(e as Error).message}` };
  }
}

const ownAddresses = () => new Set([config.email.toLowerCase(), config.defaultFrom.toLowerCase(), ...(process.env.MAILBOX_ALIASES ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean)]);

function downloadDir(): string {
  return config.downloadDir || join(homedir(), "Downloads", "mailbox-org");
}

export function registerMailTools(server: McpServer): void {
  server.registerTool(
    "mailbox_search_messages",
    {
      title: "Search messages",
      description: `Search mail with Gmail-style syntax and list matches newest first (subject, sender, date, folder, UID, read/star/color/labels, attachments, newsletter). Use the folder + UID with the other mailbox_ tools. ${QUERY_HELP}`,
      inputSchema: z.object({
        query: z.string().default("").describe(QUERY_HELP),
        folders: z.array(z.string()).optional().describe('Folders to search. Default INBOX. ["all"] searches every folder except Trash and Junk.'),
        limit: z.number().int().min(1).max(200).default(25),
        offset: z.number().int().min(0).default(0),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, folders, limit, offset, response_format }) => {
      const { hits, targets } = await runSearch(query, folders);
      let pageHits = hits;
      if (targets.length > 1) {
        // Across folders, order by date: fetch summaries for every hit up to a bound, then page.
        const bounded = hits.slice(0, 3000);
        const all = await summariesFor(bounded);
        all.sort((a, b) => b.date.localeCompare(a.date));
        return respondPage(response_format, all.slice(offset, offset + limit), { offset, total: hits.length }, "messages", renderSummary, `## ${hits.length} messages in ${targets.length} folders for \`${query || "*"}\``);
      }
      pageHits = hits.slice(offset, offset + limit);
      const messages = await summariesFor(pageHits);
      return respondPage(response_format, messages, { offset, total: hits.length }, "messages", renderSummary, `## ${hits.length} messages in ${targets[0]} for \`${query || "*"}\``);
    },
  );

  server.registerTool(
    "mailbox_count_messages",
    {
      title: "Count messages",
      description: "Count messages matching a Gmail-style query per folder, without listing them. Good for 'how many unread newsletters' or sizing a cleanup before a bulk action.",
      inputSchema: z.object({
        query: z.string().default("").describe(QUERY_HELP),
        folders: z.array(z.string()).optional().describe('Default INBOX. ["all"] = every folder except Trash and Junk.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, folders }) => {
      const { hits, targets } = await runSearch(query, folders);
      const counts = targets.map((f) => [f, hits.filter((h) => h.folder === f).length] as const).filter(([, n]) => n > 0);
      return text([`${hits.length} messages match \`${query || "*"}\``, ...counts.map(([f, n]) => `- ${f}: ${n}`)].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_get_message",
    {
      title: "Read a message",
      description: "Read one message: headers, plain-text body (HTML converted), attachment list, and unsubscribe options. Does not mark it read unless mark_read is true.",
      inputSchema: z.object({
        folder: folderArg,
        uid: uidArg,
        mark_read: z.boolean().default(false),
        include_html: z.boolean().default(false).describe("Also return the raw HTML body"),
        include_headers: z.boolean().default(false).describe("Also return every header"),
        max_body_chars: z.number().int().min(500).max(100_000).default(20_000),
        shorten_links: z.boolean().default(true).describe("Replace very long (tracking) links with <link: host>"),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ folder, uid, mark_read, include_html, include_headers, max_body_chars, shorten_links, response_format }) => {
      const { path, m, flags, pgp } = await readMessage(folder, uid);
      if (mark_read) await inFolder(path, (c) => c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }));
      // Tracking links can be hundreds of characters; keep the host so the reader knows where it goes.
      const body = shorten_links ? bodyText(m).replace(/https?:\/\/([^/\s)>\]]+)[^\s)>\]]{60,}/g, "<link: $1>") : bodyText(m);
      const data = {
        folder: path,
        uid,
        message_id: m.messageId,
        date: m.date?.toISOString(),
        from: m.from?.text,
        to: m.to ? (Array.isArray(m.to) ? m.to.map((a) => a.text).join(", ") : m.to.text) : "",
        cc: m.cc ? (Array.isArray(m.cc) ? m.cc.map((a) => a.text).join(", ") : m.cc.text) : "",
        reply_to: m.replyTo?.text,
        subject: m.subject,
        flags: [...flags],
        ...(pgp ? { pgp } : {}),
        list_unsubscribe: rawHeader(m, "list-unsubscribe"),
        attachments: m.attachments.map((a, index) => ({ index, filename: a.filename ?? "(unnamed)", content_type: a.contentType, size: a.size, inline: a.contentDisposition === "inline" })),
        body: body.length > max_body_chars ? `${body.slice(0, max_body_chars)}\n…[body truncated at ${max_body_chars} characters; raise max_body_chars]` : body,
        ...(include_html && typeof m.html === "string" ? { html: m.html.slice(0, max_body_chars) } : {}),
        ...(include_headers ? { headers: Object.fromEntries([...m.headers].map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) } : {}),
      };
      return respond(response_format, data, () => [
        `## ${data.subject ?? "(no subject)"}`,
        `**From:** ${data.from}  `,
        `**To:** ${data.to}${data.cc ? `  \n**Cc:** ${data.cc}` : ""}  `,
        `**Date:** ${shortDate(data.date)} · ${path} uid ${uid}${data.list_unsubscribe ? " · newsletter (mailbox_unsubscribe works)" : ""}`,
        pgp ? `**PGP:** ${pgp}` : "",
        data.attachments.length ? `**Attachments:** ${data.attachments.map((a) => `[${a.index}] ${a.filename} (${bytes(a.size)})`).join(", ")}` : "",
        "",
        data.body,
        include_headers ? `\n### Headers\n${Object.entries(data.headers ?? {}).map(([k, v]) => `${k}: ${clip(v, 300)}`).join("\n")}` : "",
      ].filter((l) => l !== "").join("\n"));
    },
  );

  server.registerTool(
    "mailbox_get_thread",
    {
      title: "Read a conversation",
      description: "Find every message in the same conversation as one message (by Message-ID, In-Reply-To and References) across INBOX, Sent, Archive and the message's own folder, oldest first.",
      inputSchema: z.object({ folder: folderArg, uid: uidArg, response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ folder, uid, response_format }) => {
      const path = await resolveFolder(folder);
      const m = await simpleParser((await fetchSource(path, uid)).source, { skipHtmlToText: true, skipTextToHtml: true });
      const refs = [...new Set([m.messageId, m.inReplyTo, ...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : [])].filter((x): x is string => Boolean(x)))];
      const folders = [...new Set([path, "INBOX", await specialFolder("\\Sent"), await specialFolder("\\Archive")])];
      const found = new Map<string, MessageSummary>();
      for (const f of folders) {
        for (const id of refs) {
          const query: SearchObject = { or: ["message-id", "references", "in-reply-to"].map((h) => ({ header: { [h]: id } })) };
          for (const s of await fetchSummaries(f, await searchUids(f, query))) found.set(s.message_id ?? `${f}:${s.uid}`, s);
        }
      }
      const thread = [...found.values()].sort((a, b) => a.date.localeCompare(b.date));
      return respondPage(response_format, thread, { offset: 0, total: thread.length }, "messages", renderSummary, `## Conversation: ${m.subject ?? ""} (${thread.length} messages)`);
    },
  );

  server.registerTool(
    "mailbox_download_attachments",
    {
      title: "Save attachments",
      description: `Save a message's attachments to a local folder (default ${downloadDir()}). Returns the saved file paths. Use mailbox_get_message to see attachment indexes.`,
      inputSchema: z.object({
        folder: folderArg,
        uid: uidArg,
        indexes: z.array(z.number().int().min(0)).optional().describe("Attachment indexes to save; default all"),
        save_dir: z.string().optional().describe("Local folder to save into"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, indexes, save_dir }) => {
      const { m } = await readMessage(folder, uid);
      const dir = resolve(save_dir ?? downloadDir());
      mkdirSync(dir, { recursive: true });
      const saved: string[] = [];
      m.attachments.forEach((a, i) => {
        if (indexes && !indexes.includes(i)) return;
        const name = basename((a.filename ?? `attachment-${i}`).replace(/[<>:"/\\|?*]/g, "_"));
        let target = join(dir, name);
        for (let n = 2; existsSync(target); n++) target = join(dir, name.replace(/(\.[^.]*)?$/, ` (${n})$1`));
        writeFileSync(target, a.content);
        saved.push(`${target} (${bytes(a.size)})`);
      });
      return text(saved.length ? `Saved ${saved.length} attachment(s):\n${saved.map((s) => `- ${s}`).join("\n")}` : "No matching attachments.");
    },
  );

  const protectionArgs = {
    encrypt: z.boolean().optional().describe("PGP-encrypt (PGP/MIME) for every recipient. Keys come from the local keyring or the recipient's Web Key Directory; fails rather than sending in clear if a key is missing."),
    sign: z.boolean().optional().describe("PGP-sign with your private key (needs MAILBOX_PGP_PRIVATE_KEY_FILE)"),
    keyserver: z.boolean().optional().describe("Also look up missing keys on keys.openpgp.org (shares the recipient address with that service)"),
  };
  const recipients = z.union([z.string(), z.array(z.string())]).optional();
  const composeArgs = {
    to: recipients.describe('Recipients: "a@x.org" or ["Name <a@x.org>", "b@y.org"]'),
    cc: recipients,
    bcc: recipients,
    subject: z.string().default(""),
    body: z.string().default("").describe("Plain-text body"),
    html: z.string().optional().describe("Optional HTML body (plain body is still sent as the text alternative)"),
    from: z.string().optional().describe(`Sender address, e.g. one of your aliases. Default ${config.defaultFrom || "the account address"}.`),
    reply_to: z.string().optional(),
    attachments: z.array(z.string()).optional().describe("Local file paths to attach"),
    ...protectionArgs,
  };
  const toMail = (a: { to?: string | string[]; cc?: string | string[]; bcc?: string | string[]; subject: string; body: string; html?: string; from?: string; reply_to?: string; attachments?: string[] }) => ({
    to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.body, html: a.html, replyTo: a.reply_to,
    ...(a.from ? { from: a.from } : {}),
    attachments: a.attachments?.map((p) => ({ path: resolve(p), filename: basename(p) })),
  });

  server.registerTool(
    "mailbox_send_message",
    {
      title: "Send an email",
      description: "Send a new email through mailbox.org SMTP and save a copy in Sent. Supports aliases as sender (from), cc, bcc, HTML, local file attachments, and PGP encrypt/sign. For replies use mailbox_reply so threading headers are set.",
      inputSchema: z.object(composeArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await sendMessage(toMail(args), args);
      return text(`Sent${r.protection ? ` (${r.protection})` : ""}. Message-ID ${r.messageId}. Accepted: ${r.accepted.join(", ") || "none"}${r.rejected.length ? `. Rejected: ${r.rejected.join(", ")}` : ""}. ${r.sentUid ? `Copy saved in Sent (uid ${r.sentUid}).` : "Copy could not be saved to Sent."}`);
    },
  );

  server.registerTool(
    "mailbox_create_draft",
    {
      title: "Save a draft",
      description: "Save a new message in Drafts without sending it, so it can be reviewed in webmail or sent later with mailbox_send_draft.",
      inputSchema: z.object(composeArgs),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { raw, note } = await composeProtected({ ...toMail(args), keepBcc: true } as Parameters<typeof compose>[0], args);
      const uid = await appendMessage(await specialFolder("\\Drafts"), raw, ["\\Draft", "\\Seen"]);
      return text(`Draft saved in ${await specialFolder("\\Drafts")}${uid ? ` (uid ${uid})` : ""}${note ? ` (${note})` : ""}.`);
    },
  );

  server.registerTool(
    "mailbox_send_draft",
    {
      title: "Send a draft",
      description: "Send a message that is already in Drafts (by UID), save it to Sent and remove the draft.",
      inputSchema: z.object({ uid: uidArg.describe("Draft UID in the Drafts folder") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ uid }) => {
      const drafts = await specialFolder("\\Drafts");
      const { source } = await fetchSource(drafts, uid);
      const m = await simpleParser(source);
      const to = [...firstAddress(m.to), ...firstAddress(m.cc), ...firstAddress(m.bcc)].map((a) => a.address).filter((a): a is string => Boolean(a));
      const from = firstAddress(m.from)[0]?.address ?? config.defaultFrom;
      // Strip the Bcc header from what recipients receive.
      const raw = Buffer.from(source.toString("utf8").replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n/im, ""), "utf8");
      const r = await sendRaw(raw, { from, to });
      await inFolder(drafts, (c) => c.messageDelete(String(uid), { uid: true }));
      return text(`Draft sent to ${r.accepted.join(", ")}${r.rejected.length ? ` (rejected: ${r.rejected.join(", ")})` : ""} and removed from Drafts.`);
    },
  );

  server.registerTool(
    "mailbox_reply",
    {
      title: "Reply to a message",
      description: "Reply (or reply-all) to a message with correct threading headers and the original quoted below. mode 'send' sends now; 'draft' saves to Drafts for review.",
      inputSchema: z.object({
        folder: folderArg,
        uid: uidArg,
        body: z.string().describe("Your reply text (plain text)"),
        reply_all: z.boolean().default(false),
        mode: z.enum(["send", "draft"]).default("draft").describe("'draft' (default) saves for review; 'send' sends immediately"),
        from: z.string().optional().describe("Send as this address/alias; default is the address the message was sent to when it is yours"),
        attachments: z.array(z.string()).optional(),
        ...protectionArgs,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, body, reply_all, mode, from, attachments, encrypt, sign, keyserver }) => {
      const { path, m, encrypted } = await readMessage(folder, uid);
      // Never quote decrypted text back in clear unless asked: replies to encrypted mail are encrypted by default.
      const protection = { encrypt: encrypt ?? encrypted, sign, keyserver };
      const own = ownAddresses();
      const replyTargets = firstAddress(m.replyTo).length ? firstAddress(m.replyTo) : firstAddress(m.from);
      const toList = replyTargets.map((a) => a.address).filter((a): a is string => Boolean(a));
      const ccList = reply_all ? [...firstAddress(m.to), ...firstAddress(m.cc)].map((a) => a.address).filter((a): a is string => Boolean(a) && !own.has(a!.toLowerCase()) && !toList.includes(a!)) : [];
      const sentTo = [...firstAddress(m.to), ...firstAddress(m.cc)].map((a) => a.address?.toLowerCase()).find((a) => a && own.has(a));
      const quoted = bodyText(m).split(/\r?\n/).map((l) => `> ${l}`).join("\n");
      const references = [...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : []), m.messageId].filter(Boolean).join(" ");
      const mail = {
        ...(from ? { from } : sentTo ? { from: sentTo } : {}),
        to: toList,
        cc: ccList,
        subject: /^re:/i.test(m.subject ?? "") ? m.subject : `Re: ${m.subject ?? ""}`,
        text: `${body}\n\nOn ${m.date?.toUTCString()}, ${m.from?.text} wrote:\n${quoted}`,
        inReplyTo: m.messageId,
        references,
        attachments: attachments?.map((p) => ({ path: resolve(p), filename: basename(p) })),
      };
      if (mode === "draft") {
        const { raw, note } = await composeProtected(mail, protection);
        const draftUid = await appendMessage(await specialFolder("\\Drafts"), raw, ["\\Draft", "\\Seen"]);
        return text(`Reply saved as a draft${draftUid ? ` (Drafts uid ${draftUid})` : ""}${note ? ` (${note})` : ""} to ${[...toList, ...ccList].join(", ")}. Send it with mailbox_send_draft.`);
      }
      const r = await sendMessage(mail, protection);
      await inFolder(path, (c) => c.messageFlagsAdd(String(uid), ["\\Answered"], { uid: true }));
      return text(`Reply sent${r.protection ? ` (${r.protection})` : ""} to ${r.accepted.join(", ")}. Original marked answered.`);
    },
  );

  server.registerTool(
    "mailbox_forward",
    {
      title: "Forward a message",
      description: "Forward a message with its attachments to new recipients, with an optional note above. mode 'draft' (default) saves for review; 'send' sends now.",
      inputSchema: z.object({
        folder: folderArg,
        uid: uidArg,
        to: z.union([z.string(), z.array(z.string())]),
        note: z.string().default(""),
        mode: z.enum(["send", "draft"]).default("draft"),
        from: z.string().optional(),
        ...protectionArgs,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, to, note, mode, from, encrypt, sign, keyserver }) => {
      const { path, m, encrypted } = await readMessage(folder, uid);
      const protection = { encrypt: encrypt ?? encrypted, sign, keyserver };
      const header = [`---------- Forwarded message ----------`, `From: ${m.from?.text ?? ""}`, `Date: ${m.date?.toUTCString() ?? ""}`, `Subject: ${m.subject ?? ""}`, `To: ${m.to ? (Array.isArray(m.to) ? m.to.map((a) => a.text).join(", ") : m.to.text) : ""}`].join("\n");
      const mail = {
        ...(from ? { from } : {}),
        to,
        subject: /^fwd?:/i.test(m.subject ?? "") ? m.subject : `Fwd: ${m.subject ?? ""}`,
        text: `${note}\n\n${header}\n\n${bodyText(m)}`,
        attachments: m.attachments.filter((a) => a.contentDisposition !== "inline").map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      };
      if (mode === "draft") {
        const { raw, note: pgpNote } = await composeProtected(mail, protection);
        const draftUid = await appendMessage(await specialFolder("\\Drafts"), raw, ["\\Draft", "\\Seen"]);
        return text(`Forward saved as a draft${draftUid ? ` (Drafts uid ${draftUid})` : ""}${pgpNote ? ` (${pgpNote})` : ""}. Send it with mailbox_send_draft.`);
      }
      const r = await sendMessage(mail, protection);
      await inFolder(path, (c) => c.messageFlagsAdd(String(uid), ["$Forwarded"], { uid: true }));
      return text(`Forwarded to ${r.accepted.join(", ")}.`);
    },
  );

  server.registerTool(
    "mailbox_update_messages",
    {
      title: "Mark, star, color or label messages",
      description: `Change state on many messages at once: read/unread, star, OX color (${COLORS.slice(1).join(", ")}), and labels (IMAP keywords such as $purchases, $social or your own words; shown as categories/labels). Select by uids or by a Gmail-style query. Nothing is moved or deleted.`,
      inputSchema: z.object({
        ...selectionArgs,
        mark_read: z.boolean().optional().describe("true = read, false = unread"),
        star: z.boolean().optional().describe("true = star (flag), false = unstar"),
        color: z.enum(COLORS).optional().describe("Set an OX color label; 'none' clears it"),
        add_labels: z.array(z.string()).optional().describe('Labels to add, e.g. ["receipts"] or ["$purchases"]. Spaces are not allowed in IMAP keywords; they become "-".'),
        remove_labels: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const { groups, total } = await resolveSelection(args);
      const add: string[] = [];
      const remove: string[] = [];
      if (args.mark_read !== undefined) (args.mark_read ? add : remove).push("\\Seen");
      if (args.star !== undefined) (args.star ? add : remove).push("\\Flagged");
      if (args.color) {
        remove.push(...COLORS.slice(1).map((_, i) => `$cl_${i + 1}`));
        if (args.color !== "none") { const n = COLORS.indexOf(args.color); remove.splice(remove.indexOf(`$cl_${n}`), 1); add.push(`$cl_${n}`); }
      }
      const keyword = (l: string) => l.trim().replace(/\s+/g, "-").replace(/[(){%*"\\\]]/g, "");
      add.push(...(args.add_labels ?? []).map(keyword));
      remove.push(...(args.remove_labels ?? []).map(keyword));
      if (!add.length && !remove.length) throw new Error("Nothing to change. Set mark_read, star, color, add_labels or remove_labels.");
      const summary = `${total} message(s) (${describeGroups(groups)}): add [${add.join(" ")}] remove [${remove.join(" ")}]`;
      if (args.dry_run) return text(`Dry run — would update ${summary}`);
      for (const [folder, uids] of groups) {
        if (!uids.length) continue;
        await inFolder(folder, async (c) => {
          if (add.length) await c.messageFlagsAdd(uids.join(","), add, { uid: true });
          if (remove.length) await c.messageFlagsRemove(uids.join(","), remove, { uid: true });
        });
      }
      return text(`Updated ${summary}`);
    },
  );

  server.registerTool(
    "mailbox_move_messages",
    {
      title: "Move, archive, trash or report spam",
      description: "Move many messages: to any folder, or archive / trash / junk (spam) / not_junk (back to INBOX). Select by uids or a Gmail-style query. Use dry_run first for big query selections. Trash can be undone by moving back.",
      inputSchema: z.object({
        ...selectionArgs,
        to: z.string().describe('Destination folder path, or one of: archive, trash, junk, not_junk, inbox'),
        mark_read: z.boolean().optional().describe("Also mark moved messages read (true) or unread (false)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { groups, total } = await resolveSelection(args);
      const key = args.to.trim().toLowerCase();
      const dest = key === "not_junk" ? "INBOX" : await resolveFolder(args.to);
      const flagsAdd = key === "junk" || key === "spam" ? ["$Junk"] : key === "not_junk" ? ["$NotJunk", "NonJunk"] : [];
      const flagsRemove = key === "not_junk" ? ["$Junk", "Junk"] : key === "junk" || key === "spam" ? ["$NotJunk", "NonJunk"] : [];
      if (args.mark_read !== undefined) (args.mark_read ? flagsAdd : flagsRemove).push("\\Seen");
      if (args.dry_run) return text(`Dry run — would move ${total} message(s) (${describeGroups(groups)}) to ${dest}.`);
      let moved = 0;
      for (const [folder, uids] of groups) {
        if (!uids.length || folder === dest) continue;
        await inFolder(folder, async (c) => {
          const range = uids.join(",");
          if (flagsAdd.length) await c.messageFlagsAdd(range, flagsAdd, { uid: true });
          if (flagsRemove.length) await c.messageFlagsRemove(range, flagsRemove, { uid: true });
          await c.messageMove(range, dest, { uid: true });
          moved += uids.length;
        });
      }
      return text(`Moved ${moved} message(s) to ${dest} (from ${describeGroups(groups)}).`);
    },
  );

  server.registerTool(
    "mailbox_delete_messages",
    {
      title: "Delete messages permanently",
      description: "PERMANENTLY delete messages (no Trash, cannot be undone except from mailbox.org backups). Prefer mailbox_move_messages to='trash'. Typical use: emptying Trash or Junk with query '' in that folder. Requires confirm=true.",
      inputSchema: z.object({ ...selectionArgs, confirm: z.literal(true).describe("Must be true: confirms permanent deletion") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const { groups, total } = await resolveSelection(args);
      if (args.dry_run) return text(`Dry run — would permanently delete ${total} message(s) (${describeGroups(groups)}).`);
      for (const [folder, uids] of groups) if (uids.length) await inFolder(folder, (c) => c.messageDelete(uids.join(","), { uid: true }));
      return text(`Permanently deleted ${total} message(s) (${describeGroups(groups)}).`);
    },
  );

  server.registerTool(
    "mailbox_list_senders",
    {
      title: "Top senders",
      description: "Group messages matching a query by sender address with counts, newest date and unread count. Use it to find who fills the inbox, then act with mailbox_move_messages, mailbox_create_filter or mailbox_unsubscribe.",
      inputSchema: z.object({
        query: z.string().default("newer_than:90d").describe(QUERY_HELP),
        folders: z.array(z.string()).optional().describe('Default INBOX; ["all"] for every folder'),
        group_by: z.enum(["address", "domain"]).default("address"),
        limit: z.number().int().min(1).max(200).default(40),
        scan_limit: z.number().int().min(1).max(20_000).default(5000).describe("Newest N matching messages to scan"),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, folders, group_by, limit, scan_limit, response_format }) => {
      const { hits } = await runSearch(query, folders);
      const summaries = await summariesFor(hits.slice(0, scan_limit));
      const groups = new Map<string, { sender: string; name: string; count: number; unread: number; newsletter: boolean; latest: string; size: number }>();
      for (const s of summaries) {
        const address = (/<([^>]+)>/.exec(s.from)?.[1] ?? s.from).toLowerCase();
        const k = group_by === "domain" ? address.split("@")[1] ?? address : address;
        const g = groups.get(k) ?? { sender: k, name: s.from.replace(/\s*<[^>]+>/, ""), count: 0, unread: 0, newsletter: false, latest: "", size: 0 };
        g.count++; if (!s.read) g.unread++; g.newsletter ||= s.newsletter; g.size += s.size ?? 0;
        if (s.date > g.latest) g.latest = s.date;
        groups.set(k, g);
      }
      const ranked = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
      return respondPage(response_format, ranked, { offset: 0, total: ranked.length }, "senders",
        (g) => `- **${g.sender}** (${clip(g.name, 40)}) — ${g.count} msgs, ${g.unread} unread, ${bytes(g.size)}, latest ${shortDate(g.latest)}${g.newsletter ? " · newsletter" : ""}`,
        `## Top senders in ${summaries.length} scanned messages${hits.length > scan_limit ? ` (of ${hits.length})` : ""}`);
    },
  );
}

/** Unparsed value of a header (unfolded), or undefined. */
export function rawHeader(m: ParsedMail, name: string): string | undefined {
  const line = m.headerLines.find((h) => h.key === name.toLowerCase())?.line;
  return line ? line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim() : undefined;
}

export { runSearch, summariesFor, bodyText };
