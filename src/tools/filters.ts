import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { SearchObject } from "imapflow";
import * as z from "zod/v4";
import { clip, formatArg, respond, text } from "../format.js";
import { COLORS, inFolder, resolveFolder, searchUids } from "../imap.js";
import { buildRule, ensureRequires, findRule, insertRule, listRules, parseScript, serializeScript, setEnabled, type Actions, type Condition, type Item } from "../rules.js";
import { sieve } from "../sieve.js";
import { merge } from "../search.js";
import { varDir } from "../store.js";

const SCRIPT_NAME = process.env.MAILBOX_SIEVE_SCRIPT ?? "";
const KEEP_BACKUPS = 10;

async function loadActive(): Promise<{ name: string; items: Item[]; script: string }> {
  const active = await sieve.active();
  const name = SCRIPT_NAME || active.name || "Open-Xchange";
  const script = SCRIPT_NAME && SCRIPT_NAME !== active.name ? await sieve.get(SCRIPT_NAME).catch(() => "") : active.script;
  return { name, items: parseScript(script), script };
}

/** Keeps the previous script locally (newest KEEP_BACKUPS), then validates and stores the new one. */
async function saveScript(name: string, previous: string, items: Item[]): Promise<string> {
  const dir = join(varDir(), "sieve-backups");
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}${pad(now.getDate())}--@${pad(now.getHours())}${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const backup = join(dir, `${stamp}--${name.replace(/[^\w-]+/g, "-")}.sieve`);
  writeFileSync(backup, previous, "utf8");
  for (const old of readdirSync(dir).filter((f) => f.endsWith(".sieve")).sort().reverse().slice(KEEP_BACKUPS)) rmSync(join(dir, old));
  await sieve.put(name, serializeScript(items));
  const scripts = await sieve.list();
  if (!scripts.find((s) => s.name === name)?.active) await sieve.activate(name);
  return backup;
}

const fieldDescription = 'from, to, cc, any_recipient (to or cc), sender, subject, body, size, list_id, has_unsubscribe, or "header:<Name>" for any header';
const conditionSchema = z.object({
  field: z.string().describe(fieldDescription),
  match: z.enum(["contains", "is", "matches", "regex", "domain", "over", "under"]).default("contains").describe("contains | is | matches (wildcards * ?) | regex | domain (address fields: sender domain, e.g. amazon.com) | over / under (size, e.g. 5M)"),
  values: z.array(z.string()).min(1).describe("One or more values; any of them matches"),
  negate: z.boolean().default(false).describe("true = condition must NOT match"),
});
const actionsSchema = z.object({
  move_to: z.string().optional().describe('Folder to file into, e.g. "INBOX/newsletters", "Archive", "Trash"'),
  copy_to: z.string().optional().describe("Also file a copy into this folder"),
  add_labels: z.array(z.string()).optional().describe("Labels / categories to add (IMAP keywords)"),
  mark_read: z.boolean().optional(),
  star: z.boolean().optional(),
  color: z.enum(COLORS).optional().describe("OX color label"),
  forward_to: z.array(z.string()).optional().describe("Forward (redirect) to these addresses"),
  keep_copy_when_forwarding: z.boolean().default(true),
  discard: z.boolean().optional().describe("Silently delete (no Trash). Prefer move_to: Trash."),
  reject: z.string().optional().describe("Bounce the message back to the sender with this text (like the console blocklist). Use \"\" for a default text."),
  stop: z.boolean().default(true).describe("Stop processing later rules after this one (default true)"),
});

type ActionInput = z.infer<typeof actionsSchema>;
const toActions = (a: ActionInput): Actions => ({ ...a, color: a.color && a.color !== "none" ? COLORS.indexOf(a.color) : undefined });

async function checkFolders(a: ActionInput): Promise<ActionInput> {
  return { ...a, move_to: a.move_to ? await resolveFolder(a.move_to) : undefined, copy_to: a.copy_to ? await resolveFolder(a.copy_to) : undefined };
}

/** Same conditions as an IMAP search, for applying a new filter to existing mail. */
function conditionsToSearch(conditions: Condition[], match: "all" | "any"): SearchObject {
  const one = (c: Condition): SearchObject => {
    const alternatives = c.values.map((v): SearchObject => {
      const value = c.match === "domain" ? `@${v.replace(/^@/, "")}` : v;
      if (c.match === "regex") {
        if (!/^[\w\s.@|-]+$/.test(v)) throw new Error(`Regex "${v}" cannot be applied to existing mail (IMAP has no regex). Use contains values instead, or skip apply_to_existing.`);
      }
      switch (c.field) {
        case "from": case "sender": return { from: value };
        case "to": return { to: value };
        case "cc": return { cc: value };
        case "any_recipient": return { or: [{ to: value }, { cc: value }] };
        case "subject": return c.match === "regex" ? { or: v.split("|").map((p) => ({ subject: p.trim() })) } : { subject: value };
        case "body": return { body: value };
        case "list_id": return { header: { "list-id": value } };
        case "has_unsubscribe": return { header: { "list-unsubscribe": "" } };
        case "size": {
          const m = /^(\d+)([KMG]?)$/i.exec(v);
          const n = m ? Number(m[1]) * ({ "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[m[2].toUpperCase()] : 0;
          return c.match === "over" ? { larger: n } : { smaller: n };
        }
        default: return { header: { [c.field.replace(/^header:/, "")]: value } };
      }
    });
    const term = alternatives.length === 1 ? alternatives[0] : { or: alternatives };
    return c.negate ? { not: term } : term;
  };
  const terms = conditions.map(one);
  return match === "all" ? merge(terms) : terms.length === 1 ? terms[0] : { or: terms };
}

async function applyToExisting(conditions: Condition[], match: "all" | "any", a: ActionInput, folders: string[], max: number): Promise<string> {
  const query = conditionsToSearch(conditions, match);
  const lines: string[] = [];
  for (const name of folders) {
    const folder = await resolveFolder(name);
    const uids = (await searchUids(folder, query)).slice(0, max);
    if (!uids.length) continue;
    const range = uids.join(",");
    const flags = [...(a.mark_read ? ["\\Seen"] : []), ...(a.star ? ["\\Flagged"] : []), ...(a.color && a.color !== "none" ? [`$cl_${COLORS.indexOf(a.color)}`] : []), ...(a.add_labels ?? [])];
    await inFolder(folder, async (c) => {
      if (flags.length) await c.messageFlagsAdd(range, flags, { uid: true });
      if (a.copy_to) await c.messageCopy(range, a.copy_to, { uid: true });
      if (a.move_to && a.move_to !== folder) await c.messageMove(range, a.move_to, { uid: true });
    });
    lines.push(`${folder}: ${uids.length}`);
  }
  return lines.length ? `Applied to existing mail — ${lines.join(", ")}.` : "No existing messages matched.";
}

/** Appends one structured rule to the active script (used by other tool groups). */
export async function addFilter(name: string, conditions: Condition[], actions: ActionInput, match: "all" | "any" = "all"): Promise<string> {
  const checked = await checkFolders(actions);
  const { name: script, items, script: previous } = await loadActive();
  const need = new Set<string>();
  insertRule(items, buildRule(name, conditions, match, toActions(checked), need));
  ensureRequires(items, need);
  return saveScript(script, previous, items);
}

export function registerFilterTools(server: McpServer): void {
  server.registerTool(
    "mailbox_list_filters",
    {
      title: "List filters",
      description: "List the server-side mail filters (Sieve rules) in order, with number, name, on/off, conditions and actions. Rules run top to bottom; most end with stop. Use the number or name with the other filter tools.",
      inputSchema: z.object({ include_sieve: z.boolean().default(false).describe("Show each rule's Sieve code"), response_format: formatArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ include_sieve, response_format }) => {
      const { name, items } = await loadActive();
      const rules = listRules(items);
      return respond(response_format, { script: name, rules }, () => [
        `## ${rules.length} filters in script "${name}"`,
        ...rules.map((r) => `${r.index}. **${r.name}**${r.enabled ? "" : " _(off)_"}\n   if ${clip(r.condition.replace(/\s+/g, " "), 300)}\n   then ${r.actions.replace(/\s+/g, " ")}${include_sieve ? `\n\`\`\`sieve\n${r.sieve}\n\`\`\`` : ""}`),
      ].join("\n"));
    },
  );

  server.registerTool(
    "mailbox_create_filter",
    {
      title: "Create a filter",
      description: "Add a server-side filter that runs on all new mail (like a Gmail filter). Conditions + actions, optional position, and apply_to_existing to also sort mail already received. Example: field from, match domain, values [\"temu.com\"] -> move_to \"INBOX/my-purchases/Temu\", add_labels [\"$purchases\"]. The script is validated by the server and backed up locally before saving.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Short rule name shown in the list"),
        conditions: z.array(conditionSchema).min(1),
        match: z.enum(["all", "any"]).default("all").describe("all = every condition must match; any = one is enough"),
        actions: actionsSchema,
        position: z.number().int().min(1).optional().describe("Insert before this rule number (rules run in order). Default: after the last rule."),
        apply_to_existing: z.object({
          folders: z.array(z.string()).default(["INBOX"]),
          max: z.number().int().min(1).max(10_000).default(1000),
        }).optional().describe("Also apply move/copy/flag actions to matching mail already in these folders"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ name, conditions, match, actions, position, apply_to_existing }) => {
      const checked = await checkFolders(actions);
      const { name: script, items, script: previous } = await loadActive();
      const need = new Set<string>();
      insertRule(items, buildRule(name, conditions, match, toActions(checked), need), position);
      ensureRequires(items, need);
      const backup = await saveScript(script, previous, items);
      const applied = apply_to_existing ? ` ${await applyToExisting(conditions, match, checked, apply_to_existing.folders, apply_to_existing.max)}` : "";
      const index = listRules(items).find((r) => r.name === name)?.index;
      return text(`Filter "${name}" saved as #${index} in "${script}".${applied} Previous script backed up to ${backup}.`);
    },
  );

  server.registerTool(
    "mailbox_update_filter",
    {
      title: "Change, switch off, move or delete a filter",
      description: "Change one filter, chosen by number or name. action: enable, disable (kept but inactive), delete, move (to new position), rename, or replace (new conditions/actions, or raw Sieve code for advanced rules). Backed up locally before saving.",
      inputSchema: z.object({
        index: z.number().int().min(1).optional().describe("Rule number from mailbox_list_filters"),
        name: z.string().optional().describe("Or the exact rule name"),
        action: z.enum(["enable", "disable", "delete", "move", "rename", "replace"]),
        position: z.number().int().min(1).optional().describe("For move: new rule number"),
        new_name: z.string().optional().describe("For rename or replace"),
        conditions: z.array(conditionSchema).optional().describe("For replace"),
        match: z.enum(["all", "any"]).default("all"),
        actions: actionsSchema.optional().describe("For replace"),
        sieve: z.string().optional().describe("For replace: raw Sieve `if ... { ... }` block instead of conditions/actions"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      if (args.index === undefined && !args.name) throw new Error("Choose the filter by index or name (see mailbox_list_filters).");
      const { name: script, items, script: previous } = await loadActive();
      const item = findRule(items, args);
      const label = (item.comments.at(-1) ?? "").replace(/^#\s?/, "") || `#${args.index}`;
      const need = new Set<string>();
      switch (args.action) {
        case "enable": setEnabled(item, true); break;
        case "disable": setEnabled(item, false); break;
        case "delete": items.splice(items.indexOf(item), 1); break;
        case "rename":
          if (!args.new_name) throw new Error("rename needs new_name.");
          if (item.comments.length) item.comments[item.comments.length - 1] = `# ${args.new_name}`; else item.comments.push(`# ${args.new_name}`);
          break;
        case "move":
          if (!args.position) throw new Error("move needs position.");
          items.splice(items.indexOf(item), 1);
          insertRule(items, item, args.position);
          break;
        case "replace": {
          const newName = args.new_name ?? label;
          let replacement: Item;
          if (args.sieve) {
            replacement = { comments: [`# ${newName}`], body: args.sieve.trim() };
            for (const m of args.sieve.matchAll(/\b(fileinto|addflag|setflag|regex|body|copy|vacation|date|relational)\b/g)) need.add(m[1] === "addflag" || m[1] === "setflag" ? "imap4flags" : m[1]);
          } else {
            if (!args.conditions?.length || !args.actions) throw new Error("replace needs conditions and actions, or sieve.");
            replacement = buildRule(newName, args.conditions, args.match, toActions(await checkFolders(args.actions)), need);
          }
          items.splice(items.indexOf(item), 1, replacement);
          break;
        }
      }
      ensureRequires(items, need);
      const backup = await saveScript(script, previous, items);
      return text(`Filter "${label}": ${args.action} done. Backup of the previous script: ${backup}.`);
    },
  );

  server.registerTool(
    "mailbox_filter_script",
    {
      title: "Read or replace the whole filter script",
      description: "Advanced: action 'get' returns the full Sieve script and the list of scripts on the server; 'check' validates Sieve code without saving; 'put' replaces the whole active script (validated, backed up locally first).",
      inputSchema: z.object({ action: z.enum(["get", "check", "put"]), script: z.string().optional().describe("Sieve code for check or put") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ action, script }) => {
      if (action === "get") {
        const { name, script: body } = await loadActive();
        const all = await sieve.list();
        return text(`Scripts: ${all.map((s) => `${s.name}${s.active ? " (active)" : ""}`).join(", ")}\n\nActive script "${name}":\n\`\`\`sieve\n${body}\n\`\`\``);
      }
      if (!script) throw new Error(`${action} needs script.`);
      if (action === "check") { await sieve.check(script); return text("The script is valid."); }
      const { name, script: previous } = await loadActive();
      const backup = await saveScript(name, previous, parseScript(script));
      return text(`Replaced script "${name}". Previous version backed up to ${backup}.`);
    },
  );

  server.registerTool(
    "mailbox_set_vacation",
    {
      title: "Out-of-office auto-reply",
      description: "Turn the automatic vacation reply on or off (a Sieve rule named 'Vacation notice', placed first). Optional start/end dates limit when it answers; each sender gets at most one reply per `days`.",
      inputSchema: z.object({
        enabled: z.boolean(),
        subject: z.string().default("Out of office"),
        message: z.string().optional().describe("Reply text (required when enabling)"),
        start: z.string().optional().describe("YYYY-MM-DD first day"),
        end: z.string().optional().describe("YYYY-MM-DD last day"),
        days: z.number().int().min(1).max(30).default(7),
        addresses: z.array(z.string()).optional().describe("Your aliases that should also trigger the reply"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ enabled, subject, message, start, end, days, addresses }) => {
      const { name, items, script: previous } = await loadActive();
      const existing = items.find((it) => /^#\s*Vacation notice/i.test(it.comments.at(-1) ?? ""));
      if (existing) items.splice(items.indexOf(existing), 1);
      const need = new Set<string>(["vacation"]);
      if (enabled) {
        if (!message) throw new Error("Give the reply message.");
        const tests: string[] = [];
        if (start) { need.add("date"); need.add("relational"); tests.push(`currentdate :value "ge" "date" ${JSON.stringify(start)}`); }
        if (end) { need.add("date"); need.add("relational"); tests.push(`currentdate :value "le" "date" ${JSON.stringify(end)}`); }
        const addr = addresses?.length ? ` :addresses ${JSON.stringify(addresses)}` : "";
        const action = `vacation :days ${days}${addr} :subject ${JSON.stringify(subject)} ${JSON.stringify(message)};`;
        const body = tests.length ? `if allof ( ${tests.join(", ")} )\n{\n${action}\n}` : `if true\n{\n${action}\n}`;
        insertRule(items, { comments: ["# Vacation notice"], body }, 1);
      }
      ensureRequires(items, need);
      await saveScript(name, previous, items);
      return text(enabled ? `Vacation reply on${start || end ? ` (${start ?? "now"} to ${end ?? "until switched off"})` : ""}.` : "Vacation reply off.");
    },
  );
}
