#!/usr/bin/env node
/**
 * Command line for scheduled or manual runs.
 *   node dist/cli.js doctor            check every service
 *   node dist/cli.js alias-reminders   put a reminder note in INBOX for temporary aliases nearing expiry
 */
import { deliverReminder, describeAlias, dueReminders, syncFromServer } from "./aliases.js";
import { checkConnections } from "./doctor.js";

const command = process.argv[2];
try {
  if (command === "doctor") console.log(await checkConnections());
  else if (command === "alias-reminders") {
    await syncFromServer().catch(() => undefined);
    const due = dueReminders();
    if (!due.length) console.log("No alias reminders due.");
    else {
      const uid = await deliverReminder(due);
      console.log(`Reminder placed in INBOX (uid ${uid}) for:\n${due.map((r) => `- ${describeAlias(r)}`).join("\n")}`);
    }
  } else {
    console.error("Usage: node dist/cli.js doctor | alias-reminders");
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  // Open IMAP/SMTP connections would keep the process alive.
  process.exit(process.exitCode ?? 0);
}
