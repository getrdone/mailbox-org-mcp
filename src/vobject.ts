/**
 * Small vCard / iCalendar content-line toolkit: unfold, parse, edit and refold,
 * keeping every property it does not touch exactly as it was.
 */

export interface Line { name: string; params: string; value: string }

export function parseLines(text: string): Line[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  return unfolded.split(/\r?\n/).filter(Boolean).map((raw) => {
    // Split at the first ":" that is not inside a quoted parameter value.
    let inQuote = false;
    let i = 0;
    for (; i < raw.length; i++) {
      if (raw[i] === '"') inQuote = !inQuote;
      if (raw[i] === ":" && !inQuote) break;
    }
    const head = raw.slice(0, i);
    const semi = head.indexOf(";");
    return { name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(), params: semi < 0 ? "" : head.slice(semi), value: raw.slice(i + 1) };
  });
}

function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export const serialize = (lines: Line[]) => `${lines.map((l) => fold(`${l.name}${l.params}:${l.value}`)).join("\r\n")}\r\n`;

export const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
export const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

export const values = (lines: Line[], name: string) => lines.filter((l) => l.name === name);
export const first = (lines: Line[], name: string) => unescapeText(values(lines, name)[0]?.value ?? "");

/** Index range [begin, end] of the first BEGIN:<component> ... END:<component> block. */
export function componentRange(lines: Line[], component: string): [number, number] {
  const begin = lines.findIndex((l) => l.name === "BEGIN" && l.value.toUpperCase() === component);
  const end = lines.findIndex((l, i) => i > begin && l.name === "END" && l.value.toUpperCase() === component);
  if (begin < 0 || end < 0) throw new Error(`No ${component} in this object.`);
  return [begin, end];
}

/** Replaces (or removes, when newLines is empty) every `name` property inside [begin, end]. */
export function replaceProperty(lines: Line[], range: [number, number], name: string, newLines: Line[]): [number, number] {
  const [begin, end] = range;
  const kept = lines.slice(begin + 1, end).filter((l) => l.name !== name);
  const inner = [...kept, ...newLines];
  lines.splice(begin + 1, end - begin - 1, ...inner);
  return [begin, begin + inner.length + 1];
}

/** iCalendar date value -> ISO-like text ("2026-11-24" or "2026-11-24T10:00:00Z" / local time with TZID). */
export function readDate(line: Line | undefined): string {
  if (!line) return "";
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(line.value);
  if (!m) return line.value;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7]) {
    // UTC time -> local time of this computer, e.g. "2026-11-28 10:00"
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const tz = /TZID=([^;:]+)/i.exec(line.params)?.[1];
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${tz ? ` (${tz})` : ""}`;
}

/** "2026-11-24" -> all-day DATE value; anything else -> UTC date-time. */
export function writeDate(name: string, input: string): Line {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return { name, params: ";VALUE=DATE", value: input.replace(/-/g, "") };
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad date/time "${input}". Use YYYY-MM-DD or an ISO time like 2026-11-24T15:00:00-08:00.`);
  return { name, params: "", value: d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "") };
}

export const nowStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
