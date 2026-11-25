import net from "node:net";
import tls from "node:tls";
import { config, requireMailCredentials } from "./config.js";

/**
 * Minimal ManageSieve client (RFC 5804): STARTTLS, AUTHENTICATE PLAIN,
 * LISTSCRIPTS, GETSCRIPT, PUTSCRIPT, CHECKSCRIPT, SETACTIVE, DELETESCRIPT.
 * One short connection per operation; filters change rarely.
 */
class SieveConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer = "";
  private waiter: (() => void) | null = null;

  async open(): Promise<void> {
    requireMailCredentials();
    const { host, port } = config.sieve;
    this.attach(net.connect({ host, port }));
    await this.response();
    await this.command("STARTTLS");
    const plain = this.socket;
    plain.removeAllListeners("data");
    this.buffer = "";
    await new Promise<void>((resolve, reject) => {
      const secure = tls.connect({ socket: plain, servername: host }, () => resolve());
      secure.once("error", reject);
      this.attach(secure);
    });
    await this.response(); // capabilities re-sent after TLS
    const token = Buffer.from(`\0${config.email}\0${config.password}`).toString("base64");
    await this.command(`AUTHENTICATE "PLAIN" "${token}"`);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("ManageSieve server timed out")));
    socket.on("data", (chunk: string) => { this.buffer += chunk; this.waiter?.(); });
    socket.on("error", () => this.waiter?.());
    socket.on("close", () => this.waiter?.());
  }

  /** Reads one complete response, including {n} literals; returns the data lines before the status line. */
  private async response(): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf("\r\n");
      if (nl < 0) {
        if (this.socket.destroyed) throw new Error("ManageSieve connection closed unexpectedly");
        await new Promise<void>((resolve) => { this.waiter = resolve; });
        this.waiter = null;
        continue;
      }
      const line = this.buffer.slice(0, nl);
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (literal) {
        const size = Number(literal[1]);
        const start = nl + 2;
        while (Buffer.byteLength(this.buffer.slice(start)) < size) {
          if (this.socket.destroyed) throw new Error("ManageSieve connection closed mid-literal");
          await new Promise<void>((resolve) => { this.waiter = resolve; });
          this.waiter = null;
        }
        const rest = Buffer.from(this.buffer.slice(start));
        const body = rest.subarray(0, size).toString("utf8");
        this.buffer = rest.subarray(size).toString("utf8").replace(/^\r\n/, "");
        // A status line can carry its explanation as a literal: NO {45}\r\n<text>
        if (/^(NO|BYE)\b/i.test(line)) throw new Error(`ManageSieve refused: ${body.trim()}`);
        if (/^OK\b/i.test(line)) return lines;
        lines.push(`\u0000LITERAL${body}`);
        continue;
      }
      this.buffer = this.buffer.slice(nl + 2);
      if (/^OK\b/i.test(line)) return lines;
      if (/^(NO|BYE)\b/i.test(line)) throw new Error(`ManageSieve refused: ${line.replace(/^(NO|BYE)\s*/i, "").trim()}`);
      if (line) lines.push(line);
    }
  }

  async command(cmd: string, literal?: string): Promise<string[]> {
    if (literal === undefined) this.socket.write(`${cmd}\r\n`);
    else this.socket.write(`${cmd} {${Buffer.byteLength(literal)}+}\r\n${literal}\r\n`);
    return this.response();
  }

  close(): void {
    try { this.socket.write("LOGOUT\r\n"); } catch { /* already closed */ }
    this.socket.end();
  }
}

const quote = (s: string) => JSON.stringify(s);

async function withSieve<T>(fn: (c: SieveConnection) => Promise<T>): Promise<T> {
  const c = new SieveConnection();
  await c.open();
  try { return await fn(c); } finally { c.close(); }
}

export const sieve = {
  async list(): Promise<{ name: string; active: boolean }[]> {
    return withSieve(async (c) =>
      (await c.command("LISTSCRIPTS")).map((line) => {
        const m = /^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?/i.exec(line);
        return { name: m ? JSON.parse(`"${m[1]}"`) : line, active: Boolean(m?.[2]) };
      }),
    );
  },
  async get(name: string): Promise<string> {
    return withSieve(async (c) => {
      const lines = await c.command(`GETSCRIPT ${quote(name)}`);
      return lines.find((l) => l.startsWith("\u0000LITERAL"))?.slice(8) ?? "";
    });
  },
  /** Validates first, then stores. Throws with the server's explanation if the script is invalid. */
  async put(name: string, script: string): Promise<void> {
    await withSieve(async (c) => {
      await c.command("CHECKSCRIPT", script);
      await c.command(`PUTSCRIPT ${quote(name)}`, script);
    });
  },
  async check(script: string): Promise<void> {
    await withSieve((c) => c.command("CHECKSCRIPT", script));
  },
  async activate(name: string): Promise<void> {
    await withSieve((c) => c.command(`SETACTIVE ${quote(name)}`));
  },
  async remove(name: string): Promise<void> {
    await withSieve((c) => c.command(`DELETESCRIPT ${quote(name)}`));
  },
  /** Name and body of the active script ("" when none is active). */
  async active(): Promise<{ name: string; script: string }> {
    const scripts = await this.list();
    const active = scripts.find((s) => s.active);
    return active ? { name: active.name, script: await this.get(active.name) } : { name: "", script: "" };
  },
};
