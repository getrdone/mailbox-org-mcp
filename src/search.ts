import type { SearchObject } from "imapflow";
import { COLORS } from "./imap.js";

/**
 * Translates a Gmail-style query into an IMAP search.
 *   from:amazon to:me subject:"order shipped" -label:done is:unread has:attachment
 *   newer_than:7d older_than:1y after:2026-01-01 before:2026-02-01 on:2026-03-04
 *   larger:5M smaller:100K label:$purchases color:red is:starred has:unsubscribe list:github
 *   (a OR b)   -word   "exact phrase"   bare words search headers and body
 * Returns the IMAP query plus any in:folder names found in the text.
 */
export function parseQuery(input: string): { query: SearchObject; folders: string[] } {
  const tokens = tokenize(input);
  const folders: string[] = [];
  let pos = 0;

  const parseOr = (): SearchObject[] => {
    const alternatives: SearchObject[][] = [parseAnd()];
    while (tokens[pos] === "OR") { pos++; alternatives.push(parseAnd()); }
    if (alternatives.length === 1) return alternatives[0];
    return [{ or: alternatives.map(merge) }];
  };
  const parseAnd = (): SearchObject[] => {
    const terms: SearchObject[] = [];
    while (pos < tokens.length && tokens[pos] !== ")" && tokens[pos] !== "OR") {
      const t = tokens[pos++];
      if (t === "(" || t === "-(") {
        const inner = merge(parseOr());
        if (tokens[pos] === ")") pos++;
        terms.push(t === "-(" ? { not: inner } : inner);
        continue;
      }
      const negate = t.startsWith("-") && t.length > 1;
      const term = termToSearch(negate ? t.slice(1) : t, folders);
      if (term) terms.push(negate ? { not: term } : term);
    }
    return terms;
  };

  const query = merge(parseOr());
  return { query: Object.keys(query).length ? query : { all: true }, folders };
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /\s*(-?\(|\)|-?[\w.$]+:"[^"]*"|-?"[^"]*"|[^\s()]+)/g;
  for (const m of input.matchAll(re)) out.push(m[1]);
  return out;
}

/**
 * ANDs terms into one search object. An imapflow object ANDs its keys, so terms with
 * distinct keys are simply combined; a repeated key (two from: terms, two negations)
 * is ANDed with De Morgan's law: A AND B = NOT (OR (NOT A) (NOT B)).
 */
export function merge(terms: SearchObject[]): SearchObject {
  let result: SearchObject = {};
  for (const term of terms) {
    if (!Object.keys(result).length) result = { ...term };
    else if (Object.keys(term).some((k) => k in result)) result = { not: { or: [{ not: result }, { not: term }] } };
    else result = { ...result, ...term };
  }
  return result;
}

const unquote = (s: string) => s.replace(/^"|"$/g, "");

function relativeDate(spec: string): Date {
  const m = /^(\d+)([dwmy])$/i.exec(spec);
  if (!m) throw new Error(`Bad relative date "${spec}". Use forms like 7d, 3w, 2m, 1y.`);
  const n = Number(m[1]);
  const d = new Date();
  const unit = m[2].toLowerCase();
  if (unit === "d") d.setDate(d.getDate() - n);
  if (unit === "w") d.setDate(d.getDate() - 7 * n);
  if (unit === "m") d.setMonth(d.getMonth() - n);
  if (unit === "y") d.setFullYear(d.getFullYear() - n);
  return d;
}

function absoluteDate(spec: string): Date {
  const d = new Date(spec.replace(/\//g, "-"));
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date "${spec}". Use YYYY-MM-DD.`);
  return d;
}

function sizeBytes(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(spec);
  if (!m) throw new Error(`Bad size "${spec}". Use forms like 500K, 5M, 1G.`);
  return Math.round(Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "" | "k" | "m" | "g"]);
}

function keywordFor(value: string): string {
  const color = COLORS.indexOf(value.toLowerCase() as (typeof COLORS)[number]);
  if (color > 0) return `$cl_${color}`;
  if (/^\d+$/.test(value)) return `$cl_${value}`;
  return value;
}

function termToSearch(token: string, folders: string[]): SearchObject | null {
  const colon = token.indexOf(":");
  if (colon < 1 || token.startsWith('"')) return { text: unquote(token) };
  const key = token.slice(0, colon).toLowerCase();
  const value = unquote(token.slice(colon + 1));
  switch (key) {
    case "from": return { from: value };
    case "to": return { to: value };
    case "cc": return { cc: value };
    case "bcc": return { bcc: value };
    case "subject": return { subject: value };
    case "body": return { body: value };
    case "text": return { text: value };
    case "list": return { header: { "list-id": value } };
    case "header": {
      const [name, ...rest] = value.split("=");
      return { header: { [name]: rest.join("=") } };
    }
    case "label": case "keyword": case "category": return { keyword: keywordFor(value) };
    case "color": return { keyword: keywordFor(value) };
    case "in": folders.push(value); return null;
    case "after": case "since": return { since: absoluteDate(value) };
    case "before": return { before: absoluteDate(value) };
    case "on": return { on: absoluteDate(value) };
    case "newer_than": case "newer": return { since: relativeDate(value) };
    case "older_than": case "older": return { before: relativeDate(value) };
    case "larger": return { larger: sizeBytes(value) };
    case "smaller": return { smaller: sizeBytes(value) };
    case "is":
      switch (value.toLowerCase()) {
        case "unread": return { seen: false };
        case "read": return { seen: true };
        case "starred": case "flagged": return { flagged: true };
        case "unstarred": return { flagged: false };
        case "answered": case "replied": return { answered: true };
        case "draft": return { draft: true };
        case "forwarded": return { keyword: "$Forwarded" };
        default: throw new Error(`Unknown is:${value}. Use unread, read, starred, answered, draft, forwarded.`);
      }
    case "has":
      switch (value.toLowerCase()) {
        case "attachment": case "attachments": return { or: [{ keyword: "$HasAttachment" }, { header: { "content-type": "multipart/mixed" } }] };
        case "unsubscribe": case "newsletter": return { header: { "list-unsubscribe": "" } };
        case "color": return { or: COLORS.slice(1).map((_, i) => ({ keyword: `$cl_${i + 1}` })) };
        default: throw new Error(`Unknown has:${value}. Use attachment, unsubscribe or color.`);
      }
    default:
      return { text: token };
  }
}
