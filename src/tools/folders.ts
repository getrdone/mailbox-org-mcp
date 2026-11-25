import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { bytes, formatArg, respond, respondPage, text } from "../format.js";
import { COLORS, forgetFolders, imap, inFolder, listFolders, resolveFolder } from "../imap.js";

type FolderRow = { path: string; special?: string; subscribed: boolean; messages?: number; unread?: number; size?: number };

async function folderRows(withCounts: boolean, withSize: boolean): Promise<FolderRow[]> {
  const c = await imap();
  const rows: FolderRow[] = [];
  for (const f of await listFolders(true)) {
    const row: FolderRow = { path: f.path, special: f.specialUse, subscribed: f.subscribed !== false };
    if ((withCounts || withSize) && !f.flags.has("\\Noselect")) {
      const s = await c.status(f.path, { messages: true, unseen: true, ...(withSize ? { size: true } : {}) }).catch(() => false as const);
      if (s) Object.assign(row, { messages: s.messages, unread: s.unseen, size: (s as { size?: number }).size });
    }
    rows.push(row);
  }
  return rows;
}

export function registerFolderTools(server: McpServer): void {
  server.registerTool(
    "mailbox_list_folders",
    {
      title: "List folders",
      description: "List every mail folder with its exact path (use these paths in other tools), special role (Inbox, Sent, Archive, Junk, Trash, Drafts), total and unread counts, and optionally size.",
      inputSchema: z.object({
        include_counts: z.boolean().default(true),
        include_size: z.boolean().default(false).describe("Also return each folder's size in bytes"),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ include_counts, include_size, response_format }) => {
      const rows = await folderRows(include_counts, include_size);
      return respondPage(response_format, rows, { offset: 0, total: rows.length }, "folders", (r) => {
        const depth = r.path.split("/").length - 1;
        const counts = r.messages !== undefined ? ` — ${r.messages} msgs${r.unread ? `, ${r.unread} unread` : ""}${r.size !== undefined ? `, ${bytes(r.size)}` : ""}` : "";
        return `${"  ".repeat(depth)}- ${r.path}${r.special ? ` (${r.special.slice(1)})` : ""}${counts}${r.subscribed ? "" : " · unsubscribed"}`;
      }, `## ${rows.length} folders`);
    },
  );

  server.registerTool(
    "mailbox_get_storage",
    {
      title: "Check mail storage",
      description: "Show mail storage used vs. the plan limit (IMAP quota) and the largest folders, so you can see what to clean up. Use mailbox_search_messages with larger:5M to find big messages.",
      inputSchema: z.object({ top_folders: z.number().int().min(0).max(100).default(15), response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ top_folders, response_format }) => {
      const quota = await (await imap()).getQuota("INBOX");
      const storage = quota && quota.storage ? quota.storage : undefined;
      const rows = top_folders ? (await folderRows(true, true)).filter((r) => r.size !== undefined).sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) : [];
      const data = {
        used_bytes: storage?.usage,
        limit_bytes: storage?.limit,
        percent_used: storage?.usage && storage.limit ? Math.round((storage.usage / storage.limit) * 1000) / 10 : undefined,
        free_bytes: storage?.usage !== undefined && storage.limit ? storage.limit - storage.usage : undefined,
        folders_total_bytes: rows.reduce((n, r) => n + (r.size ?? 0), 0) || undefined,
        largest_folders: rows.slice(0, top_folders).map((r) => ({ path: r.path, size_bytes: r.size, messages: r.messages })),
      };
      return respond(response_format, data, () => [
        `## Mail storage`,
        storage ? `**${bytes(storage.usage)} of ${bytes(storage.limit)} used (${data.percent_used}%)** — ${bytes(data.free_bytes)} free.` : "The server did not report a quota.",
        "_Drive (cloud) storage is separate; mailbox_drive_list shows it when DAV access is set up._",
        rows.length ? "\n### Largest folders" : "",
        ...data.largest_folders.map((r) => `- ${r.path}: ${bytes(r.size_bytes)} (${r.messages} msgs)`),
      ].filter(Boolean).join("\n"));
    },
  );

  server.registerTool(
    "mailbox_manage_folder",
    {
      title: "Create, rename, delete or subscribe a folder",
      description: 'Folder housekeeping. action: create (path like "INBOX/receipts/2026"), rename (path -> new_path, also moves it), delete (must be empty unless force=true; force deletes every message in it permanently), subscribe / unsubscribe (whether mail apps show it).',
      inputSchema: z.object({
        action: z.enum(["create", "rename", "delete", "subscribe", "unsubscribe"]),
        path: z.string(),
        new_path: z.string().optional().describe("For rename"),
        force: z.boolean().default(false).describe("For delete: allow deleting a folder that still has messages (permanent)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ action, path, new_path, force }) => {
      const c = await imap();
      forgetFolders();
      if (action === "create") { await c.mailboxCreate(path); return text(`Created folder ${path}.`); }
      const current = await resolveFolder(path);
      if (action === "rename") {
        if (!new_path) throw new Error("rename needs new_path.");
        await c.mailboxRename(current, new_path);
        return text(`Renamed ${current} to ${new_path}. Filters that file mail into "${current}" must be updated (mailbox_list_filters).`);
      }
      if (action === "delete") {
        const s = await c.status(current, { messages: true });
        const children = (await listFolders(true)).filter((f) => f.path.startsWith(`${current}/`));
        if (!force && ((s && s.messages) || children.length)) throw new Error(`${current} still has ${s ? s.messages : "?"} messages and ${children.length} subfolders. Move them first, or pass force=true to delete permanently.`);
        await c.mailboxDelete(current);
        return text(`Deleted folder ${current}.`);
      }
      if (action === "subscribe") await c.mailboxSubscribe(current);
      else await c.mailboxUnsubscribe(current);
      return text(`${action === "subscribe" ? "Subscribed" : "Unsubscribed"} ${current}.`);
    },
  );

  server.registerTool(
    "mailbox_list_labels",
    {
      title: "List labels and colors",
      description: "List the labels (IMAP keywords) and OX color labels used in a folder with message counts, plus the color names accepted by mailbox_update_messages. Categories such as $social and $purchases are keywords too.",
      inputSchema: z.object({ folder: z.string().default("INBOX"), response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ folder, response_format }) => {
      const path = await resolveFolder(folder);
      const counts = await inFolder(path, async (c) => {
        const tally = new Map<string, number>();
        for await (const m of c.fetch("1:*", { flags: true })) for (const f of m.flags ?? []) if (!f.startsWith("\\")) tally.set(f, (tally.get(f) ?? 0) + 1);
        return tally;
      }, true);
      const rows = [...counts].sort((a, b) => b[1] - a[1]).map(([label, count]) => {
        const color = /^\$?cl_(\d+)$/i.exec(label);
        return { label, count, ...(color ? { color: COLORS[Number(color[1])] } : {}) };
      });
      return respond(response_format, { folder: path, labels: rows, colors: COLORS.slice(1) }, () => [
        `## Labels in ${path}`,
        ...rows.map((r) => `- ${r.label}${r.color ? ` (color ${r.color})` : ""}: ${r.count}`),
        rows.length ? "" : "_No labels used._",
        `Colors: ${COLORS.slice(1).join(", ")}`,
      ].join("\n"));
    },
  );
}
