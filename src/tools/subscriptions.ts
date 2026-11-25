import type { McpServer } from "@modelcontextprotocol/server";
import { simpleParser } from "mailparser";
import * as z from "zod/v4";
import { clip, formatArg, respondPage, shortDate, text } from "../format.js";
import { fetchSource, inFolder, resolveFolder, searchUids } from "../imap.js";
import { parseQuery } from "../search.js";
import { sendMessage } from "../smtp.js";
import { addFilter } from "./filters.js";
import { rawHeader, runSearch } from "./mail.js";

interface ListHeaders { unsubscribe: string[]; oneClick: boolean; subscribe: string[]; listId?: string }

const angleList = (v: string | undefined) => [...(v ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());

function parseListHeaders(get: (name: string) => string | undefined): ListHeaders {
  return {
    unsubscribe: angleList(get("list-unsubscribe")),
    oneClick: /List-Unsubscribe=One-Click/i.test(get("list-unsubscribe-post") ?? ""),
    subscribe: angleList(get("list-subscribe")),
    listId: get("list-id")?.replace(/^.*<([^>]+)>.*$/, "$1"),
  };
}

const methodsOf = (h: ListHeaders) => [h.oneClick && h.unsubscribe.some((u) => u.startsWith("https:")) ? "one-click" : "", h.unsubscribe.some((u) => u.startsWith("mailto:")) ? "email" : "", h.unsubscribe.some((u) => /^https?:/.test(u)) ? "link" : ""].filter(Boolean);

/** Sends an email per a mailto: URI (to, subject and body from the URI). */
async function mailto(uri: string, fallbackSubject: string) {
  const url = new URL(uri);
  const to = decodeURIComponent(url.pathname);
  const subject = url.searchParams.get("subject") ?? fallbackSubject;
  const body = url.searchParams.get("body") ?? fallbackSubject;
  await sendMessage({ to, subject, text: body });
  return to;
}

export function registerSubscriptionTools(server: McpServer): void {
  server.registerTool(
    "mailbox_list_subscriptions",
    {
      title: "List newsletter subscriptions",
      description: "Find mailing lists and newsletters you receive (messages with List-Unsubscribe), grouped by sender with message count, unread count, newest date, list id and which unsubscribe methods work. Pick a row's folder+uid for mailbox_unsubscribe.",
      inputSchema: z.object({
        query: z.string().default("newer_than:180d").describe("Extra Gmail-style filter, default the last 180 days"),
        folders: z.array(z.string()).default(["all"]).describe('Folders to scan; default ["all"] (except Trash/Junk)'),
        limit: z.number().int().min(1).max(300).default(50),
        offset: z.number().int().min(0).default(0),
        scan_limit: z.number().int().min(1).max(20_000).default(4000),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, folders, limit, offset, scan_limit, response_format }) => {
      const { hits } = await runSearch(`${query} has:unsubscribe`, folders);
      const byFolder = new Map<string, number[]>();
      for (const h of hits.slice(0, scan_limit)) byFolder.set(h.folder, [...(byFolder.get(h.folder) ?? []), h.uid]);
      type Row = { sender: string; name: string; list_id?: string; count: number; unread: number; latest: string; folder: string; uid: number; methods: string[]; folders: string[] };
      const groups = new Map<string, Row>();
      for (const [folder, uids] of byFolder) {
        await inFolder(folder, async (c) => {
          for await (const m of c.fetch(uids.join(","), { uid: true, envelope: true, flags: true, headers: ["list-unsubscribe", "list-unsubscribe-post", "list-subscribe", "list-id"] }, { uid: true })) {
            const raw = m.headers?.toString("utf8") ?? "";
            const get = (name: string) => new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im").exec(raw)?.[1].replace(/\r?\n[ \t]+/g, " ");
            const h = parseListHeaders(get);
            const from = m.envelope?.from?.[0];
            const sender = (from?.address ?? "?").toLowerCase();
            const key = h.listId ?? sender;
            const date = new Date(m.envelope?.date ?? 0).toISOString();
            const g = groups.get(key) ?? { sender, name: from?.name ?? "", list_id: h.listId, count: 0, unread: 0, latest: "", folder, uid: m.uid, methods: [], folders: [] };
            g.count++;
            if (!m.flags?.has("\\Seen")) g.unread++;
            if (!g.folders.includes(folder)) g.folders.push(folder);
            if (date > g.latest) Object.assign(g, { latest: date, folder, uid: m.uid, methods: methodsOf(h) });
            groups.set(key, g);
          }
        }, true);
      }
      const rows = [...groups.values()].sort((a, b) => b.count - a.count);
      return respondPage(response_format, rows.slice(offset, offset + limit), { offset, total: rows.length }, "subscriptions",
        (r) => `- **${clip(r.name || r.sender, 50)}** <${r.sender}> — ${r.count} msgs (${r.unread} unread), latest ${shortDate(r.latest)} · unsubscribe: ${r.methods.join("/") || "none"} · newest: ${r.folder} uid ${r.uid}`,
        `## ${rows.length} subscriptions in ${Math.min(hits.length, scan_limit)} newsletter messages`);
    },
  );

  server.registerTool(
    "mailbox_unsubscribe",
    {
      title: "Unsubscribe (or subscribe) from a mailing list",
      description: "Unsubscribe using a message's List-Unsubscribe header: one-click web unsubscribe (RFC 8058) when offered, else an unsubscribe email, else returns the link to open in the browser. Optional cleanup: also_filter files future mail from that sender into a folder (e.g. Trash), also_move moves existing mail from that sender. action=subscribe uses List-Subscribe when present.",
      inputSchema: z.object({
        folder: z.string().default("INBOX"),
        uid: z.number().int().positive().describe("A message from that list (mailbox_list_subscriptions gives the newest one)"),
        action: z.enum(["unsubscribe", "subscribe"]).default("unsubscribe"),
        method: z.enum(["auto", "one-click", "email", "link"]).default("auto"),
        also_move: z.string().optional().describe('Move existing mail from this sender to a folder, e.g. "Trash" or "Archive"'),
        also_filter: z.string().optional().describe('Create a filter sending future mail from this sender to a folder, e.g. "Trash"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, action, method, also_move, also_filter }) => {
      const path = await resolveFolder(folder);
      const m = await simpleParser((await fetchSource(path, uid)).source, { skipHtmlToText: true, skipTextToHtml: true });
      const h = parseListHeaders((name) => rawHeader(m, name));
      const sender = (m.from?.value[0]?.address ?? "").toLowerCase();
      const out: string[] = [];

      if (action === "subscribe") {
        const mail = h.subscribe.find((u) => u.startsWith("mailto:"));
        const link = h.subscribe.find((u) => /^https?:/.test(u));
        if (mail) out.push(`Subscribe request emailed to ${await mailto(mail, "subscribe")}.`);
        else if (link) out.push(`Open this link to subscribe: ${link}`);
        else out.push("This list has no List-Subscribe header; subscribe on the sender's website.");
        return text(out.join("\n"));
      }

      const https = h.unsubscribe.find((u) => u.startsWith("https:"));
      const mail = h.unsubscribe.find((u) => u.startsWith("mailto:"));
      const link = h.unsubscribe.find((u) => /^https?:/.test(u));
      if (!h.unsubscribe.length) out.push("No List-Unsubscribe header. Use the unsubscribe link in the message body, or block the sender with also_filter.");
      else if ((method === "auto" || method === "one-click") && h.oneClick && https) {
        const res = await fetch(https, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "follow", signal: AbortSignal.timeout(20_000) });
        out.push(res.ok ? `Unsubscribed with one-click (HTTP ${res.status}) from ${h.listId ?? sender}.` : `One-click unsubscribe returned HTTP ${res.status}. ${mail ? "Try method=email." : link ? `Open ${link} instead.` : ""}`);
      } else if ((method === "auto" || method === "email") && mail) {
        out.push(`Unsubscribe email sent to ${await mailto(mail, "unsubscribe")} (from your address).`);
      } else if (link) {
        out.push(`This list needs its web page: open ${link} in the browser to finish unsubscribing.`);
      } else out.push(`Method ${method} is not offered by this list. Available: ${methodsOf(h).join(", ") || "none"}.`);

      if (also_move && sender) {
        const dest = await resolveFolder(also_move);
        const { query } = parseQuery(`from:${sender}`);
        const uids = await searchUids(path, query);
        if (uids.length) await inFolder(path, (c) => c.messageMove(uids.join(","), dest, { uid: true }));
        out.push(`Moved ${uids.length} existing message(s) from ${sender} in ${path} to ${dest}.`);
      }
      if (also_filter && sender) {
        await addFilter(`Unsubscribed: ${sender}`, [{ field: "from", match: "is", values: [sender] }], { move_to: also_filter, keep_copy_when_forwarding: true, stop: true });
        out.push(`Filter added: future mail from ${sender} goes to ${also_filter}.`);
      }
      return text(out.join("\n"));
    },
  );
}
