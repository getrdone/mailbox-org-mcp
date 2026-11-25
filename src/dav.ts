import { XMLParser } from "fast-xml-parser";
import { config, requireMailCredentials } from "./config.js";

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, htmlEntities: true, isArray: (name) => ["response", "propstat", "comp"].includes(name) });

export class DavError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** mailbox.org app passwords are per application: CalDAV/CardDAV and WebDAV (Drive) differ. */
function authHeader(href: string): string {
  requireMailCredentials();
  const password = href.includes("webdav.infostore") ? config.drivePassword : config.davPassword;
  return `Basic ${Buffer.from(`${config.email}:${password}`).toString("base64")}`;
}

export const absolute = (href: string) => (/^https?:/.test(href) ? href : `${config.davBase}${href.startsWith("/") ? "" : "/"}${href}`);

export async function davRequest(method: string, href: string, opts: { body?: string | Buffer; depth?: "0" | "1" | "infinity"; contentType?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const res = await fetch(absolute(href), {
    method,
    headers: {
      Authorization: authHeader(href),
      ...(opts.depth ? { Depth: opts.depth } : {}),
      ...(opts.body !== undefined ? { "Content-Type": opts.contentType ?? "application/xml; charset=utf-8" } : {}),
      ...opts.headers,
    },
    body: opts.body,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401) {
    const drive = href.includes("webdav.infostore");
    throw new DavError(401, `mailbox.org refused the ${drive ? "Drive" : "contacts/calendar/tasks"} sign-in. In mailbox.org: All settings > Security > Application Passwords, choose "${drive ? "WebDAV Client" : "Calendar and Addressbook Client (CalDAV/CardDAV)"}", add it, and put the password in ${config.secretsFile} as ${drive ? "MAILBOX_DRIVE_PASSWORD" : "MAILBOX_DAV_PASSWORD"}=..., then restart the server.`);
  }
  if (res.status >= 400) throw new DavError(res.status, `${method} ${href} failed with HTTP ${res.status}${res.status === 404 ? " (not found — list the folder again for current paths)" : res.status === 412 ? (method === "PUT" && !opts.headers?.["If-Match"] ? " (it already exists — pass overwrite=true to replace it)" : " (changed since it was read — read it again first)") : ""}.`);
  return res;
}

export interface DavEntry { href: string; props: Record<string, unknown> }

/** PROPFIND/REPORT multistatus as href + merged 200-status props. */
export async function multistatus(method: "PROPFIND" | "REPORT", href: string, body: string, depth: "0" | "1" = "1"): Promise<DavEntry[]> {
  const res = await davRequest(method, href, { body, depth });
  const doc = xml.parse(await res.text()) as { multistatus?: { response?: { href: string; propstat?: { prop?: Record<string, unknown>; status?: string }[] }[] } };
  return (doc.multistatus?.response ?? []).map((r) => ({
    href: decodeURI(String(r.href)),
    props: Object.assign({}, ...(r.propstat ?? []).filter((p) => !p.status || /200/.test(p.status)).map((p) => p.prop ?? {})),
  }));
}

export const textOf = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? String((v as Record<string, unknown>)["#text"] ?? "") : String(v));

export interface Collection { href: string; name: string; components: string[]; ctag?: string }

/** Address books (carddav) or calendars/task lists (caldav) of the account. */
export async function collections(kind: "carddav" | "caldav"): Promise<Collection[]> {
  const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><cs:getctag/></d:prop></d:propfind>`;
  const entries = await multistatus("PROPFIND", `/${kind}/`, body, "1");
  return entries
    .filter((e) => {
      const rt = e.props.resourcetype as Record<string, unknown> | undefined;
      return rt && (kind === "carddav" ? "addressbook" in rt : "calendar" in rt);
    })
    .map((e) => {
      const set = e.props["supported-calendar-component-set"] as { comp?: { "@_name"?: string }[] } | undefined;
      return { href: e.href, name: textOf(e.props.displayname) || e.href, components: (set?.comp ?? []).map((c) => c["@_name"] ?? "").filter(Boolean), ctag: textOf(e.props.getctag) || undefined };
    });
}

/** Every object (href, etag, data) in a collection matching a REPORT body. */
export async function reportObjects(href: string, body: string): Promise<{ href: string; etag: string; data: string }[]> {
  const entries = await multistatus("REPORT", href, body, "1");
  return entries
    .map((e) => ({ href: e.href, etag: textOf(e.props.getetag), data: textOf(e.props["address-data"] ?? e.props["calendar-data"]) }))
    .filter((o) => o.data);
}

export async function putObject(href: string, data: string, contentType: string, etag?: string): Promise<string> {
  const res = await davRequest("PUT", href, { body: data, contentType, headers: etag ? { "If-Match": etag } : { "If-None-Match": "*" } });
  return res.headers.get("etag") ?? "";
}

export async function deleteObject(href: string, etag?: string): Promise<void> {
  await davRequest("DELETE", href, { headers: etag ? { "If-Match": etag } : {} });
}

export async function getObject(href: string): Promise<{ data: string; etag: string }> {
  const res = await davRequest("GET", href);
  return { data: await res.text(), etag: res.headers.get("etag") ?? "" };
}
