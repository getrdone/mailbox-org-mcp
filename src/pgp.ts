import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as openpgp from "openpgp";
import { config } from "./config.js";
import { varDir } from "./store.js";

/**
 * OpenPGP for mail: keyring of public keys (local folder), lookup through the
 * recipient's own Web Key Directory (and keys.openpgp.org only when allowed),
 * your private key from a local file, and PGP/MIME (RFC 3156) build/parse helpers.
 */

const keyDir = () => { const d = join(varDir(), "pgp", "public"); mkdirSync(d, { recursive: true }); return d; };
const fileFor = (email: string) => join(keyDir(), `${email.toLowerCase().replace(/[^\w.@+-]/g, "_")}.asc`);
const emailOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

// ---------- Web Key Directory ----------

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
function zbase32(buf: Buffer): string {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += ZBASE32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

async function fetchKey(url: string): Promise<openpgp.PublicKey | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = Buffer.from(bytes).toString("utf8");
    return text.includes("BEGIN PGP PUBLIC KEY")
      ? await openpgp.readKey({ armoredKey: text })
      : await openpgp.readKey({ binaryKey: bytes });
  } catch { return null; }
}

/** Web Key Directory lookup: asks only the recipient's own mail domain. */
export async function wkdLookup(email: string): Promise<openpgp.PublicKey | null> {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return null;
  const hash = zbase32(createHash("sha1").update(local).digest());
  const l = encodeURIComponent(local);
  return (await fetchKey(`https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${l}`))
    ?? (await fetchKey(`https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${l}`));
}

/** keys.openpgp.org lookup: a third party learns the address, so only when allowed. */
export async function keyserverLookup(email: string): Promise<openpgp.PublicKey | null> {
  return fetchKey(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`);
}

export const keyserverAllowed = () => process.env.MAILBOX_PGP_KEYSERVER === "1";

// ---------- Keyring ----------

export async function saveKey(key: openpgp.PublicKey): Promise<string[]> {
  const emails = key.getUserIDs().map(emailOf).filter((e) => e.includes("@"));
  for (const e of emails) writeFileSync(fileFor(e), key.armor(), "utf8");
  return emails;
}

export async function localKey(email: string): Promise<openpgp.PublicKey | null> {
  const f = fileFor(emailOf(email));
  return existsSync(f) ? openpgp.readKey({ armoredKey: readFileSync(f, "utf8") }) : null;
}

/** Local keyring, then WKD, then (if allowed) keys.openpgp.org; found keys are cached locally. */
export async function findKey(email: string, opts: { keyserver?: boolean } = {}): Promise<{ key: openpgp.PublicKey; source: string } | null> {
  const address = emailOf(email);
  const local = await localKey(address);
  if (local) return { key: local, source: "local keyring" };
  const wkd = await wkdLookup(address);
  if (wkd) { await saveKey(wkd); return { key: wkd, source: "Web Key Directory" }; }
  if (opts.keyserver ?? keyserverAllowed()) {
    const ks = await keyserverLookup(address);
    if (ks) { await saveKey(ks); return { key: ks, source: "keys.openpgp.org" }; }
  }
  return null;
}

export function listLocalKeys(): { file: string; email: string }[] {
  return readdirSync(keyDir()).filter((f) => f.endsWith(".asc")).map((f) => ({ file: join(keyDir(), f), email: f.replace(/\.asc$/, "") }));
}

export async function describeKey(key: openpgp.PublicKey | openpgp.PrivateKey) {
  const expiry = await key.getExpirationTime().catch(() => null);
  return {
    fingerprint: key.getFingerprint().toUpperCase(),
    user_ids: key.getUserIDs(),
    created: key.getCreationTime().toISOString().slice(0, 10),
    expires: expiry instanceof Date ? expiry.toISOString().slice(0, 10) : expiry === Infinity ? "never" : "unknown",
    algorithm: key.getAlgorithmInfo().algorithm,
  };
}

// ---------- Your private key ----------

let ownKey: openpgp.PrivateKey | null = null;

/** Your decrypted private key from MAILBOX_PGP_PRIVATE_KEY_FILE (+ MAILBOX_PGP_PASSPHRASE), or null if not set up. */
export async function privateKey(required = false): Promise<openpgp.PrivateKey | null> {
  if (ownKey) return ownKey;
  const file = process.env.MAILBOX_PGP_PRIVATE_KEY_FILE;
  if (!file || !existsSync(file)) {
    if (required) throw new Error(`No private PGP key set up. Export your key from mailbox.org (All settings > mailbox Guard > download private key) to a file, then set MAILBOX_PGP_PRIVATE_KEY_FILE=<path> and MAILBOX_PGP_PASSPHRASE=... in ${config.secretsFile} and restart.`);
    return null;
  }
  let key = await openpgp.readPrivateKey({ armoredKey: readFileSync(file, "utf8") });
  if (!key.isDecrypted()) {
    const passphrase = process.env.MAILBOX_PGP_PASSPHRASE;
    if (!passphrase) throw new Error(`The private key in ${file} is protected; set MAILBOX_PGP_PASSPHRASE in ${config.secretsFile}.`);
    key = await openpgp.decryptKey({ privateKey: key, passphrase });
  }
  ownKey = key;
  return key;
}

// ---------- PGP/MIME ----------

/** Splits a raw message into header block and body (CRLF normalized). */
export function splitMessage(raw: Buffer | string): { head: string; body: string } {
  const text = raw.toString().replace(/\r?\n/g, "\r\n");
  const i = text.indexOf("\r\n\r\n");
  return i < 0 ? { head: text, body: "" } : { head: text.slice(0, i), body: text.slice(i + 4) };
}

const headerLines = (head: string) => head.split(/\r\n(?![ \t])/);
const isContentHeader = (line: string) => /^content-/i.test(line);
const boundary = () => `----=_pgp_${createHash("sha1").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 24)}`;

/** The MIME entity (Content-* headers + body) of a composed message, which is what gets signed or encrypted. */
export function innerEntity(raw: Buffer): string {
  const { head, body } = splitMessage(raw);
  return `${headerLines(head).filter(isContentHeader).join("\r\n")}\r\n\r\n${body}`;
}

/** Rebuilds the message with the outer headers kept and a new Content-Type + body. */
function rewrap(raw: Buffer, contentType: string, body: string): Buffer {
  const { head } = splitMessage(raw);
  const outer = headerLines(head).filter((l) => !isContentHeader(l)).join("\r\n");
  return Buffer.from(`${outer}\r\nContent-Type: ${contentType}\r\n\r\n${body}`, "utf8");
}

/** Signs and/or encrypts a composed message as PGP/MIME. Encryption includes your own key so Sent copies stay readable. */
export async function protect(raw: Buffer, opts: { encrypt: boolean; sign: boolean; recipients: string[]; sender: string; keyserver?: boolean }): Promise<{ raw: Buffer; note: string }> {
  const signingKey = opts.sign ? await privateKey(true) : null;
  const entity = innerEntity(raw);
  if (opts.encrypt) {
    const keys: openpgp.PublicKey[] = [];
    const missing: string[] = [];
    for (const r of [...new Set(opts.recipients.map(emailOf))]) {
      const found = await findKey(r, { keyserver: opts.keyserver });
      if (found) keys.push(found.key); else missing.push(r);
    }
    if (missing.length) throw new Error(`No PGP key found for ${missing.join(", ")} (checked local keyring and their Web Key Directory${opts.keyserver ?? keyserverAllowed() ? " and keys.openpgp.org" : "; keys.openpgp.org not asked"}). Import their key with mailbox_pgp_keys, or send unencrypted.`);
    const self = signingKey?.toPublic() ?? (await findKey(opts.sender))?.key;
    if (self) keys.push(self);
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ binary: Buffer.from(entity, "utf8") }),
      encryptionKeys: keys,
      ...(signingKey ? { signingKeys: signingKey } : {}),
    });
    const b = boundary();
    const body = [
      "This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
      `--${b}`, "Content-Type: application/pgp-encrypted", "Content-Description: PGP/MIME version identification", "", "Version: 1", "",
      `--${b}`, 'Content-Type: application/octet-stream; name="encrypted.asc"', "Content-Description: OpenPGP encrypted message", 'Content-Disposition: inline; filename="encrypted.asc"', "", String(armored), "",
      `--${b}--`, "",
    ].join("\r\n");
    return { raw: rewrap(raw, `multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, body), note: `encrypted for ${keys.length} key(s)${signingKey ? " and signed" : ""}${self ? "" : " (no key of your own found, so the Sent copy is not readable)"}` };
  }
  if (signingKey) {
    const signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: Buffer.from(entity, "utf8") }), signingKeys: signingKey, detached: true });
    const b = boundary();
    const body = [
      "This is an OpenPGP/MIME signed message (RFC 4880 and 3156)",
      `--${b}`, entity, `--${b}`, 'Content-Type: application/pgp-signature; name="signature.asc"', "Content-Description: OpenPGP digital signature", 'Content-Disposition: attachment; filename="signature.asc"', "", String(signature), `--${b}--`, "",
    ].join("\r\n");
    return { raw: rewrap(raw, `multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="${b}"`, body), note: "signed" };
  }
  return { raw, note: "" };
}

const boundaryOf = (head: string) => /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1];

/**
 * Detects PGP in a raw message. Encrypted (PGP/MIME or inline) is decrypted with your key;
 * signatures are checked against the sender's key. Returns the readable inner MIME or text.
 */
export async function unprotect(raw: Buffer, sender: string): Promise<null | { kind: "encrypted" | "signed"; inner?: string; text?: string; signature: string }> {
  const { head, body } = splitMessage(raw);
  const contentType = headerLines(head).find((l) => /^content-type:/i.test(l)) ?? "";
  const signer = async () => (await findKey(sender))?.key;
  const verdict = async (sigs: { verified: Promise<boolean>; keyID: { toHex(): string } }[] | undefined, haveKey: boolean) => {
    if (!sigs?.length) return "not signed";
    if (!haveKey) return `signed, but no key found for ${emailOf(sender)} to check it`;
    try { await sigs[0].verified; return `valid signature from ${emailOf(sender)}`; } catch (e) { return `INVALID signature (${(e as Error).message})`; }
  };

  const armored = /-----BEGIN PGP MESSAGE-----[\s\S]+?-----END PGP MESSAGE-----/.exec(raw.toString())?.[0];
  if (/multipart\/encrypted/i.test(contentType) || armored) {
    if (!armored) return null;
    const key = await privateKey(true);
    const verifyKey = await signer();
    const result = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: key!,
      ...(verifyKey ? { verificationKeys: verifyKey } : {}),
      format: "binary",
    });
    const plain = Buffer.from(result.data as Uint8Array).toString("utf8");
    const isMime = /multipart\/encrypted/i.test(contentType) || /^content-type:/im.test(plain.slice(0, 500));
    return { kind: "encrypted", ...(isMime ? { inner: plain } : { text: plain }), signature: await verdict(result.signatures as never, Boolean(verifyKey)) };
  }

  if (/multipart\/signed/i.test(contentType) && /pgp-signature/i.test(contentType)) {
    const b = boundaryOf(contentType);
    if (!b) return null;
    const parts = body.split(`--${b}`);
    // parts[1] is "\r\n<entity>\r\n"; the signed bytes exclude the CRLF that precedes the next boundary.
    const entity = parts[1]?.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const sigArmored = /-----BEGIN PGP SIGNATURE-----[\s\S]+?-----END PGP SIGNATURE-----/.exec(parts[2] ?? "")?.[0];
    if (!entity || !sigArmored) return null;
    const verifyKey = await signer();
    if (!verifyKey) return { kind: "signed", inner: entity, signature: `signed, but no key found for ${emailOf(sender)} to check it` };
    const v = await openpgp.verify({ message: await openpgp.createMessage({ binary: Buffer.from(entity, "utf8") }), signature: await openpgp.readSignature({ armoredSignature: sigArmored }), verificationKeys: verifyKey });
    return { kind: "signed", inner: entity, signature: await verdict(v.signatures as never, true) };
  }
  return null;
}
