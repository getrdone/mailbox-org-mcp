import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse, type SearchObject } from "imapflow";
import { config, requireMailCredentials } from "./config.js";

let client: ImapFlow | null = null;
let connecting: Promise<ImapFlow> | null = null;

/** One shared, lazily opened IMAP connection; reopened after drops. */
export async function imap(): Promise<ImapFlow> {
  if (client?.usable) return client;
  if (connecting) return connecting;
  requireMailCredentials();
  connecting = (async () => {
    const c = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: true,
      auth: { user: config.email, pass: config.password },
      logger: false,
      emitLogs: false,
    });
    c.on("error", () => { /* reconnect on next call */ });
    c.on("close", () => { if (client === c) client = null; });
    try {
      await c.connect();
    } catch (e) {
      throw new Error(`Could not sign in to ${config.imap.host}: ${(e as Error).message}. Check MAILBOX_EMAIL and the app password (it needs IMAP rights).`);
    }
    client = c;
    return c;
  })();
  try { return await connecting; } finally { connecting = null; }
}

/** Runs fn with the folder selected; serialized by imapflow's mailbox lock. */
export async function inFolder<T>(folder: string, fn: (c: ImapFlow) => Promise<T>, readOnly = false): Promise<T> {
  const c = await imap();
  let lock;
  try {
    lock = await c.getMailboxLock(folder, { readOnly });
  } catch (e) {
    throw new Error(`Folder "${folder}" could not be opened (${(e as Error).message}). Use mailbox_list_folders for exact folder paths, e.g. "INBOX/newsletters".`);
  }
  try { return await fn(c); } finally { lock.release(); }
}

let folderCache: { at: number; list: ListResponse[] } | null = null;

export async function listFolders(fresh = false): Promise<ListResponse[]> {
  if (!fresh && folderCache && Date.now() - folderCache.at < 60_000) return folderCache.list;
  const list = await (await imap()).list();
  folderCache = { at: Date.now(), list };
  return list;
}
export const forgetFolders = () => { folderCache = null; };

/** Resolves a special folder (\Archive, \Trash, \Junk, \Sent, \Drafts) to its path. */
export async function specialFolder(use: "\\Archive" | "\\Trash" | "\\Junk" | "\\Sent" | "\\Drafts"): Promise<string> {
  const found = (await listFolders()).find((f) => f.specialUse === use);
  if (found) return found.path;
  return { "\\Archive": "Archive", "\\Trash": "Trash", "\\Junk": "Junk", "\\Sent": "Sent", "\\Drafts": "Drafts" }[use];
}

/** Accepts a folder path case-insensitively and with "/" or "." separators, returning the server path. */
export async function resolveFolder(name: string): Promise<string> {
  const special: Record<string, Parameters<typeof specialFolder>[0]> = { archive: "\\Archive", trash: "\\Trash", junk: "\\Junk", spam: "\\Junk", sent: "\\Sent", drafts: "\\Drafts" };
  const lower = name.trim().toLowerCase();
  if (lower === "inbox") return "INBOX";
  const folders = await listFolders();
  const exact = folders.find((f) => f.path === name) ?? folders.find((f) => f.path.toLowerCase() === lower);
  if (exact) return exact.path;
  if (special[lower]) return specialFolder(special[lower]);
  const prefixed = folders.find((f) => f.path.toLowerCase() === `inbox/${lower}`);
  if (prefixed) return prefixed.path;
  throw new Error(`No folder named "${name}". Use mailbox_list_folders to see exact paths (subfolders look like "INBOX/financial/Tax").`);
}

/** OX App Suite color labels, stored as $cl_N keywords. */
export const COLORS = ["none", "red", "orange", "yellow", "light green", "green", "light blue", "blue", "purple", "pink", "gray"] as const;
const SYSTEM_FLAGS = new Set(["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft", "\\Recent"]);
const HIDDEN_KEYWORDS = /^(\$Forwarded|\$MDNSent|\$ITip\w+|\$HasAttachment|\$HasNoAttachment|\$Filtered|NonJunk|\$NotJunk|\$Junk|Junk|\$cl_\d+|cl_\d+)$/i;

export function describeFlags(flags: Set<string> | undefined) {
  const all = [...(flags ?? [])];
  const color = all.map((f) => /^\$?cl_(\d+)$/i.exec(f)).find(Boolean);
  return {
    read: all.includes("\\Seen"),
    starred: all.includes("\\Flagged"),
    answered: all.includes("\\Answered"),
    forwarded: all.includes("$Forwarded"),
    junk: all.some((f) => /^\$?junk$/i.test(f)),
    color: color ? COLORS[Number(color[1])] ?? `cl_${color[1]}` : undefined,
    labels: all.filter((f) => !SYSTEM_FLAGS.has(f) && !HIDDEN_KEYWORDS.test(f)),
  };
}

type Address = { name?: string; address?: string };
export const addr = (a: Address | undefined) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address ?? "") : "");
export const addrs = (list: Address[] | undefined) => (list ?? []).map(addr).join(", ");

/** Attachments listed in a BODYSTRUCTURE tree. */
export function attachmentsOf(node: FetchMessageObject["bodyStructure"]): { part: string; filename: string; type: string; size?: number }[] {
  const out: { part: string; filename: string; type: string; size?: number }[] = [];
  const walk = (n: NonNullable<typeof node>) => {
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name;
    if (filename || n.disposition === "attachment") out.push({ part: n.part ?? "1", filename: filename ?? "(unnamed)", type: n.type, size: n.size });
    n.childNodes?.forEach(walk);
  };
  if (node) walk(node);
  return out;
}

export interface MessageSummary {
  folder: string;
  uid: number;
  date: string;
  from: string;
  to: string;
  subject: string;
  size?: number;
  read: boolean;
  starred: boolean;
  answered: boolean;
  color?: string;
  labels: string[];
  attachments: number;
  newsletter: boolean;
  message_id?: string;
}

export const SUMMARY_FETCH: FetchQueryObject = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: ["list-unsubscribe", "list-id"] };

export function summarize(folder: string, m: FetchMessageObject): MessageSummary {
  const f = describeFlags(m.flags);
  const headers = m.headers?.toString("utf8") ?? "";
  return {
    folder,
    uid: m.uid,
    date: (m.envelope?.date ?? m.internalDate ?? "").toString() ? new Date(m.envelope?.date ?? m.internalDate ?? 0).toISOString() : "",
    from: addrs(m.envelope?.from),
    to: addrs(m.envelope?.to),
    subject: m.envelope?.subject ?? "",
    size: m.size,
    read: f.read,
    starred: f.starred,
    answered: f.answered,
    color: f.color,
    labels: f.labels,
    attachments: attachmentsOf(m.bodyStructure).length,
    newsletter: /list-unsubscribe|list-id/i.test(headers),
    message_id: m.envelope?.messageId,
  };
}

/** Searches one folder and returns matching UIDs, newest first. */
export async function searchUids(folder: string, query: SearchObject): Promise<number[]> {
  return inFolder(folder, async (c) => {
    const uids = (await c.search(query, { uid: true })) || [];
    return [...uids].sort((a, b) => b - a);
  }, true);
}

export async function fetchSummaries(folder: string, uids: number[]): Promise<MessageSummary[]> {
  if (!uids.length) return [];
  return inFolder(folder, async (c) => {
    const rows = await c.fetchAll(uids.join(","), SUMMARY_FETCH, { uid: true });
    const byUid = new Map(rows.map((m) => [m.uid, summarize(folder, m)]));
    return uids.map((u) => byUid.get(u)).filter((m): m is MessageSummary => Boolean(m));
  }, true);
}

/** Full RFC 822 source of one message (without marking it read). */
export async function fetchSource(folder: string, uid: number): Promise<{ source: Buffer; flags: Set<string> }> {
  return inFolder(folder, async (c) => {
    const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!m || !m.source) throw new Error(`Message uid ${uid} not found in "${folder}". UIDs come from mailbox_search_messages and are specific to a folder.`);
    return { source: m.source, flags: m.flags ?? new Set() };
  }, true);
}

/** Saves a raw message into a folder (Sent, Drafts...). */
export async function appendMessage(folder: string, raw: Buffer, flags: string[]): Promise<number | undefined> {
  const res = await (await imap()).append(folder, raw, flags);
  return res ? res.uid : undefined;
}
