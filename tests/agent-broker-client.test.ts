import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createAgentBrokerClient } from "../src/agent-broker-client.ts";
import { encodeBrokerFrame, readBrokerFrame, writeBrokerFrame } from "../src/agent-broker-frame.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "broker-client-"));
  const path = process.platform === "win32" ? `\\\\.\\pipe\\broker-client-${randomUUID()}` :
    join(directory, "readback.sock");
  const peer = { customer: "customer-a", epoch: randomUUID(), principal: "journal-worker" };
  const generationId = randomUUID();
  const observation = { newCallsBlocked: true, dialogs: "unknown", removed: false };
  const base = { version: 1, customer: peer.customer, epoch: peer.epoch };
  let respond = async (socket: Socket, request: Record<string, unknown>) => {
    await writeBrokerFrame(socket, JSON.stringify({ ...base, action: request.action,
      ...(request.action === "inventory" ? { generations: [] } :
        { generationId, state: "observed", observation }) }), "response");
  };
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const tasks: Promise<void>[] = [];
  const errors: unknown[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    tasks.push((async () => {
      const request = JSON.parse(await readBrokerFrame(socket, "request"));
      requests.push(request);
      await respond(socket, request);
    })().catch((error: unknown) => { errors.push(error); }));
  });
  server.listen(path);
  await once(server, "listening");
  return {
    path, peer, generationId, observation, base, requests, errors,
    client: createAgentBrokerClient(path, peer),
    respond(value: typeof respond) { respond = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(tasks);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true });
    },
  };
}

test("client pins scope, returns typed results and only sends fixed read operations",
  { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    f.peer.customer = "changed";
    assert.deepEqual(await f.client.inventory(AbortSignal.timeout(1000)), []);
    assert.deepEqual(await f.client.generation(f.generationId, AbortSignal.timeout(1000)), f.observation);
    f.respond(async (socket) => {
      await writeBrokerFrame(socket, JSON.stringify({
        ...f.base, action: "generation", generationId: f.generationId, state: "missing",
      }), "response");
    });
    assert.equal(await f.client.generation(f.generationId, AbortSignal.timeout(1000)), undefined);
    assert.deepEqual(f.requests, [
      { ...f.base, action: "inventory" },
      { ...f.base, action: "generation", generationId: f.generationId },
      { ...f.base, action: "generation", generationId: f.generationId },
    ]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("client rejects mismatched, extra-field and invalid source responses without retries",
  { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    const inventory = { ...f.base, action: "inventory", generations: [] };
    for (const response of [
      { ...inventory, customer: "other" }, { ...inventory, epoch: randomUUID() },
      { ...inventory, version: 2 }, { ...inventory, action: "revoke" },
      { ...inventory, secret: "not-allowed" }, { ...inventory, generations: null },
      { ...inventory, generations: [{ generationId: f.generationId, notAfter: 0, draining: false }] },
      null, [], "invalid",
    ]) {
      f.respond(async (socket) => { await writeBrokerFrame(socket, JSON.stringify(response), "response"); });
      await assert.rejects(f.client.inventory(AbortSignal.timeout(1000)), /Invalid/);
    }
    const generation = { ...f.base, action: "generation", generationId: f.generationId,
      state: "observed", observation: f.observation };
    for (const response of [
      { ...generation, generationId: randomUUID() }, { ...generation, state: "unknown" },
      { ...generation, observation: null }, { ...generation, secret: true },
      { ...generation, state: "missing" },
    ]) {
      f.respond(async (socket) => { await writeBrokerFrame(socket, JSON.stringify(response), "response"); });
      await assert.rejects(f.client.generation(f.generationId, AbortSignal.timeout(1000)), /Invalid/);
    }
    assert.equal(f.requests.length, 15);
  } finally { await f.close(); }
});

test("client rejects truncated, trailing and non-JSON frames",
  { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    for (const bytes of [
      Buffer.alloc(0), Buffer.from([0, 0, 0, 5, 123]),
      Buffer.concat([encodeBrokerFrame("{}", "response"), Buffer.from("x")]),
      encodeBrokerFrame("not-json", "response"),
    ]) {
      f.respond(async (socket) => { socket.end(bytes); });
      await assert.rejects(f.client.inventory(AbortSignal.timeout(1000)));
    }
    assert.equal(f.requests.length, 4);
  } finally { await f.close(); }
});

test("client cancellation prevents overlap, closes the socket and allows fresh recovery",
  { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    f.respond(async () => { entered(); await held; });
    const first = f.client.inventory(controller.signal);
    const rejected = assert.rejects(first, (error: unknown) => error === reason);
    await ready;
    await assert.rejects(f.client.inventory(AbortSignal.timeout(1000)), /already in flight/);
    controller.abort(reason);
    await rejected;
    release();
    f.respond(async (socket) => {
      await writeBrokerFrame(socket, JSON.stringify({ ...f.base, action: "inventory", generations: [] }), "response");
    });
    assert.deepEqual(await f.client.inventory(AbortSignal.timeout(1000)), []);
    await assert.rejects(f.client.inventory(controller.signal), (error: unknown) => error === reason);
    await assert.rejects(f.client.generation("invalid", AbortSignal.timeout(1000)), /generation ID/);
    assert.equal(f.requests.length, 2);
  } finally { release(); await f.close(); }
});

test("client validates configuration and propagates connect failure without retry", async () => {
  const f = await fixture();
  await f.close();
  for (const path of ["relative.sock", `${f.path}\0`]) {
    assert.throws(() => createAgentBrokerClient(path, f.peer), /absolute local socket path/);
  }
  assert.throws(() => createAgentBrokerClient(f.path, { ...f.peer, epoch: "bad" }), /binding/);
  await assert.rejects(f.client.inventory(AbortSignal.timeout(1000)), (error: unknown) =>
    error instanceof Error && "code" in error && ["ENOENT", "ECONNREFUSED"].includes(String(error.code)));
});

test("client enforces its own five-second deadline and requires response EOF",
  { skip: process.platform !== "linux" }, async () => {
  const f = await fixture();
  try {
    f.respond(async (socket) => {
      socket.write(encodeBrokerFrame(JSON.stringify({
        ...f.base, action: "inventory", generations: [],
      }), "response"));
    });
    const start = performance.now();
    await assert.rejects(f.client.inventory(AbortSignal.timeout(10000)),
      (error: unknown) => error instanceof Error && error.name === "TimeoutError");
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4800 && elapsed < 6500, `Client deadline took ${elapsed} ms`);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
