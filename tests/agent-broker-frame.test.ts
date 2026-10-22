import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { encodeBrokerFrame, readBrokerFrame } from "../src/agent-broker-frame.ts";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";

test("frames roundtrip byte-fragmented headers and multibyte UTF-8 with exact request/response limits", async () => {
  for (const [kind, size] of [["request", 8192], ["response", 32768]] as const) {
    const text = "\u00e9".repeat(size / 2);
    const encoded = encodeBrokerFrame(text, kind);
    assert.equal(encoded.readUInt32BE(0), size);
    const stream = Readable.from(Array.from(encoded, (byte) => Buffer.from([byte])), { objectMode: false });
    assert.equal(await readBrokerFrame(stream, kind), text);
    assert.throws(() => encodeBrokerFrame(text + "a", kind), /size/);
    assert.throws(() => encodeBrokerFrame("", kind), /size/);
  }
});

test("declared sizes are rejected from the header without waiting for or allocating the body", async () => {
  for (const [kind, size] of [["request", 0], ["request", 8193], ["request", 0xffffffff],
    ["response", 32769]] as const) {
    const stream = new PassThrough();
    const pending = readBrokerFrame(stream, kind);
    const rejected = assert.rejects(pending, /size/);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(size);
    stream.write(header);
    await rejected;
    assert.equal(stream.destroyed, true);
    assert.equal(stream.listenerCount("data"), 0);
  }
});

test("truncation, trailing data, second frames, invalid UTF-8 and early close reject explicitly", async () => {
  const encoded = encodeBrokerFrame("{}", "request");
  for (const bytes of [
    Buffer.alloc(0), encoded.subarray(0, 3), encoded.subarray(0, encoded.length - 1),
    Buffer.concat([encoded, Buffer.from("x")]), Buffer.concat([encoded, encoded]),
    Buffer.from([0, 0, 0, 1, 0xff]),
  ]) await assert.rejects(readBrokerFrame(Readable.from([bytes], { objectMode: false }), "request"));
  const stream = new PassThrough();
  const pending = readBrokerFrame(stream, "request");
  const rejected = assert.rejects(pending, /closed before EOF/);
  stream.destroy();
  await rejected;
});

test("EOF is required so a complete prefix is never processed before trailing data is excluded", async () => {
  const stream = new PassThrough();
  let completed = false;
  const pending = readBrokerFrame(stream, "request").then((text) => { completed = true; return text; });
  stream.write(encodeBrokerFrame("{}", "request"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  stream.end();
  assert.equal(await pending, "{}");
  await assert.rejects(readBrokerFrame(stream, "request"), /single-use/);
});

test("late trailing chunks and oversized chunks are rejected and UTF-8 BOM is not silently removed", async () => {
  const stream = new PassThrough();
  const pending = readBrokerFrame(stream, "request");
  const rejected = assert.rejects(pending, /Trailing/);
  stream.write(encodeBrokerFrame("{}", "request"));
  await new Promise((resolve) => setImmediate(resolve));
  stream.write(Buffer.from("x"));
  await rejected;
  const oversized = Buffer.concat([encodeBrokerFrame("{}", "request"), Buffer.alloc(65536)]);
  await assert.rejects(readBrokerFrame(Readable.from([oversized], { objectMode: false }), "request"), /Trailing/);
  const withBom = "\ufeff{}";
  assert.equal(await readBrokerFrame(Readable.from([encodeBrokerFrame(withBom, "request")],
    { objectMode: false }), "request"), withBom);
});

test("cancellation, stream errors, invalid modes and overlap preserve explicit errors and clean listeners", async () => {
  const failure = new Error("fixture cancelled");
  for (const before of [true, false]) {
    const controller = new AbortController();
    const stream = new PassThrough();
    if (before) controller.abort(failure);
    const pending = readBrokerFrame(stream, "request", controller.signal);
    const rejected = assert.rejects(pending, (error) => error === failure);
    controller.abort(failure);
    await rejected;
    assert.equal(stream.destroyed, true);
    assert.equal(stream.listenerCount("end"), 0);
  }
  const stream = new PassThrough();
  const pending = readBrokerFrame(stream, "request");
  const rejected = assert.rejects(pending, (error) => error === failure);
  await assert.rejects(readBrokerFrame(stream, "request"), /single-use/);
  stream.destroy(failure);
  await rejected;
  for (const invalid of [new PassThrough({ objectMode: true }), new PassThrough().setEncoding("utf8")]) {
    await assert.rejects(readBrokerFrame(invalid, "request"), /byte-mode/);
  }
});

test("frame read deadline rejects a stalled complete payload without EOF", async () => {
  const stream = new PassThrough();
  const pending = readBrokerFrame(stream, "request");
  stream.write(encodeBrokerFrame("{}", "request"));
  await assert.rejects(pending, /timed out/);
  assert.equal(stream.destroyed, true);
});

test("framed request reaches fixed readback only after full bounded decode and response frames roundtrip", async () => {
  const peer = { customer: "customer-a", epoch: randomUUID(), principal: "journal-worker" };
  let reads = 0;
  const broker = createAgentBrokerReadback(peer, {
    async inventory() { reads++; return []; },
    async generation() { assert.fail("No generation query"); },
  });
  const request = JSON.stringify({ version: 1, customer: peer.customer, epoch: peer.epoch, action: "inventory" });
  const text = await readBrokerFrame(Readable.from([encodeBrokerFrame(request, "request")], { objectMode: false }), "request");
  const result = await broker.read(text, peer);
  const response = await readBrokerFrame(Readable.from([encodeBrokerFrame(JSON.stringify(result), "response")],
    { objectMode: false }), "response");
  assert.deepEqual(JSON.parse(response), result);
  assert.equal(reads, 1);
  const bad = Readable.from([Buffer.concat([encodeBrokerFrame(request, "request"), Buffer.from("x")])], { objectMode: false });
  await assert.rejects((async () => broker.read(await readBrokerFrame(bad, "request"), peer))(), /Trailing/);
  assert.equal(reads, 1);
});
