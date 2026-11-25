/**
 * Treats a Sieve script as an ordered list of items so single rules can be listed,
 * added, replaced, disabled, moved or removed while everything else is preserved.
 * A rule is a top-level `if` block; its name is the comment line directly above it.
 */

export interface Item {
  comments: string[]; // contiguous comment lines directly above the statement
  body: string; // statement text ("" for a standalone comment block)
}

export interface Rule {
  index: number; // 1-based position among rules
  name: string;
  enabled: boolean;
  condition: string;
  actions: string;
  sieve: string;
}

/** Index just past a quoted string, multi-line text: literal, or comment starting at i. */
function skipToken(s: string, i: number): number {
  if (s[i] === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === "\\") { j++; continue; }
      if (s[j] === '"') return j + 1;
    }
    return s.length;
  }
  if (s.startsWith("text:", i)) {
    const end = s.indexOf("\n.\r\n", i) >= 0 ? s.indexOf("\n.\r\n", i) + 4 : s.indexOf("\n.\n", i) >= 0 ? s.indexOf("\n.\n", i) + 3 : s.length;
    return end;
  }
  if (s[i] === "#") { const nl = s.indexOf("\n", i); return nl < 0 ? s.length : nl; }
  if (s.startsWith("/*", i)) { const e = s.indexOf("*/", i + 2); return e < 0 ? s.length : e + 2; }
  return i + 1;
}

/** End index of the statement starting at i (after ';' or the final '}' of an if/elsif/else chain). */
function statementEnd(s: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '"' || ch === "#" || s.startsWith("/*", j) || s.startsWith("text:", j)) { j = skipToken(s, j); continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const rest = s.slice(j + 1);
        const next = /^\s*(elsif|else)\b/.exec(rest);
        if (!next) return j + 1;
      }
    }
    if (ch === ";" && depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

export function parseScript(script: string): Item[] {
  const s = script.replace(/\r\n/g, "\n");
  const items: Item[] = [];
  let comments: string[] = [];
  let i = 0;
  const flush = () => { if (comments.length) items.push({ comments, body: "" }); comments = []; };
  while (i < s.length) {
    const ws = /^\s*/.exec(s.slice(i))![0];
    if ((ws.match(/\n/g)?.length ?? 0) >= 2) flush(); // blank line ends a comment block
    i += ws.length;
    if (i >= s.length) break;
    if (s[i] === "#" || s.startsWith("/*", i)) {
      const end = skipToken(s, i);
      comments.push(s.slice(i, end));
      i = end;
      continue;
    }
    const end = statementEnd(s, i);
    items.push({ comments, body: s.slice(i, end).trim() });
    comments = [];
    i = end;
  }
  flush();
  return items;
}

export function serializeScript(items: Item[]): string {
  return `${items.map((it) => [...it.comments, it.body].filter(Boolean).join("\n")).join("\n\n")}\n`;
}

const isRule = (it: Item) => /^if\b/.test(it.body);

/** Splits `if TEST { ... } [elsif/else ...]` into its test and the remainder starting at the first block. */
function splitIf(body: string): { test: string; gap: string; rest: string } {
  for (let j = 2; j < body.length; j++) {
    const ch = body[j];
    if (ch === '"' || ch === "#" || body.startsWith("text:", j)) { j = skipToken(body, j) - 1; continue; }
    if (ch === "{") {
      const raw = body.slice(2, j).trimStart();
      const test = raw.trimEnd();
      return { test, gap: raw.slice(test.length) || " ", rest: body.slice(j) };
    }
  }
  return { test: body.slice(2).trim(), gap: " ", rest: "" };
}

const DISABLED = /^allof\s*\(\s*false\s*,\s*([\s\S]*)\)$/;
const nameOf = (it: Item) => (it.comments.at(-1) ?? "").replace(/^#\s?|^\/\*\s*|\s*\*\/$/g, "").trim();

export function listRules(items: Item[]): Rule[] {
  return items.filter(isRule).map((it, k) => {
    const { test, rest } = splitIf(it.body);
    const disabled = DISABLED.exec(test);
    return {
      index: k + 1,
      name: nameOf(it) || `(unnamed rule ${k + 1})`,
      enabled: !disabled,
      condition: disabled ? disabled[1].trim() : test,
      actions: rest.replace(/^\{\s*|\s*\}$/g, "").trim(),
      sieve: [...it.comments, it.body].join("\n"),
    };
  });
}

/** Finds a rule by 1-based index or exact (case-insensitive) name. */
export function findRule(items: Item[], ref: { index?: number; name?: string }): Item {
  const rules = items.filter(isRule);
  const hit = ref.index !== undefined ? rules[ref.index - 1] : rules.find((it) => nameOf(it).toLowerCase() === ref.name?.trim().toLowerCase());
  if (!hit) throw new Error(`No filter ${ref.index !== undefined ? `#${ref.index}` : `named "${ref.name}"`}. Use mailbox_list_filters for indexes and names.`);
  return hit;
}

export function setEnabled(it: Item, enabled: boolean): void {
  const { test, gap, rest } = splitIf(it.body);
  const disabled = DISABLED.exec(test);
  if (enabled && disabled) it.body = `if ${disabled[1].trim()}${gap}${rest}`;
  if (!enabled && !disabled) it.body = `if allof ( false, ${test} )${gap}${rest}`;
}

/** Ensures the script's require list includes the given extensions. */
export function ensureRequires(items: Item[], needed: Set<string>): void {
  if (!needed.size) return;
  const req = items.find((it) => /^require\b/.test(it.body));
  const existing = new Set<string>(req ? [...req.body.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []);
  const all = [...new Set([...existing, ...needed])];
  const body = `require [ ${all.map((x) => JSON.stringify(x)).join(" , ")} ];`;
  if (req) req.body = body;
  else items.unshift({ comments: [], body });
}

// ---------- Building rules from structured conditions and actions ----------

export type Field = "from" | "to" | "cc" | "any_recipient" | "sender" | "subject" | "body" | "size" | "list_id" | "has_unsubscribe" | `header:${string}`;
export type Match = "contains" | "is" | "matches" | "regex" | "domain" | "over" | "under";

export interface Condition { field: string; match: Match; values: string[]; negate?: boolean }
export interface Actions {
  move_to?: string;
  copy_to?: string;
  add_labels?: string[];
  mark_read?: boolean;
  star?: boolean;
  color?: number;
  forward_to?: string[];
  keep_copy_when_forwarding?: boolean;
  discard?: boolean;
  reject?: string;
  stop?: boolean;
}

const q = (v: string) => JSON.stringify(v);
const qlist = (vs: string[]) => (vs.length === 1 ? q(vs[0]) : `[ ${vs.map(q).join(", ")} ]`);

export function buildTest(c: Condition, need: Set<string>): string {
  const comparator = c.match === "regex" ? (need.add("regex"), ":regex") : c.match === "domain" ? ":domain :is" : `:${c.match}`;
  let test: string;
  const addressField: Record<string, string> = { from: q("from"), to: q("to"), cc: q("cc"), sender: q("sender"), any_recipient: `[ "to", "cc" ]` };
  if (c.field === "size") {
    if (c.match !== "over" && c.match !== "under") throw new Error("size needs match 'over' or 'under' with a value like 5M.");
    test = `size :${c.match} ${c.values[0].toUpperCase()}`;
  } else if (c.field === "has_unsubscribe") {
    test = `exists "list-unsubscribe"`;
  } else if (c.field === "body") {
    need.add("body");
    test = `body :text ${comparator} ${qlist(c.values)}`;
  } else if (addressField[c.field]) {
    if (c.match === "domain") test = `address :domain :is ${addressField[c.field]} ${qlist(c.values.map((v) => v.replace(/^@/, "")))}`;
    else test = `address ${comparator} ${addressField[c.field]} ${qlist(c.values)}`;
  } else {
    const header = c.field === "subject" ? "subject" : c.field === "list_id" ? "list-id" : c.field.replace(/^header:/, "");
    if (c.match === "domain" || c.match === "over" || c.match === "under") throw new Error(`match '${c.match}' does not apply to ${c.field}.`);
    test = `header ${comparator} ${q(header)} ${qlist(c.values)}`;
  }
  return c.negate ? `not ${test}` : test;
}

export function buildActions(a: Actions, need: Set<string>): string[] {
  const lines: string[] = [];
  const flags: string[] = [];
  if (a.mark_read) flags.push("\\\\Seen");
  if (a.star) flags.push("\\\\Flagged");
  if (a.color) flags.push(`$cl_${a.color}`);
  flags.push(...(a.add_labels ?? []).map((l) => l.trim().replace(/\s+/g, "-")));
  if (flags.length) { need.add("imap4flags"); lines.push(`addflag [ ${flags.map((f) => `"${f}"`).join(", ")} ];`); }
  for (const to of a.forward_to ?? []) {
    if (a.keep_copy_when_forwarding !== false) { need.add("copy"); lines.push(`redirect :copy ${q(to)};`); } else lines.push(`redirect ${q(to)};`);
  }
  if (a.copy_to) { need.add("fileinto"); need.add("copy"); lines.push(`fileinto :copy ${q(a.copy_to)};`); }
  if (a.reject !== undefined) { need.add("reject"); lines.push(`reject ${q(a.reject || "Message rejected by recipient.")};`); }
  else if (a.discard) lines.push("discard;");
  else if (a.move_to) { need.add("fileinto"); lines.push(`fileinto ${q(a.move_to)};`); }
  if (a.stop !== false) lines.push("stop;");
  if (!lines.filter((l) => l !== "stop;").length) throw new Error("A filter needs at least one action (move_to, copy_to, add_labels, mark_read, star, color, forward_to, reject or discard).");
  return lines;
}

export function buildRule(name: string, conditions: Condition[], match: "all" | "any", actions: Actions, need: Set<string>): Item {
  if (!conditions.length) throw new Error("A filter needs at least one condition.");
  const tests = conditions.map((c) => buildTest(c, need));
  const test = tests.length === 1 ? tests[0] : `${match === "all" ? "allof" : "anyof"} ( ${tests.join(", ")} )`;
  return { comments: [`# ${name.replace(/\n/g, " ")}`], body: `if ${test}\n{\n${buildActions(actions, need).join("\n")}\n}` };
}

/** Inserts a rule item before the rule at 1-based `position`, or after the last rule when omitted. */
export function insertRule(items: Item[], rule: Item, position?: number): void {
  const ruleItems = items.filter(isRule);
  if (position !== undefined && position <= ruleItems.length) {
    items.splice(items.indexOf(ruleItems[Math.max(position, 1) - 1]), 0, rule);
    return;
  }
  const last = ruleItems.at(-1);
  items.splice(last ? items.indexOf(last) + 1 : items.length, 0, rule);
}
