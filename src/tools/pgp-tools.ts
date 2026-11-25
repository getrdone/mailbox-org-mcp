import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as openpgp from "openpgp";
import * as z from "zod/v4";
import { config } from "../config.js";
import { formatArg, respond, text } from "../format.js";
import { describeKey, findKey, keyserverAllowed, listLocalKeys, localKey, privateKey, saveKey } from "../pgp.js";
import { readMessage } from "./mail.js";

export function registerPgpTools(server: McpServer): void {
  server.registerTool(
    "mailbox_pgp_keys",
    {
      title: "PGP keys",
      description: [
        "Manage PGP keys for encrypted and signed mail.",
        "status: is your private key set up (needed to decrypt and sign) and is your public key findable;",
        "list: public keys in the local keyring;",
        "lookup: find someone's key (local keyring, then their own Web Key Directory; keys.openpgp.org only with keyserver=true) and save it;",
        "import: add a key from armored text, a .asc file, or a message's key attachment (folder+uid);",
        "export_own: write your public key to a file to share.",
        "Encrypt/sign when sending with encrypt/sign on mailbox_send_message, mailbox_reply, mailbox_forward and mailbox_create_draft; mailbox_get_message decrypts and checks signatures automatically.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["status", "list", "lookup", "import", "export_own"]),
        email: z.string().optional().describe("For lookup"),
        keyserver: z.boolean().optional().describe("For lookup: also ask keys.openpgp.org (shares the address with that service)"),
        armored: z.string().optional().describe("For import: an armored public key block"),
        file: z.string().optional().describe("For import: path to a .asc/.gpg file; for export_own: where to write"),
        folder: z.string().optional().describe("For import: folder of a message carrying a key attachment"),
        uid: z.number().int().positive().optional().describe("For import: UID of that message"),
        response_format: formatArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ action, email, keyserver, armored, file, folder, uid, response_format }) => {
      switch (action) {
        case "status": {
          const own = await privateKey(false).catch((e: Error) => e);
          const published = await findKey(config.email, { keyserver: false }).catch(() => null);
          const data = {
            private_key: own instanceof Error ? { error: own.message } : own ? await describeKey(own) : null,
            public_key_found: published ? { source: published.source, ...(await describeKey(published.key)) } : null,
            keyserver_lookups_allowed_by_default: keyserverAllowed(),
          };
          return respond(response_format, data, () => [
            "## PGP status",
            own instanceof Error ? `❌ Private key: ${own.message}` : own ? `✅ Private key loaded: ${data.private_key && "fingerprint" in data.private_key ? data.private_key.fingerprint : ""}` : `⚠️ No private key set up: you can encrypt to others and verify signatures, but not decrypt mail sent to you or sign. To enable: export your key from mailbox.org (All settings > mailbox Guard), save it as a file, then set MAILBOX_PGP_PRIVATE_KEY_FILE and MAILBOX_PGP_PASSPHRASE in ${config.secretsFile}.`,
            published ? `✅ Your public key for ${config.email} is findable (${published.source}), so others can encrypt to you: ${published.key.getFingerprint().toUpperCase()}` : `⚠️ No public key found for ${config.email} in its Web Key Directory.`,
          ].join("\n"));
        }
        case "list": {
          const keys = await Promise.all(listLocalKeys().map(async (k) => ({ email: k.email, ...(await describeKey((await localKey(k.email))!)) })));
          return respond(response_format, { keys }, () => [`## ${keys.length} public keys`, ...keys.map((k) => `- ${k.email} — ${k.fingerprint.slice(-16)} · created ${k.created} · expires ${k.expires}`)].join("\n"));
        }
        case "lookup": {
          if (!email) throw new Error("lookup needs email.");
          const found = await findKey(email, { keyserver });
          if (!found) return text(`No key found for ${email} (local keyring, Web Key Directory${keyserver ? ", keys.openpgp.org" : ""}).${keyserver ? "" : " Try keyserver=true, or import a key the person sends you."}`);
          const d = await describeKey(found.key);
          return text(`Found via ${found.source} and saved: ${d.user_ids.join(", ")} — ${d.fingerprint} (created ${d.created}, expires ${d.expires}). Compare the fingerprint with the person before trusting it for sensitive mail.`);
        }
        case "import": {
          let source = armored;
          if (!source && file) {
            const path = resolve(file);
            if (!existsSync(path)) throw new Error(`No file at ${path}.`);
            source = readFileSync(path, "utf8");
          }
          if (!source && folder && uid) {
            const { m } = await readMessage(folder, uid);
            source = m.attachments.map((a) => a.content.toString("utf8")).find((t) => t.includes("BEGIN PGP PUBLIC KEY BLOCK"));
          }
          if (!source) throw new Error("import needs armored, file, or folder+uid of a message with a key attachment.");
          const keys = await openpgp.readKeys({ armoredKeys: source });
          const saved: string[] = [];
          for (const k of keys) if (!k.isPrivate()) saved.push(...(await saveKey(k as openpgp.PublicKey)));
          return text(saved.length ? `Imported keys for: ${saved.join(", ")}.` : "No public keys found in that input (private keys are never imported here).");
        }
        case "export_own": {
          const own = (await privateKey(false))?.toPublic() ?? (await findKey(config.email, { keyserver: false }))?.key;
          if (!own) throw new Error("No key of your own found (no private key set up and none published for your address).");
          const path = resolve(file ?? `${config.email.replace(/@.*/, "")}-public-key.asc`);
          writeFileSync(path, own.armor(), "utf8");
          return text(`Wrote your public key (${own.getFingerprint().toUpperCase()}) to ${path}.`);
        }
      }
    },
  );
}
