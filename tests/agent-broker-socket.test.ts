import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, createConnection } from "node:net";
import type { Socket } from "node:net";
import { Writable } from "node:stream";
import { test } from "node:test";
import { encodeBrokerFrame, readBrokerFrame, writeBrokerFrame } from "../src/agent-broker-frame.ts";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";

test("bounded writer finishes one frame, rejects reuse and does not claim peer processing", async () => {
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  await writeBrokerFrame(sink, "{}", "response");
  assert.deepEqual(Buffer.concat(chunks), encodeBrokerFrame("{}", "response"));
  assert.equal(sink.writableFinished, true);
  await assert.rejects(writeBrokerFrame(sink, "{}", "response"), /single-use/);
  assert.equal(sink.listenerCount("finish"), 0);
  const oversized = new Writable({ write(_chunk, _encoding, callback) { assert.fail("Oversized data cannot be written"); callback(); } });
  await assert.rejects(writeBrokerFrame(oversized, "x".repeat(32769), "response"), /size/);
  assert.equal(oversized.destroyed, true);
});

test("bounded writer propagates source errors, cancellation and premature closure", async () => {
  const reason = new Error("fixture write failure");
  const failing = new Writable({ write(_chunk, _encoding, callback) { callback(reason); } });
  await assert.rejects(writeBrokerFrame(failing, "{}", "response"), (error) => error === reason);
  for (const preCancelled of [true, false]) {
    const controller = new AbortController();
    const sink = new Writable({ write() {} });
    if (preCancelled) controller.abort(reason);
    const pending = writeBrokerFrame(sink, "{}", "request", controller.signal);
    const rejected = assert.rejects(pending, (error) => error === reason);
    controller.abort(reason);
    await rejected;
    assert.equal(sink.destroyed, true);
    assert.equal(sink.listenerCount("finish"), 0);
  }
  const sink = new Writable({ write() {} });
  const pending = writeBrokerFrame(sink, "{}", "response");
  const rejected = assert.rejects(pending, /closed before finish/);
  sink.destroy();
  await rejected;
  const objectMode = new Writable({ objectMode: true, write(_chunk, _encoding, callback) { callback(); } });
  await assert.rejects(writeBrokerFrame(objectMode, "{}", "response"), /byte-mode/);
});

test("bounded writer times out under unresolved backpressure and destroys only its owned stream", async () => {
  const sink = new Writable({ highWaterMark: 1, write() {} });
  const unrelated = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    await assert.rejects(writeBrokerFrame(sink, "x".repeat(32768), "response"), /write timed out/);
    assert.equal(sink.destroyed, true);
    assert.equal(unrelated.destroyed, false);
    assert.equal(sink.listenerCount("error"), 0);
  } finally { unrelated.destroy(); }
});

test("real loopback half-close permits bounded readback response only after request EOF; malformed frames never reach source", async () => {
  const peer = { customer: "customer-a", epoch: randomUUID(), principal: "fixture-worker" };
  let reads = 0;
  const broker = createAgentBrokerReadback(peer, {
    async inventory() { reads++; return []; },
    async generation() { assert.fail("Not a generation request"); },
  });
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const tasks: Promise<void>[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // Test-only trusted metadata; this loopback fixture authenticates no OS peer.
    const task = (async () => {
      const request = await readBrokerFrame(socket, "request");
      const result = await broker.read(request, peer);
      await writeBrokerFrame(socket, JSON.stringify(result), "response");
    })();
    tasks.push(task.then(() => {}, (error: unknown) => { failures.push(error); socket.destroy(); }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connect = async () => {
      const socket = createConnection({ host: "127.0.0.1", port: address.port, allowHalfOpen: true });
      sockets.add(socket); socket.once("close", () => sockets.delete(socket));
      await once(socket, "connect");
      return socket;
    };
    const request = JSON.stringify({ version: 1, customer: peer.customer, epoch: peer.epoch, action: "inventory" });
    const client = await connect();
    const response = readBrokerFrame(client, "response");
    await writeBrokerFrame(client, request, "request");
    assert.deepEqual(JSON.parse(await response), {
      version: 1, customer: peer.customer, epoch: peer.epoch, action: "inventory", generations: [],
    });
    await Promise.all(tasks);
    assert.equal(reads, 1);
    assert.deepEqual(failures, []);

    const malformed = await connect();
    const invalidResponse = assert.rejects(readBrokerFrame(malformed, "response"), /Truncated|closed/);
    malformed.end(Buffer.concat([encodeBrokerFrame(request, "request"), Buffer.from("x")]));
    await invalidResponse;
    await Promise.all(tasks);
    assert.equal(reads, 1);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /Trailing/);

    const held = await connect();
    const heldResponse = readBrokerFrame(held, "response");
    held.write(encodeBrokerFrame(request, "request"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(reads, 1, "A complete request without EOF must not invoke readback");
    held.end();
    assert.equal(JSON.parse(await heldResponse).action, "inventory");
    await Promise.all(tasks);
    assert.equal(reads, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(tasks);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
