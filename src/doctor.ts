import { config } from "./config.js";
import { accountApi } from "./api.js";
import { collections, davRequest } from "./dav.js";
import { imap } from "./imap.js";
import { sieve } from "./sieve.js";
import { verifySmtp } from "./smtp.js";
import { bytes } from "./format.js";

/** One line per service: OK or what to fix. Never prints secrets or sends mail. */
export async function checkConnections(): Promise<string> {
  const lines: string[] = [`Account: ${config.email || "(MAILBOX_EMAIL not set)"} · credentials file ${config.secretsFile}`];
  const check = async (name: string, fn: () => Promise<string>) => {
    try { lines.push(`✅ ${name}: ${await fn()}`); } catch (e) { lines.push(`❌ ${name}: ${(e as Error).message}`); }
  };
  await check("Mail (IMAP)", async () => {
    const quota = await (await imap()).getQuota("INBOX");
    return quota && quota.storage ? `signed in; ${bytes(quota.storage.usage)} of ${bytes(quota.storage.limit)} used` : "signed in";
  });
  await check("Sending (SMTP)", async () => { await verifySmtp(); return "signed in (no mail sent)"; });
  await check("Filters (ManageSieve)", async () => { const s = await sieve.list(); return `${s.length} script(s), active: ${s.find((x) => x.active)?.name ?? "none"}`; });
  await check("Contacts / calendar / tasks (CalDAV/CardDAV)", async () => {
    const books = await collections("carddav");
    const cals = await collections("caldav");
    return `${books.length} address book(s), ${cals.length} calendar/task list(s)`;
  });
  await check("Drive (WebDAV)", async () => {
    await davRequest("PROPFIND", "/servlet/webdav.infostore/", { depth: "0", body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>` });
    return "signed in";
  });
  await check("PGP private key (decrypt and sign)", async () => {
    const { privateKey } = await import("./pgp.js");
    const key = await privateKey(true);
    return `loaded ${key!.getFingerprint().toUpperCase().slice(-16)}`;
  });
  await check("Aliases and account settings (api.mailbox.org)", async () => {
    const r = await accountApi<{ aliases?: unknown[] }>("mail.get", { mail: config.email });
    return `API key works; ${r.aliases?.length ?? 0} alias(es)`;
  });
  return lines.join("\n");
}
