import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo } from "node:dgram";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import type { PbxEndpointSnapshot } from "../../src/pbx-status.ts";
import { createFixtureSipSocket } from "./fixture-sip-socket.ts";

interface Registration {
  customer: string;
  username: string;
  secret: string;
  port: number;
}

interface RegistrationResponse {
  code: number;
  challenge?: string;
  contactExpiry?: number;
}

const accounts: Registration[] = JSON.parse(await readFile(
  join(localEngineeringRoot, ".local-proof", "pbx-status", "registrations.json"), "utf8"));
assert.equal(accounts.length, 2);
const source = await loadLocalPbxStatus(localEngineeringRoot, true);
assert.ok(source);
const md5 = (value: string) => createHash("md5").update(value).digest("hex");

for (const account of accounts) {
  const foreign = accounts.find((item) => item.customer !== account.customer);
  assert.ok(foreign);
  const hostSocket = createSocket("udp4");
  hostSocket.bind(0, "127.0.0.1");
  await once(hostSocket, "listening");
  let socket: typeof hostSocket | Awaited<ReturnType<typeof createFixtureSipSocket>> = hostSocket;
  let localPort = socket.address().port;
  let destinationPort = account.port;
  const callId = randomUUID();
  const tag = randomUUID();
  const uri = "sip:127.0.0.1";
  let sequence = 0;
  let registered = false;
  let answerOptions = false;
  let answeredOptions = 0;
  let ignoredOptions = 0;
  let optionsError: Error | undefined;
  const respondOptions = (data: Buffer, remote: Pick<RemoteInfo, "port" | "address">) => {
    const text = data.toString("utf8");
    if (!text.startsWith("OPTIONS ")) return;
    if (!answerOptions) { ignoredOptions++; return; }
    const headers = text.split("\r\n");
    const values = (name: string) => headers.filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    const via = values("Via");
    const from = values("From")[0];
    const to = values("To")[0];
    const id = values("Call-ID")[0];
    const cseq = values("CSeq")[0];
    if (!via.length || !from || !to || !id || !cseq || !/\d+ OPTIONS$/i.test(cseq)) {
      optionsError = new Error("Malformed synthetic OPTIONS request");
      return;
    }
    const response = ["SIP/2.0 200 OK", ...via, from,
      /;tag=/i.test(to) ? to : `${to};tag=${tag}`, id, cseq, "Content-Length: 0", "", ""].join("\r\n");
    socket.send(response, remote.port, remote.address, (error) => {
      if (error) optionsError = error;
      else answeredOptions++;
    });
  };
  socket.on("message", respondOptions);
  const exchange = (expires: number, authorization?: string): Promise<RegistrationResponse> => {
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
      const finish = (error?: Error, result?: RegistrationResponse) => {
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
        const contact = /^Contact:\s*(.+)\r?$/mi.exec(text)?.[1];
        const expiry = contact && /;\s*expires=(\d+)(?:[;\s,]|$)/i.exec(contact)?.[1];
        finish(undefined, {
          code, challenge: /^WWW-Authenticate:\s*(.+)\r?$/mi.exec(text)?.[1].trim(),
          contactExpiry: expiry ? Number(expiry) : undefined,
        });
      };
      const send = () => socket.send(packet, destinationPort, "127.0.0.1", (error) => { if (error) finish(error); });
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
  const expectContact = async (present: boolean, timeoutMs = 2500, earliestAbsenceAt?: number,
    deviceState?: string) => {
    const deadline = performance.now() + timeoutMs;
    let lastState: string | undefined;
    do {
      const snapshot: PbxEndpointSnapshot = await source.endpoints(account.customer);
      const observedAt = performance.now();
      const endpoint = snapshot.endpoints.find((item) => item.id === account.username);
      assert.ok(endpoint, "The configured endpoint must remain visible regardless of contact state");
      lastState = endpoint.deviceState;
      assert.equal(optionsError, undefined, "Synthetic OPTIONS responder must not fail");
      if (deviceState !== undefined) assert.equal(endpoint.hasContacts, true, "Qualification must not remove the registered contact");
      assert.equal(snapshot.endpoints.find((item) => item.id === `${account.customer}-static`)?.hasContacts, true);
      const other: PbxEndpointSnapshot = await source.endpoints(foreign.customer);
      assert.equal(other.endpoints.find((item) => item.id === foreign.username)?.hasContacts, false);
      assert.equal(other.endpoints.find((item) => item.id === `${foreign.customer}-static`)?.hasContacts, true);
      assert.ok(!JSON.stringify(other).includes(account.username));
      if (endpoint.hasContacts === present && (deviceState === undefined || endpoint.deviceState === deviceState)) {
        if (!present && earliestAbsenceAt !== undefined) {
          assert.ok(observedAt >= earliestAbsenceAt, "Contact disappeared before its accepted lifetime");
        }
        return;
      }
      await delay(250);
    } while (performance.now() < deadline);
    assert.fail(`Expected synthetic contact presence ${present}${deviceState ? ` and device state ${deviceState}` : ""} for ${account.customer}; last state=${lastState}, answered OPTIONS=${answeredOptions}, ignored OPTIONS=${ignoredOptions}`);
  };
  try {
    await expectContact(false);
    assert.notEqual((await register(60, foreign.secret)).code, 200, "Foreign customer credentials must not register this phone");
    await expectContact(false);
    assert.equal((await register(60)).code, 200);
    registered = true;
    await expectContact(true);
    assert.equal((await register(0)).code, 200);
    registered = false;
    await expectContact(false);
    console.log(`PASS ${account.customer}: challenged REGISTER, foreign secret denied, contact appears, authenticated unregister removes it; static contact unchanged`);

    const expiring = await register(5);
    const acceptedAt = performance.now();
    assert.equal(expiring.code, 200);
    registered = true;
    assert.ok(expiring.contactExpiry !== undefined && expiring.contactExpiry >= 4 && expiring.contactExpiry <= 5,
      "PBX must report four or five whole seconds remaining for the requested five-second lifetime");
    await expectContact(true);
    const expirySequence = sequence;
    // Allow the registrar's periodic cleanup sweep, without refreshing or unregistering.
    await expectContact(false, 40000, acceptedAt + (expiring.contactExpiry - 1) * 1000);
    assert.equal(sequence, expirySequence, "No SIP transaction may cause the natural-expiry transition");
    registered = false;
    console.log(`PASS ${account.customer}: accepted five-second contact expires without refresh/unregister; static and foreign contacts unchanged`);

    const fixtureSocket = await createFixtureSipSocket(account.customer);
    hostSocket.close();
    socket = fixtureSocket;
    localPort = socket.address().port;
    destinationPort = 5060;
    socket.on("message", respondOptions);
    answerOptions = true;
    assert.equal((await register(60)).code, 200);
    registered = true;
    await expectContact(true, 15000, undefined, "Not in use");
    assert.ok(answeredOptions > 0, "Reachability must follow a real successful OPTIONS response");
    const qualificationSequence = sequence;
    const ignoredBefore = ignoredOptions;
    answerOptions = false;
    await expectContact(true, 15000, undefined, "Unavailable");
    assert.ok(ignoredOptions > ignoredBefore, "Unreachability must follow intentionally unanswered OPTIONS");
    const answeredBefore = answeredOptions;
    answerOptions = true;
    await expectContact(true, 15000, undefined, "Not in use");
    assert.ok(answeredOptions > answeredBefore, "Recovery must follow a fresh OPTIONS response");
    assert.equal(sequence, qualificationSequence, "Qualification recovery must not refresh or replace the registration");
    assert.equal((await register(0)).code, 200);
    registered = false;
    await expectContact(false);
    console.log(`PASS ${account.customer}: OPTIONS response/silence/recovery changes device state without losing its contact; static and foreign contacts unchanged`);
  } finally {
    try {
      if (registered) assert.equal((await register(0)).code, 200, "Synthetic contact cleanup must succeed");
    } finally {
      socket.off("message", respondOptions);
      await socket.close();
    }
  }
}
