import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Tool-owned state folder (alias register, filter backups). */
export function varDir(): string {
  const dir = process.env.MAILBOX_STATE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "var");
  mkdirSync(dir, { recursive: true });
  return dir;
}

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(join(varDir(), "mailbox-org-mcp.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS aliases (
      address        TEXT PRIMARY KEY COLLATE NOCASE,
      kind           TEXT NOT NULL DEFAULT 'permanent' CHECK (kind IN ('permanent','temporary')),
      purpose        TEXT NOT NULL DEFAULT '',
      created_at     TEXT,
      expires_at     TEXT,          -- YYYY-MM-DD, temporary aliases only
      remind_days    INTEGER NOT NULL DEFAULT 7,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','removed')),
      on_server      INTEGER NOT NULL DEFAULT 1,
      last_mail_at   TEXT,
      mail_count_90d INTEGER,
      last_reminded  TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export interface AliasRow {
  address: string;
  kind: "permanent" | "temporary";
  purpose: string;
  created_at: string | null;
  expires_at: string | null;
  remind_days: number;
  status: "active" | "expired" | "removed";
  on_server: number;
  last_mail_at: string | null;
  mail_count_90d: number | null;
  last_reminded: string | null;
  updated_at: string;
}

export const aliasStore = {
  all(): AliasRow[] {
    return open().prepare("SELECT * FROM aliases ORDER BY status, kind DESC, expires_at, address").all() as unknown as AliasRow[];
  },
  get(address: string): AliasRow | undefined {
    return open().prepare("SELECT * FROM aliases WHERE address = ?").get(address) as unknown as AliasRow | undefined;
  },
  /** Removes an entry from the register entirely (mistakes, tests). */
  forget(address: string): boolean {
    return Number(open().prepare("DELETE FROM aliases WHERE address = ?").run(address).changes) > 0;
  },
  /** Inserts or updates the given fields only. */
  upsert(address: string, fields: Partial<Omit<AliasRow, "address" | "updated_at">>): AliasRow {
    const d = open();
    d.prepare("INSERT OR IGNORE INTO aliases (address, created_at) VALUES (?, date('now'))").run(address);
    const keys = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
    if (keys.length) {
      d.prepare(`UPDATE aliases SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE address = ?`)
        .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k]), address);
    }
    return this.get(address)!;
  },
};

/** Days from today (local) until a YYYY-MM-DD date; negative when past. */
export function daysUntil(date: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86_400_000);
}

/** YYYY-MM-DD in local time (toISOString would give the UTC date, a day ahead in the evening). */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(date: string | Date, days: number): string {
  const d = typeof date === "string" ? new Date(`${date}T00:00:00`) : new Date(date);
  d.setDate(d.getDate() + days);
  return localDate(d);
}
