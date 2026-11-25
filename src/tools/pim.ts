import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { collections, deleteObject, getObject, putObject, reportObjects, type Collection } from "../dav.js";
import { clip, formatArg, respond, respondPage, text } from "../format.js";
import { componentRange, escapeText, first, nowStamp, parseLines, readDate, replaceProperty, serialize, values, writeDate, type Line } from "../vobject.js";

const ADDRESS_QUERY = `<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><c:address-data/></d:prop></c:addressbook-query>`;
const calendarQuery = (component: "VTODO" | "VEVENT", range?: { start: string; end: string }) =>
  // With a range, ask the server to expand recurring items (birthdays, weekly meetings) into real occurrences.
  `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/>${range ? `<c:calendar-data><c:expand start="${range.start}" end="${range.end}"/></c:calendar-data>` : "<c:calendar-data/>"}</d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}">${range ? `<c:time-range start="${range.start}" end="${range.end}"/>` : ""}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;

/** Picks collections by name/href (case-insensitive), or all of a kind. */
async function pick(kind: "carddav" | "caldav", component: "VTODO" | "VEVENT" | null, name?: string): Promise<Collection[]> {
  const all = (await collections(kind)).filter((c) => !component || !c.components.length || c.components.includes(component));
  if (!name) return all;
  const hit = all.filter((c) => c.name.toLowerCase() === name.toLowerCase() || c.href === name);
  if (!hit.length) throw new Error(`No ${kind === "carddav" ? "address book" : component === "VTODO" ? "task list" : "calendar"} named "${name}". Available: ${all.map((c) => c.name).join(", ")}.`);
  return hit;
}

// ---------------- Contacts ----------------

interface Contact { href: string; etag: string; book: string; name: string; emails: string[]; phones: string[]; org: string; title: string; note: string; birthday: string; categories: string; address: string }

function readContact(o: { href: string; etag: string; data: string }, book: string): Contact {
  const l = parseLines(o.data);
  const n = first(l, "N").split(";");
  return {
    href: o.href, etag: o.etag, book,
    name: first(l, "FN") || [n[1], n[0]].filter(Boolean).join(" "),
    emails: values(l, "EMAIL").map((e) => e.value),
    phones: values(l, "TEL").map((t) => t.value.replace(/^tel:/, "")),
    org: first(l, "ORG").replace(/;+$/, ""),
    title: first(l, "TITLE"),
    note: first(l, "NOTE"),
    birthday: first(l, "BDAY"),
    categories: first(l, "CATEGORIES"),
    address: first(l, "ADR").split(";").filter(Boolean).join(", "),
  };
}

let contactCache: { at: number; contacts: Contact[]; book?: string } | null = null;
async function allContacts(book?: string): Promise<Contact[]> {
  if (contactCache && contactCache.book === book && Date.now() - contactCache.at < 120_000) return contactCache.contacts;
  const out: Contact[] = [];
  for (const c of await pick("carddav", null, book)) for (const o of await reportObjects(c.href, ADDRESS_QUERY)) out.push(readContact(o, c.name));
  contactCache = { at: Date.now(), contacts: out, book };
  return out;
}

const contactFields = {
  full_name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  emails: z.array(z.string()).optional().describe("Replaces all email addresses"),
  phones: z.array(z.string()).optional().describe("Replaces all phone numbers"),
  organization: z.string().optional(),
  title: z.string().optional(),
  birthday: z.string().optional().describe("YYYY-MM-DD"),
  note: z.string().optional(),
  categories: z.array(z.string()).optional(),
  address: z.string().optional().describe("Postal address as one line (street, city, region, postcode, country)"),
};

// ---------------- Tasks and events ----------------

interface CalItem { href: string; etag: string; list: string; uid: string; summary: string; description: string; status: string; due: string; start: string; end: string; completed: string; priority: number; location: string; categories: string; rrule?: string }

/**
 * Occurrences of a repeating event inside [from, to] for simple rules
 * (FREQ=YEARLY|MONTHLY|WEEKLY|DAILY with INTERVAL, UNTIL, COUNT). Times keep their clock time.
 */
function occurrences(item: CalItem, from: Date, to: Date): CalItem[] {
  const rule = Object.fromEntries((item.rrule ?? "").split(";").map((p) => p.split("=")));
  const freq = rule.FREQ as string | undefined;
  const startDate = new Date(`${item.start.slice(0, 10)}T00:00:00`);
  if (!freq || Number.isNaN(startDate.getTime())) return [item];
  const interval = Number(rule.INTERVAL ?? 1);
  const until = rule.UNTIL ? new Date(`${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}T23:59:59`) : null;
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const lengthDays = item.end ? Math.round((new Date(`${item.end.slice(0, 10)}T00:00:00`).getTime() - startDate.getTime()) / 86_400_000) : 0;
  const step = (d: Date, n: number) => {
    const x = new Date(startDate);
    if (freq === "YEARLY") x.setFullYear(x.getFullYear() + n * interval);
    else if (freq === "MONTHLY") x.setMonth(x.getMonth() + n * interval);
    else if (freq === "WEEKLY") x.setDate(x.getDate() + 7 * n * interval);
    else if (freq === "DAILY") x.setDate(x.getDate() + n * interval);
    else return null;
    return x;
  };
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const out: CalItem[] = [];
  // Jump close to the range start instead of walking from the first occurrence (birthdays from 1604...).
  const perYear = { YEARLY: 1 / interval, MONTHLY: 12 / interval, WEEKLY: 52 / interval, DAILY: 365 / interval }[freq as "YEARLY"] ?? 1;
  let n = Math.max(0, Math.floor(((from.getTime() - startDate.getTime()) / (365.25 * 86_400_000)) * perYear) - 2);
  for (let guard = 0; guard < 1000 && n < count; guard++, n++) {
    const d = step(startDate, n);
    if (!d || d > to || (until && d > until)) break;
    if (d >= new Date(from.getFullYear(), from.getMonth(), from.getDate())) {
      const end = new Date(d);
      end.setDate(end.getDate() + lengthDays);
      out.push({ ...item, start: fmt(d) + item.start.slice(10), end: item.end ? fmt(end) + item.end.slice(10) : "" });
    }
  }
  return out;
}

/** Every VTODO/VEVENT in one object (an expanded recurring event holds one per occurrence). */
function readItems(o: { href: string; etag: string; data: string }, list: string, component: "VTODO" | "VEVENT"): CalItem[] {
  const l = parseLines(o.data);
  const out: CalItem[] = [];
  for (let i = 0; i < l.length; i++) {
    if (l[i].name !== "BEGIN" || l[i].value.toUpperCase() !== component) continue;
    const end = l.findIndex((x, j) => j > i && x.name === "END" && x.value.toUpperCase() === component);
    const c = l.slice(i, end + 1);
    const prop = (n: string) => c.find((x) => x.name === n);
    out.push({
      href: o.href, etag: o.etag, list, uid: first(c, "UID"),
      summary: first(c, "SUMMARY"), description: first(c, "DESCRIPTION"), status: first(c, "STATUS"),
      due: readDate(prop("DUE")), start: readDate(prop("DTSTART")), end: readDate(prop("DTEND")), completed: readDate(prop("COMPLETED")),
      priority: Number(first(c, "PRIORITY") || 0), location: first(c, "LOCATION"), categories: first(c, "CATEGORIES"),
      ...(first(c, "RRULE") ? { rrule: first(c, "RRULE") } : {}),
    });
    i = end;
  }
  return out;
}

async function itemsIn(component: "VTODO" | "VEVENT", listName?: string, range?: { start: string; end: string }): Promise<CalItem[]> {
  const out: CalItem[] = [];
  for (const c of await pick("caldav", component, listName)) for (const o of await reportObjects(c.href, calendarQuery(component, range))) out.push(...readItems(o, c.name, component));
  return out;
}

/** mailbox.org may store a new item under its own name; find its real link by UID. */
async function realHref(component: "VTODO" | "VEVENT", listName: string | undefined, href: string, data: string): Promise<string> {
  const uid = first(parseLines(data), "UID");
  const hit = (await itemsIn(component, listName)).find((i) => i.uid === uid);
  return hit?.href ?? href;
}

const icsStamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Applies field updates to the first VTODO/VEVENT, creating a new object when existing is undefined. */
function buildCal(component: "VTODO" | "VEVENT", existing: string | undefined, set: Record<string, Line[] | undefined>): string {
  const lines = existing ? parseLines(existing) : parseLines(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//mailbox-org-mcp//EN\r\nBEGIN:${component}\r\nUID:${randomUUID()}\r\nCREATED:${nowStamp()}\r\nEND:${component}\r\nEND:VCALENDAR\r\n`);
  let range = componentRange(lines, component);
  for (const [name, newLines] of Object.entries({ ...set, DTSTAMP: [{ name: "DTSTAMP", params: "", value: nowStamp() }], "LAST-MODIFIED": [{ name: "LAST-MODIFIED", params: "", value: nowStamp() }] })) {
    if (newLines) range = replaceProperty(lines, range, name, newLines);
  }
  return serialize(lines);
}
const textProp = (name: string, v: string | undefined) => (v === undefined ? undefined : v === "" ? [] : [{ name, params: "", value: escapeText(v) }]);

export function registerPimTools(server: McpServer): void {
  server.registerTool(
    "mailbox_list_collections",
    {
      title: "List address books, calendars and task lists",
      description: "List mailbox.org address books, calendars and task lists (names to use in the contact, task and event tools). Needs a DAV-enabled app password.",
      inputSchema: z.object({ response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ response_format }) => {
      const books = await collections("carddav");
      const cals = await collections("caldav");
      const data = { address_books: books, calendars: cals.filter((c) => !c.components.length || c.components.includes("VEVENT")), task_lists: cals.filter((c) => c.components.includes("VTODO")) };
      return respond(response_format, data, () => [
        "## Address books", ...data.address_books.map((c) => `- ${c.name}`),
        "\n## Calendars", ...data.calendars.map((c) => `- ${c.name}`),
        "\n## Task lists", ...data.task_lists.map((c) => `- ${c.name}`),
      ].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_search_contacts",
    {
      title: "Search contacts",
      description: "Search the mailbox.org address book(s) by name, email, phone, company or category. Empty query lists everyone. Returns each contact's href for mailbox_save_contact / mailbox_delete_contact.",
      inputSchema: z.object({
        query: z.string().default(""),
        address_book: z.string().optional().describe("Limit to one address book by name"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, address_book, limit, offset, response_format }) => {
      const q = query.toLowerCase();
      const hits = (await allContacts(address_book))
        .filter((c) => !q || [c.name, c.org, c.title, c.categories, c.note, ...c.emails, ...c.phones].join(" ").toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name));
      return respondPage(response_format, hits.slice(offset, offset + limit), { offset, total: hits.length }, "contacts",
        (c) => `- **${c.name || "(no name)"}**${c.org ? ` — ${c.org}` : ""}${c.emails.length ? ` · ${c.emails.join(", ")}` : ""}${c.phones.length ? ` · ${c.phones.join(", ")}` : ""} · \`${c.href}\``,
        `## ${hits.length} contacts${query ? ` matching "${query}"` : ""}`);
    },
  );

  server.registerTool(
    "mailbox_save_contact",
    {
      title: "Create or update a contact",
      description: "Create a contact (omit href) or update one (give href from mailbox_search_contacts). On update only the fields you pass change; everything else in the card is kept.",
      inputSchema: z.object({ href: z.string().optional(), address_book: z.string().optional().describe("For new contacts; default the first address book"), ...contactFields }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (a) => {
      let lines: Line[];
      let href = a.href;
      let etag: string | undefined;
      if (href) {
        const current = await getObject(href);
        lines = parseLines(current.data);
        etag = current.etag || undefined;
      } else {
        const [book] = await pick("carddav", null, a.address_book);
        if (!book) throw new Error("No address book found.");
        const uid = randomUUID();
        href = `${book.href.replace(/\/?$/, "/")}${uid}.vcf`;
        lines = parseLines(`BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nEND:VCARD\r\n`);
      }
      let range = componentRange(lines, "VCARD");
      const set = (name: string, newLines: Line[] | undefined) => { if (newLines) range = replaceProperty(lines, range, name, newLines); };
      const existingN = first(lines, "N").split(";");
      if (a.first_name !== undefined || a.last_name !== undefined) set("N", [{ name: "N", params: "", value: [escapeText(a.last_name ?? existingN[0] ?? ""), escapeText(a.first_name ?? existingN[1] ?? ""), "", "", ""].join(";") }]);
      const fullName = a.full_name ?? (a.first_name !== undefined || a.last_name !== undefined ? [a.first_name ?? existingN[1], a.last_name ?? existingN[0]].filter(Boolean).join(" ") : undefined);
      set("FN", textProp("FN", fullName));
      if (!first(lines, "N") && fullName) set("N", [{ name: "N", params: "", value: `${escapeText(fullName.split(" ").slice(1).join(" "))};${escapeText(fullName.split(" ")[0])};;;` }]);
      set("EMAIL", a.emails?.map((e, i) => ({ name: "EMAIL", params: `;TYPE=INTERNET${i === 0 ? ",PREF" : ""}`, value: e })));
      set("TEL", a.phones?.map((p) => ({ name: "TEL", params: ";TYPE=CELL", value: p })));
      set("ORG", textProp("ORG", a.organization));
      set("TITLE", textProp("TITLE", a.title));
      set("NOTE", textProp("NOTE", a.note));
      set("BDAY", a.birthday === undefined ? undefined : a.birthday ? [{ name: "BDAY", params: "", value: a.birthday }] : []);
      set("CATEGORIES", a.categories?.length ? [{ name: "CATEGORIES", params: "", value: a.categories.map(escapeText).join(",") }] : a.categories ? [] : undefined);
      set("ADR", a.address === undefined ? undefined : a.address ? [{ name: "ADR", params: ";TYPE=HOME", value: `;;${escapeText(a.address)};;;;` }] : []);
      set("REV", [{ name: "REV", params: "", value: nowStamp() }]);
      if (!first(lines, "FN")) throw new Error("A contact needs full_name (or first_name/last_name).");
      await putObject(href, serialize(lines), "text/vcard; charset=utf-8", etag);
      contactCache = null;
      return text(`${a.href ? "Updated" : "Created"} contact ${first(lines, "FN")} (\`${href}\`).`);
    },
  );

  server.registerTool(
    "mailbox_delete_contact",
    {
      title: "Delete a contact",
      description: "Delete a contact by href (from mailbox_search_contacts).",
      inputSchema: z.object({ href: z.string(), confirm: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ href }) => { await deleteObject(href); contactCache = null; return text(`Deleted contact \`${href}\`.`); },
  );

  server.registerTool(
    "mailbox_list_tasks",
    {
      title: "List tasks",
      description: "List mailbox.org tasks: open (default), completed or all; optionally due before a date or matching text. Sorted by due date.",
      inputSchema: z.object({
        task_list: z.string().optional(),
        status: z.enum(["open", "completed", "all"]).default("open"),
        due_before: z.string().optional().describe("YYYY-MM-DD"),
        query: z.string().default(""),
        limit: z.number().int().min(1).max(500).default(100),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ task_list, status, due_before, query, limit, response_format }) => {
      const q = query.toLowerCase();
      const tasks = (await itemsIn("VTODO", task_list))
        .filter((t) => status === "all" || (status === "completed") === (t.status.toUpperCase() === "COMPLETED" || Boolean(t.completed)))
        .filter((t) => !due_before || (t.due && t.due.slice(0, 10) < due_before))
        .filter((t) => !q || `${t.summary} ${t.description} ${t.categories}`.toLowerCase().includes(q))
        .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
      return respondPage(response_format, tasks.slice(0, limit), { offset: 0, total: tasks.length }, "tasks",
        (t) => `- [${t.completed || t.status.toUpperCase() === "COMPLETED" ? "x" : " "}] **${t.summary}**${t.due ? ` — due ${t.due}` : ""}${t.priority ? ` · priority ${t.priority}` : ""} · ${t.list}${t.description ? ` · ${clip(t.description.replace(/\s+/g, " "), 80)}` : ""} · \`${t.href}\``,
        `## ${tasks.length} ${status} tasks`);
    },
  );

  server.registerTool(
    "mailbox_save_task",
    {
      title: "Create, update or complete a task",
      description: "Create a task (omit href) or update one (href from mailbox_list_tasks): title, notes, due date, priority, and done=true/false to complete or reopen. Only passed fields change.",
      inputSchema: z.object({
        href: z.string().optional(),
        task_list: z.string().optional().describe("For new tasks; default the first task list"),
        title: z.string().optional(),
        notes: z.string().optional(),
        due: z.string().optional().describe("YYYY-MM-DD, or ISO time; empty string clears"),
        priority: z.number().int().min(0).max(9).optional().describe("1 high … 9 low, 0 none"),
        done: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ href, task_list, title, notes, due, priority, done }) => {
      let existing: { data: string; etag: string } | undefined;
      let target = href;
      if (href) existing = await getObject(href);
      else {
        if (!title) throw new Error("A new task needs a title.");
        const [list] = await pick("caldav", "VTODO", task_list);
        if (!list) throw new Error("No task list found.");
        target = `${list.href.replace(/\/?$/, "/")}${randomUUID()}.ics`;
      }
      const data = buildCal("VTODO", existing?.data, {
        SUMMARY: textProp("SUMMARY", title),
        DESCRIPTION: textProp("DESCRIPTION", notes),
        DUE: due === undefined ? undefined : due ? [writeDate("DUE", due)] : [],
        PRIORITY: priority === undefined ? undefined : priority ? [{ name: "PRIORITY", params: "", value: String(priority) }] : [],
        STATUS: done === undefined ? (existing ? undefined : [{ name: "STATUS", params: "", value: "NEEDS-ACTION" }]) : [{ name: "STATUS", params: "", value: done ? "COMPLETED" : "NEEDS-ACTION" }],
        COMPLETED: done === undefined ? undefined : done ? [{ name: "COMPLETED", params: "", value: nowStamp() }] : [],
        "PERCENT-COMPLETE": done === undefined ? undefined : [{ name: "PERCENT-COMPLETE", params: "", value: done ? "100" : "0" }],
      });
      await putObject(target!, data, "text/calendar; charset=utf-8", existing?.etag || undefined);
      const link = href ?? (await realHref("VTODO", task_list, target!, data));
      return text(`${href ? "Updated" : "Created"} task${title ? ` "${title}"` : ""}${done !== undefined ? (done ? " (completed)" : " (reopened)") : ""} — \`${link}\`.`);
    },
  );

  server.registerTool(
    "mailbox_list_events",
    {
      title: "List calendar events",
      description: "List mailbox.org calendar events between two dates (default: today through 30 days ahead).",
      inputSchema: z.object({
        calendar: z.string().optional(),
        start: z.string().optional().describe("YYYY-MM-DD"),
        end: z.string().optional().describe("YYYY-MM-DD"),
        query: z.string().default(""),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ calendar, start, end, query, response_format }) => {
      const from = start ? new Date(`${start}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
      const to = end ? new Date(`${end}T23:59:59`) : new Date(from.getTime() + 30 * 86_400_000);
      const q = query.toLowerCase();
      const events = (await itemsIn("VEVENT", calendar, { start: icsStamp(from.toISOString()), end: icsStamp(to.toISOString()) }))
        .flatMap((e) => (e.rrule ? occurrences(e, from, to) : [e]))
        .filter((e) => !q || `${e.summary} ${e.description} ${e.location}`.toLowerCase().includes(q))
        .sort((a, b) => a.start.localeCompare(b.start));
      return respondPage(response_format, events, { offset: 0, total: events.length }, "events",
        (e) => `- **${e.summary || "(no title)"}** — ${e.start}${e.end ? ` → ${e.end}` : ""}${e.location ? ` · ${e.location}` : ""} · ${e.list} · \`${e.href}\``,
        `## ${events.length} events ${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`);
    },
  );

  server.registerTool(
    "mailbox_save_event",
    {
      title: "Create or update a calendar event",
      description: "Create an event (omit href) or update one (href from mailbox_list_events). start/end as YYYY-MM-DD for all-day, or ISO times with offset (2026-11-24T15:00:00-08:00). Only passed fields change.",
      inputSchema: z.object({
        href: z.string().optional(),
        calendar: z.string().optional(),
        title: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ href, calendar, title, start, end, location, notes }) => {
      let existing: { data: string; etag: string } | undefined;
      let target = href;
      if (href) existing = await getObject(href);
      else {
        if (!title || !start) throw new Error("A new event needs title and start.");
        const [cal] = await pick("caldav", "VEVENT", calendar);
        if (!cal) throw new Error("No calendar found.");
        target = `${cal.href.replace(/\/?$/, "/")}${randomUUID()}.ics`;
      }
      const data = buildCal("VEVENT", existing?.data, {
        SUMMARY: textProp("SUMMARY", title),
        DTSTART: start ? [writeDate("DTSTART", start)] : undefined,
        DTEND: end ? [writeDate("DTEND", end)] : undefined,
        LOCATION: textProp("LOCATION", location),
        DESCRIPTION: textProp("DESCRIPTION", notes),
      });
      await putObject(target!, data, "text/calendar; charset=utf-8", existing?.etag || undefined);
      const link = href ?? (await realHref("VEVENT", calendar, target!, data));
      return text(`${href ? "Updated" : "Created"} event${title ? ` "${title}"` : ""} — \`${link}\`.`);
    },
  );

  server.registerTool(
    "mailbox_delete_item",
    {
      title: "Delete a task or event",
      description: "Delete a task or calendar event by href.",
      inputSchema: z.object({ href: z.string(), confirm: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ href }) => { await deleteObject(href); return text(`Deleted \`${href}\`.`); },
  );
}
