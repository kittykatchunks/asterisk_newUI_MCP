import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import type { PbxEndpointSnapshot } from "../../src/pbx-status.ts";

interface Registration {
  customer: string;
  username: string;
  secret: string;
  port: number;
}

const accounts: Registration[] = JSON.parse(await readFile(
  join(localEngineeringRoot, ".local-proof", "pbx-status", "registrations.json"), "utf8"));
assert.equal(accounts.length, 2);
const source = await loadLocalPbxStatus(localEngineeringRoot, true);
assert.ok(source);
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

for (const account of accounts) {
  const socket = createSocket("udp4");
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const localPort = socket.address().port;
  const callId = randomUUID();
  const tag = randomUUID();
  const uri = "sip:127.0.0.1";
  let sequence = 0;
  let registered = false;
  const exchange = (expires: number, authorization?: string): Promise<{ code: number; challenge?: string }> => {
    sequence++;
    const packet = Buffer.from([
      `REGISTER ${uri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${localPort};branch=z9hG4bK${randomUUID()};rport`,
      "Max-Forwards: 10", `From: <sip:${account.username}@127.0.0.1>;tag=${tag}`,
      `To: <sip:${account.username}@127.0.0.1>`, `Call-ID: ${callId}`,
      `CSeq: ${sequence} REGISTER`, `Contact: <sip:${account.username}@127.0.0.1:${localPort}>`,
      `Expires: ${expires}`, ...(authorization ? [`Authorization: ${authorization}`] : []),
      "Content-Length: 0", "", "",
    ].join("\r\n"));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: { code: number; challenge?: string }) => {
        clearTimeout(timeout); clearInterval(retry);
        socket.off("message", receive); socket.off("error", fail);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const fail = (error: Error) => finish(error);
      const receive = (data: Buffer) => {
        const text = data.toString("utf8");
        if (!text.includes(`Call-ID: ${callId}\r\n`) || !text.includes(`CSeq: ${sequence} REGISTER\r\n`)) return;
        const code = Number(/^SIP\/2\.0 (\d{3})/.exec(text)?.[1]);
        if (code < 200) return;
        if (!Number.isInteger(code)) { finish(new Error("Invalid synthetic REGISTER response")); return; }
        finish(undefined, { code, challenge: /^WWW-Authenticate:\s*(.+)\r?$/mi.exec(text)?.[1].trim() });
      };
      const send = () => socket.send(packet, account.port, "127.0.0.1", (error) => { if (error) finish(error); });
      const timeout = setTimeout(() => finish(new Error("Synthetic REGISTER timed out")), 5000);
      const retry = setInterval(send, 500);
      socket.on("message", receive); socket.once("error", fail);
      send();
    });
  };
  const register = async (expires: number, password = account.secret) => {
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
  };
  const expectContact = async (present: boolean) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot: PbxEndpointSnapshot = await source.endpoints(account.customer);
      const endpoint = snapshot.endpoints.find((item) => item.id === account.username);
      assert.ok(endpoint, "The configured endpoint must remain visible regardless of contact state");
      assert.equal(snapshot.endpoints.find((item) => item.id === `${account.customer}-static`)?.hasContacts, true);
      if (endpoint.hasContacts === present) return;
      await delay(100);
    }
    assert.fail(`Expected synthetic contact presence ${present} for ${account.customer}`);
  };
  try {
    await expectContact(false);
    const foreign = accounts.find((item) => item.customer !== account.customer);
    assert.ok(foreign);
    assert.notEqual((await register(60, foreign.secret)).code, 200, "Foreign customer credentials must not register this phone");
    await expectContact(false);
    assert.equal((await register(60)).code, 200);
    registered = true;
    await expectContact(true);
    const other = await source.endpoints(foreign.customer);
    assert.equal(other.endpoints.find((item) => item.id === foreign.username)?.hasContacts, false);
    assert.ok(!JSON.stringify(other).includes(account.username));
    assert.equal((await register(0)).code, 200);
    registered = false;
    await expectContact(false);
    console.log(`PASS ${account.customer}: challenged REGISTER, foreign secret denied, contact appears, authenticated unregister removes it; static contact unchanged`);
  } finally {
    try {
      if (registered) assert.equal((await register(0)).code, 200, "Synthetic contact cleanup must succeed");
    } finally { socket.close(); }
  }
}
