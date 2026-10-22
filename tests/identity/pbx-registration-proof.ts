import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo } from "node:dgram";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import type { PbxEndpointSnapshot } from "../../src/pbx-status.ts";
import { createFixtureSipSocket } from "./fixture-sip-socket.ts";
import { createSipRegistrationClient } from "./sip-registration-client.ts";

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

for (const account of accounts) {
  const foreign = accounts.find((item) => item.customer !== account.customer);
  assert.ok(foreign);
  const hostSocket = createSocket("udp4");
  hostSocket.bind(0, "127.0.0.1");
  await once(hostSocket, "listening");
  let socket: typeof hostSocket | Awaited<ReturnType<typeof createFixtureSipSocket>> = hostSocket;
  let localPort = socket.address().port;
  let destinationPort = account.port;
  const tag = randomUUID();
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
  const client = createSipRegistrationClient(account, () => ({ socket, localPort, destinationPort }));
  const register = client.register;
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
    const expirySequence = client.sequence;
    // Allow the registrar's periodic cleanup sweep, without refreshing or unregistering.
    await expectContact(false, 40000, acceptedAt + (expiring.contactExpiry - 1) * 1000);
    assert.equal(client.sequence, expirySequence, "No SIP transaction may cause the natural-expiry transition");
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
    const qualificationSequence = client.sequence;
    const ignoredBefore = ignoredOptions;
    answerOptions = false;
    await expectContact(true, 15000, undefined, "Unavailable");
    assert.ok(ignoredOptions > ignoredBefore, "Unreachability must follow intentionally unanswered OPTIONS");
    const answeredBefore = answeredOptions;
    answerOptions = true;
    await expectContact(true, 15000, undefined, "Not in use");
    assert.ok(answeredOptions > answeredBefore, "Recovery must follow a fresh OPTIONS response");
    assert.equal(client.sequence, qualificationSequence, "Qualification recovery must not refresh or replace the registration");
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
