// Self-check: start the built server over stdio, list tools, optionally call tools.
// Usage: node scripts/smoke.mjs                      -> list tools
//        node scripts/smoke.mjs TOOL '{"arg":1}' ... -> call each tool with its JSON args
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Pass the full environment: the SDK otherwise forwards only a few variables, so MAILBOX_STATE_DIR etc. would be ignored.
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "pipe", env: { ...process.env } });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
const bad = tools.filter((t) => !t.description || !t.annotations);
if (bad.length) console.log(`Missing description/annotations: ${bad.map((t) => t.name).join(", ")}`);

const calls = process.argv.slice(2);
for (let i = 0; i < calls.length; i += 2) {
  const name = calls[i];
  const args = calls[i + 1] ? JSON.parse(calls[i + 1]) : {};
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const body = result.content.map((c) => c.text ?? "").join("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${result.isError ? " ERROR" : ""}\n${body.slice(0, Number(process.env.SMOKE_CHARS ?? 2500))}`);
}
await client.close();
