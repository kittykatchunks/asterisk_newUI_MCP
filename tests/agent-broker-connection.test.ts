import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { test } from "node:test";
import { createAgentBrokerConnectionHandler } from "../src/agent-broker-connection.ts";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";
import { readBrokerFrame, writeBrokerFrame } from "../src/agent-broker-frame.ts";

async function fixture() {
  const peer = { customer: "customer-a", epoch: randomUUID(), principal: "fixture-worker" };
  let reads = 0;
  let identified = 0;
  let allowed = true;
  let identityFailure: Error | undefined;
  let source = async () => {};
  const broker = createAgentBrokerReadback(peer, {
    async inventory() { reads++; await source(); return []; },
    async generation() { return undefined; },
  });
  const handler = createAgentBrokerConnectionHandler(broker, () => {
    if (identityFailure) throw identityFailure;
    identified++; return allowed ? peer : undefined;
  });
  const sockets = new Set<Socket>();
  const tasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  const accepted: Socket[] = [];
  let signal: AbortSignal | undefined;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); accepted.push(socket);
    socket.once("close", () => sockets.delete(socket));
    tasks.push(handler.handle(socket, signal).then(() => {}, (error: unknown) => { errors.push(error); }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const connect = async () => {
    const socket = createConnection({ host: "127.0.0.1", port: address.port, allowHalfOpen: true });
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    await once(socket, "connect");
    return socket;
  };
  return {
    peer, handler, tasks, errors, accepted, connect,
    request: JSON.stringify({ version: 1, customer: peer.customer, epoch: peer.epoch, action: "inventory" }),
    reads: () => reads, identified: () => identified,
    allow(value: boolean) { allowed = value; },
    identityFailure(value: Error | undefined) { identityFailure = value; },
    source(value: () => Promise<void>) { source = value; },
    signal(value: AbortSignal) { signal = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(tasks);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("connection handler authenticates before reading and serves one real half-closed readback", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    const response = readBrokerFrame(client, "response");
    await writeBrokerFrame(client, f.request, "request");
    assert.deepEqual(JSON.parse(await response), {
      version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "inventory", generations: [],
    });
    await Promise.all(f.tasks);
    assert.equal(f.reads(), 1); assert.equal(f.identified(), 1);
    assert.deepEqual(f.errors, []);
    await assert.rejects(f.handler.handle(f.accepted[0]), /single-use/);
    assert.equal(f.accepted[0].listenerCount("error"), 0);
  } finally { await f.close(); }
});

test("unauthenticated peer is rejected before request bytes or source access", async () => {
  const f = await fixture();
  try {
    f.allow(false);
    const client = await f.connect();
    await assert.rejects(readBrokerFrame(client, "response"), /Truncated|closed/);
    await Promise.all(f.tasks);
    assert.equal(f.reads(), 0);
    assert.match(String(f.errors[0]), /peer denied/);
    assert.equal(f.accepted[0].readableDidRead, false);
  } finally { await f.close(); }
});

test("one admitted connection excludes idle competitors before identity checks; cancellation permits later work", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.signal(controller.signal);
  try {
    const first = await f.connect();
    const firstRejected = assert.rejects(readBrokerFrame(first, "response"), /Truncated|closed/);
    const second = await f.connect();
    await assert.rejects(readBrokerFrame(second, "response"), /Truncated|closed/);
    assert.equal(f.identified(), 1);
    assert.equal(f.reads(), 0);
    const reason = new Error("fixture stop");
    controller.abort(reason);
    await firstRejected;
    await Promise.all(f.tasks);
    assert.ok(f.errors.includes(reason));
    assert.ok(f.errors.some((error) => String(error).includes("capacity")));
    f.signal(new AbortController().signal);
    const next = await f.connect();
    const response = readBrokerFrame(next, "response");
    await writeBrokerFrame(next, f.request, "request");
    assert.equal(JSON.parse(await response).action, "inventory");
    await Promise.all(f.tasks);
    assert.equal(f.reads(), 1);
  } finally { controller.abort(); await f.close(); }
});

test("cancelled uncooperative readback retains capacity until actual settlement", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.source(async () => { enter(); await gate; });
  f.signal(controller.signal);
  try {
    const client = await f.connect();
    const rejected = assert.rejects(readBrokerFrame(client, "response"), /Truncated|closed/);
    await writeBrokerFrame(client, f.request, "request");
    await entered;
    const reason = new Error("fixture cancelled source");
    controller.abort(reason);
    await rejected;
    const competitor = await f.connect();
    await assert.rejects(readBrokerFrame(competitor, "response"), /Truncated|closed/);
    assert.equal(f.identified(), 1);
    assert.equal(f.reads(), 1);
    release();
    await Promise.all(f.tasks);
    assert.ok(f.errors.includes(reason));
    assert.ok(f.errors.some((error) => String(error).includes("capacity")));
  } finally { release(); controller.abort(); await f.close(); }
});

test("idle connection has a total five-second budget, not an unbounded admission slot", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await assert.rejects(readBrokerFrame(client, "response"), /Truncated|closed|timed out/);
    await Promise.all(f.tasks);
    assert.equal(f.reads(), 0);
    assert.ok(f.errors[0] instanceof Error && f.errors[0].name === "TimeoutError");
  } finally { await f.close(); }
});

test("identity and source exceptions propagate without sending a success frame; the next connection is still admitted", async () => {
  const f = await fixture();
  try {
    const identityFailure = new Error("fixture identity infrastructure failure");
    f.identityFailure(identityFailure);
    const denied = await f.connect();
    await assert.rejects(readBrokerFrame(denied, "response"), /Truncated|closed/);
    await Promise.all(f.tasks);
    assert.ok(f.errors.includes(identityFailure));
    assert.equal(f.reads(), 0);
    f.identityFailure(undefined);
    const sourceFailure = new Error("fixture source failure");
    f.source(async () => { throw sourceFailure; });
    const broken = await f.connect();
    const response = assert.rejects(readBrokerFrame(broken, "response"), /Truncated|closed/);
    await writeBrokerFrame(broken, f.request, "request");
    await response;
    await Promise.all(f.tasks);
    assert.ok(f.errors.includes(sourceFailure));
    f.source(async () => {});
    const recovered = await f.connect();
    const recovery = readBrokerFrame(recovered, "response");
    await writeBrokerFrame(recovered, f.request, "request");
    assert.equal(JSON.parse(await recovery).action, "inventory");
  } finally { await f.close(); }
});

test("transport-owner closure cancels the lifetime without releasing an uncooperative readback early", async () => {
  const f = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.source(async () => { enter(); await gate; });
  try {
    const client = await f.connect();
    await writeBrokerFrame(client, f.request, "request");
    await entered;
    client.destroy();
    // TCP FIN is only a half-close, not a detectable full peer disappearance.
    // Explicitly close the owned server socket to model transport-owner loss.
    f.accepted[0].destroy();
    await once(f.accepted[0], "close");
    const competitor = await f.connect();
    await assert.rejects(readBrokerFrame(competitor, "response"), /Truncated|closed/);
    assert.equal(f.reads(), 1);
    release();
    await Promise.all(f.tasks);
    assert.ok(f.errors.some((error) => String(error).includes("connection closed")));
  } finally { release(); await f.close(); }
});
