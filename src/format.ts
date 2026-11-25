import * as z from "zod/v4";

export const CHARACTER_LIMIT = 25_000;

export const formatArg = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("'markdown' for readable text (default), 'json' for complete structured data");

export type Format = z.infer<typeof formatArg>;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> };

/** Returns markdown text or JSON (with structuredContent) for one result object. */
export function respond(format: Format, data: Record<string, unknown>, markdown: () => string): ToolResult {
  if (format === "json") return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  return { content: [{ type: "text", text: markdown() }] };
}

export const text = (message: string): ToolResult => ({ content: [{ type: "text", text: message }] });

/**
 * Renders a page of items, halving the page until it fits CHARACTER_LIMIT.
 * Items are never cut mid-text; next_offset points at the first item left out.
 */
export function respondPage<T>(
  format: Format,
  items: T[],
  page: { offset: number; total: number },
  key: string,
  renderItem: (item: T) => string,
  heading: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  let shown = items;
  for (;;) {
    const next = page.offset + shown.length;
    const hasMore = page.total > next;
    const data = { total: page.total, count: shown.length, offset: page.offset, has_more: hasMore, ...(hasMore ? { next_offset: next } : {}), ...extra, [key]: shown };
    const result = respond(format, data, () => {
      const lines = [heading, "", ...shown.map(renderItem)];
      if (!shown.length) lines.push("_No results._");
      if (hasMore) lines.push("", `Showing ${page.offset + 1}-${next} of ${page.total}. More results: call again with offset=${next}.`);
      return lines.join("\n");
    });
    if (shown.length <= 1 || result.content[0].text.length <= CHARACTER_LIMIT) return result;
    shown = shown.slice(0, Math.ceil(shown.length / 2));
  }
}

export function bytes(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function shortDate(d: Date | string | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? String(d) : date.toISOString().slice(0, 16).replace("T", " ");
}

/** Truncates a single field (not a whole response) for list views. */
export const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
