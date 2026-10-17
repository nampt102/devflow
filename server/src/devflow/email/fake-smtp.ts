import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

// Minimal SMTP server for tests and offline demos: plain text, no STARTTLS. It records every accepted
// message and can refuse a login, refuse recipients, or drop the connection.

export interface FakeSmtp {
  port: number;
  messages: Array<{ from: string; to: string[]; data: string; subject: string; text: string; authUser?: string }>;
  /** Recipients (lower case) the server answers 550 to. */
  rejectRcpt: Set<string>;
  failAuth: boolean;
  dropConnections: boolean;
  connections: number;
  close(): Promise<void>;
}

const qpBytes = (text: string) =>
  Buffer.from(text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");

/** Subject (RFC 2047 words) and text body (quoted-printable or base64) of a message nodemailer produced. */
export function decodeMessage(raw: string): { subject: string; text: string } {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = head.replace(/\r\n[ \t]+/g, " ");
  const subjectLine = /^Subject: (.*)$/im.exec(headers)?.[1] ?? "";
  const words = [...subjectLine.matchAll(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi)];
  // decode all words as one byte stream: a multi-byte character may be split between two words
  const decoded = words.length
    ? Buffer.concat(words.map(([, enc, body]) => (enc.toUpperCase() === "B" ? Buffer.from(body, "base64") : qpBytes(body.replace(/_/g, " "))))).toString("utf8")
    : subjectLine;
  const cte = /^Content-Transfer-Encoding: (\S+)/im.exec(headers)?.[1]?.toLowerCase();
  const body = rest.join("\r\n\r\n");
  const text = (cte === "base64" ? Buffer.from(body, "base64") : cte === "quoted-printable" ? qpBytes(body) : Buffer.from(body, "latin1")).toString("utf8");
  return { subject: decoded, text };
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const smtp: FakeSmtp = { port: 0, messages: [], rejectRcpt: new Set(), failAuth: false, dropConnections: false, connections: 0, close: async () => {} };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    smtp.connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (smtp.dropConnections) return void socket.destroy();
    let from = "";
    let to: string[] = [];
    let authUser: string | undefined;
    let data: string[] | null = null;
    let buffer = "";
    let authStep: "none" | "login-user" | "login-pass" = "none";
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 fake-smtp ready");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (data) {
          if (line === ".") {
            smtp.messages.push({ from, to, data: data.join("\r\n"), ...decodeMessage(data.join("\r\n")), authUser });
            data = null;
            to = [];
            reply("250 queued");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        if (authStep === "login-user") {
          authUser = Buffer.from(line, "base64").toString("utf8");
          authStep = "login-pass";
          reply("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authStep === "login-pass") {
          authStep = "none";
          if (smtp.failAuth) return void reply("535 5.7.8 authentication failed");
          reply("235 ok");
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
          socket.write("250-fake-smtp\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n");
        } else if (cmd.startsWith("AUTH LOGIN")) {
          authStep = "login-user";
          reply("334 VXNlcm5hbWU6");
        } else if (cmd.startsWith("MAIL FROM:")) {
          from = line.slice(10).replace(/[<>\s]/g, "").split(" ")[0];
          reply("250 ok");
        } else if (cmd.startsWith("RCPT TO:")) {
          const rcpt = line.slice(8).replace(/[<>\s]/g, "").toLowerCase();
          if (smtp.rejectRcpt.has(rcpt)) return void reply("550 5.1.1 no such user");
          to.push(rcpt);
          reply("250 ok");
        } else if (cmd === "DATA") {
          data = [];
          reply("354 go ahead");
        } else if (cmd === "QUIT") {
          reply("221 bye");
          socket.end();
        } else reply("250 ok");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  smtp.port = (server.address() as AddressInfo).port;
  smtp.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return smtp;
}
