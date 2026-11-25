// Offline checks for the query parser, Sieve rule editor and vCard/iCal helpers.
// node scripts/test.mjs          offline only
// node scripts/test.mjs --live   also round-trips the real filter script through the server's CHECKSCRIPT (saves nothing)
import assert from "node:assert/strict";
import { parseQuery } from "../dist/search.js";
import { buildRule, ensureRequires, insertRule, listRules, parseScript, serializeScript, setEnabled } from "../dist/rules.js";
import { componentRange, parseLines, replaceProperty, serialize } from "../dist/vobject.js";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

test("simple query", () => assert.deepEqual(parseQuery("from:amazon is:unread").query, { from: "amazon", seen: false }));
test("repeated key is ANDed", () => {
  const q = parseQuery("from:a from:b").query;
  assert.deepEqual(q, { not: { or: [{ not: { from: "a" } }, { not: { from: "b" } }] } });
});
test("OR group and negation", () => {
  const { query } = parseQuery("(from:a OR from:b) -label:done");
  assert.deepEqual(query, { or: [{ from: "a" }, { from: "b" }], not: { keyword: "done" } });
});
test("in: collects folders", () => assert.deepEqual(parseQuery('in:Archive subject:"big news"'), { query: { subject: "big news" }, folders: ["Archive"] }));
test("color and size", () => assert.deepEqual(parseQuery("color:red larger:5M").query, { keyword: "$cl_1", larger: 5 * 1024 * 1024 }));
test("empty query = all", () => assert.deepEqual(parseQuery("").query, { all: true }));

const sample = `# Generated
require [ "fileinto" ];
# Note at top

# Rule one
if address :is "from" "a@x.org"
{
fileinto "INBOX/a";
stop;
}

# Rule two; with "quotes" {braces}
if header :contains "subject" "x { y ; z"
{
keep;
}
elsif true { discard; }
`;
test("parse rules with braces and semicolons in strings", () => {
  const rules = listRules(parseScript(sample));
  assert.equal(rules.length, 2);
  assert.equal(rules[1].name, 'Rule two; with "quotes" {braces}');
  assert.match(rules[1].sieve, /elsif true/);
});
test("round trip keeps all statements", () => {
  const again = parseScript(serializeScript(parseScript(sample)));
  assert.equal(listRules(again).length, 2);
  assert.equal(again.filter((i) => i.body.startsWith("require")).length, 1);
});
test("disable / enable", () => {
  const items = parseScript(sample);
  const rule = items.find((i) => i.body.startsWith("if address"));
  setEnabled(rule, false);
  assert.equal(listRules(items)[0].enabled, false);
  setEnabled(rule, true);
  assert.equal(listRules(items)[0].enabled, true);
  assert.equal(rule.body.split("\n")[0], 'if address :is "from" "a@x.org"');
});
test("build and insert rule with requires", () => {
  const items = parseScript(sample);
  const need = new Set();
  const rule = buildRule("Shops", [{ field: "from", match: "domain", values: ["temu.com"] }, { field: "subject", match: "regex", values: ["order|ship"] }], "all", { move_to: "INBOX/shop", add_labels: ["$purchases"], mark_read: true }, need);
  insertRule(items, rule, 1);
  ensureRequires(items, need);
  const out = serializeScript(items);
  assert.match(out, /require \[ "fileinto" , "regex" , "imap4flags" \];/);
  assert.match(out, /# Shops\nif allof \( address :domain :is "from" "temu.com", header :regex "subject" "order\|ship" \)/);
  assert.match(out, /addflag \[ "\\\\Seen", "\$purchases" \];/);
  assert.equal(listRules(parseScript(out))[0].name, "Shops");
});
test("vCard property replace keeps other lines", () => {
  const lines = parseLines("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann\r\nX-CUSTOM:keep\r\nEMAIL:a@x.org\r\nEND:VCARD\r\n");
  replaceProperty(lines, componentRange(lines, "VCARD"), "EMAIL", [{ name: "EMAIL", params: ";TYPE=INTERNET", value: "b@y.org" }]);
  const out = serialize(lines);
  assert.match(out, /X-CUSTOM:keep/);
  assert.match(out, /EMAIL;TYPE=INTERNET:b@y.org/);
  assert.doesNotMatch(out, /a@x.org/);
});

if (process.argv.includes("--live")) {
  const { sieve } = await import("../dist/sieve.js");
  const active = await sieve.active();
  const items = parseScript(active.script);
  const roundTrip = serializeScript(items);
  const squash = (s) => s.replace(/\s+/g, "");
  assert.equal(squash(roundTrip), squash(active.script), "round trip changed more than whitespace");
  await sieve.check(roundTrip);
  const need = new Set();
  insertRule(items, buildRule("Test rule (not saved)", [{ field: "has_unsubscribe", match: "contains", values: ["x"] }, { field: "body", match: "contains", values: ["sale"] }], "all", { move_to: "INBOX/newsletters", color: 3, forward_to: ["x@example.org"] }, need), 2);
  ensureRequires(items, need);
  await sieve.check(serializeScript(items));
  passed++;
  console.log(`ok - live: ${listRules(items).length - 1} real rules round-trip unchanged and the server accepts the edited script (nothing saved)`);
}
console.log(`${passed} passed`);
