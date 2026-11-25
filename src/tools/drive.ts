import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { config } from "../config.js";
import { absolute, davRequest, multistatus, textOf } from "../dav.js";
import { bytes, formatArg, respondPage, shortDate, text } from "../format.js";

const ROOT = "/servlet/webdav.infostore/";
const rawHref = (path: string) => `${ROOT}${path.replace(/^\/+/, "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;

let home: string | null = null;
/** Your personal Drive folder ("My files"), e.g. "Userstore/Jane Doe". */
async function homeFolder(): Promise<string> {
  if (home) return home;
  const entries = await multistatus("PROPFIND", rawHref("Userstore/"), `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`, "1");
  home = entries.slice(1).map((e) => relative(e.href).replace(/\/$/, ""))[0] ?? "Userstore";
  return home;
}

/** Paths are relative to "My files" unless they start with Userstore/, Public infostore/ or Trash. */
async function resolvePath(path: string): Promise<string> {
  const clean = path.replace(/^\/+/, "");
  if (/^(Userstore|Public infostore|Trash)(\/|$)/i.test(clean)) return clean;
  return `${await homeFolder()}${clean ? `/${clean}` : ""}`;
}
const href = async (path: string) => rawHref(await resolvePath(path));
const relative = (h: string) => decodeURIComponent(h.replace(/^https?:\/\/[^/]+/, "")).replace(ROOT, "").replace(/^\/+/, "");

export function registerDriveTools(server: McpServer): void {
  server.registerTool(
    "mailbox_drive_list",
    {
      title: "List Drive files",
      description: 'List files and folders in mailbox.org Drive (documents, spreadsheets and presentations live here too). path is relative to your own folder (My files), e.g. "" or "Documents/2026"; start with "Userstore/", "Public infostore/" or "Trash" for other areas. Needs a DAV-enabled app password.',
      inputSchema: z.object({ path: z.string().default(""), response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, response_format }) => {
      const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>`;
      const entries = await multistatus("PROPFIND", (await href(path)).replace(/\/?$/, "/"), body, "1");
      const [self, ...children] = entries;
      const rows = children.map((e) => ({
        path: relative(e.href).replace(/\/$/, ""),
        folder: Boolean(e.props.resourcetype && typeof e.props.resourcetype === "object" && "collection" in (e.props.resourcetype as object)),
        size: Number(textOf(e.props.getcontentlength)) || undefined,
        modified: textOf(e.props.getlastmodified),
        type: textOf(e.props.getcontenttype),
      })).sort((a, b) => Number(b.folder) - Number(a.folder) || a.path.localeCompare(b.path));
      const used = Number(textOf(self?.props["quota-used-bytes"]));
      const free = Number(textOf(self?.props["quota-available-bytes"]));
      return respondPage(response_format, rows, { offset: 0, total: rows.length }, "items",
        (r) => `- ${r.folder ? "📁" : "📄"} ${r.path}${r.folder ? "/" : ` (${bytes(r.size)}, ${shortDate(r.modified)})`}`,
        `## Drive: /${path}${used ? ` — ${bytes(used)} used${free ? `, ${bytes(free)} free` : ""}` : ""}`,
        { drive_used_bytes: used || undefined, drive_free_bytes: free || undefined });
    },
  );

  server.registerTool(
    "mailbox_drive_download",
    {
      title: "Download a Drive file",
      description: "Download a file from mailbox.org Drive to a local folder (default your Downloads/mailbox-org). Returns the saved path.",
      inputSchema: z.object({ path: z.string().describe("File path in Drive"), save_dir: z.string().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ path, save_dir }) => {
      const res = await davRequest("GET", await href(path));
      const dir = resolve(save_dir ?? (config.downloadDir || join(homedir(), "Downloads", "mailbox-org")));
      mkdirSync(dir, { recursive: true });
      let target = join(dir, basename(path));
      for (let n = 2; existsSync(target); n++) target = join(dir, basename(path).replace(/(\.[^.]*)?$/, ` (${n})$1`));
      const data = Buffer.from(await res.arrayBuffer());
      writeFileSync(target, data);
      return text(`Saved ${target} (${bytes(data.length)}).`);
    },
  );

  server.registerTool(
    "mailbox_drive_upload",
    {
      title: "Upload to Drive",
      description: "Upload a local file to a mailbox.org Drive folder. Refuses to overwrite unless overwrite=true.",
      inputSchema: z.object({ local_path: z.string(), folder: z.string().default(""), name: z.string().optional(), overwrite: z.boolean().default(false) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ local_path, folder, name, overwrite }) => {
      const target = `${folder.replace(/\/+$/, "")}${folder ? "/" : ""}${name ?? basename(local_path)}`;
      const data = readFileSync(resolve(local_path));
      await davRequest("PUT", await href(target), { body: data, contentType: "application/octet-stream", headers: overwrite ? {} : { "If-None-Match": "*" } });
      return text(`Uploaded ${bytes(data.length)} to Drive: ${target}`);
    },
  );

  server.registerTool(
    "mailbox_drive_manage",
    {
      title: "Create, move or delete in Drive",
      description: "Drive housekeeping: mkdir (path), move (path -> to, also renames), delete (path; folders recursively).",
      inputSchema: z.object({ action: z.enum(["mkdir", "move", "delete"]), path: z.string(), to: z.string().optional(), confirm: z.boolean().default(false).describe("Required true for delete") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ action, path, to, confirm }) => {
      if (action === "mkdir") { await davRequest("MKCOL", await href(path)); return text(`Created folder ${path}.`); }
      if (action === "move") {
        if (!to) throw new Error("move needs to.");
        await davRequest("MOVE", await href(path), { headers: { Destination: absolute(await href(to)), Overwrite: "F" } });
        return text(`Moved ${path} to ${to}.`);
      }
      if (!confirm) throw new Error("delete needs confirm=true.");
      await davRequest("DELETE", await href(path));
      return text(`Deleted ${path}.`);
    },
  );
}
