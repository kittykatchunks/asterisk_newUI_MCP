import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

interface SipTransport extends EventEmitter {
  send(packet: Buffer, port: number, host: string, callback: (error: Error | null) => void): void;
}
interface RegistrationResponse {
  code: number;
  challenge?: string;
  contactExpiry?: number;
}

export function createSipRegistrationClient(account: { username: string; secret: string },
  transport: () => { socket: SipTransport; localPort: number; destinationPort: number }) {
  const callId = randomUUID();
  const tag = randomUUID();
  const uri = "sip:127.0.0.1";
  const md5 = (value: string) => createHash("md5").update(value).digest("hex");
  let sequence = 0;
  const exchange = (expires: number, authorization?: string): Promise<RegistrationResponse> => {
    const { socket, localPort, destinationPort } = transport();
    const cseq = ++sequence;
    const packet = Buffer.from([
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${localPort};branch=z9hG4bK${randomUUID()};rport`,
      "Max-Forwards: 10", `From: <sip:${account.username}@127.0.0.1>;tag=${tag}`,
      `To: <sip:${account.username}@127.0.0.1>`, `Call-ID: ${callId}`,
      `CSeq: ${cseq} REGISTER`, `Contact: <sip:${account.username}@127.0.0.1:${localPort}>`,
      `Expires: ${expires}`, ...(authorization ? [`Authorization: ${authorization}`] : []),
      "Content-Length: 0", "", "",
    ].join("\r\n"));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: RegistrationResponse) => {
        clearTimeout(timeout); clearInterval(retry);
        socket.off("message", receive); socket.off("error", fail);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const fail = (error: Error) => finish(error);
      const receive = (data: Buffer) => {
        const text = data.toString("utf8");
        if (!text.includes(`Call-ID: ${callId}\r\n`) || !text.includes(`CSeq: ${cseq} REGISTER\r\n`)) return;
        const code = Number(/^SIP\/2\.0 (\d{3})/.exec(text)?.[1]);
        if (code < 200) return;
        if (!Number.isInteger(code)) { finish(new Error("Invalid synthetic REGISTER response")); return; }
        const contact = /^Contact:\s*(.+)\r?$/mi.exec(text)?.[1];
        const expiry = contact && /;\s*expires=(\d+)(?:[;\s,]|$)/i.exec(contact)?.[1];
        finish(undefined, { code, challenge: /^WWW-Authenticate:\s*(.+)\r?$/mi.exec(text)?.[1].trim(),
          contactExpiry: expiry ? Number(expiry) : undefined });
      };
      const send = () => socket.send(packet, destinationPort, "127.0.0.1", (error) => { if (error) finish(error); });
      const timeout = setTimeout(() => finish(new Error("Synthetic REGISTER timed out")), 5000);
      const retry = setInterval(send, 500);
      socket.on("message", receive); socket.once("error", fail);
      send();
    });
  };
  return {
    get sequence() { return sequence; },
    async register(expires: number, password = account.secret) {
      const challenged = await exchange(expires);
      assert.equal(challenged.code, 401, "Synthetic registration must require digest authentication");
      assert.ok(challenged.challenge && challenged.challenge.startsWith("Digest "));
      const fields = Object.fromEntries(Array.from(
        challenged.challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g),
        (match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
      assert.equal((fields.algorithm ?? "MD5").toUpperCase(), "MD5");
      const ha1 = md5(`${account.username}:${fields.realm}:${password}`);
      const ha2 = md5(`REGISTER:${uri}`);
      const cnonce = randomUUID().replaceAll("-", "");
      const qop = fields.qop ? "auth" : undefined;
      if (qop) assert.ok(fields.qop.split(",").includes("auth"));
      const response = qop ? md5(`${ha1}:${fields.nonce}:00000001:${cnonce}:auth:${ha2}`)
        : md5(`${ha1}:${fields.nonce}:${ha2}`);
      return exchange(expires, "Digest " + [
        `username="${account.username}"`, `realm="${fields.realm}"`, `nonce="${fields.nonce}"`,
        `uri="${uri}"`, `response="${response}"`, "algorithm=MD5",
        ...(qop ? [`qop=auth`, "nc=00000001", `cnonce="${cnonce}"`] : []),
        ...(fields.opaque ? [`opaque="${fields.opaque}"`] : []),
      ].join(", "));
    },
  };
}
