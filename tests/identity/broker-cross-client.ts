import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { encodeBrokerFrame, readBrokerFrame, writeBrokerFrame } from "../../src/agent-broker-frame.ts";

const [path, index] = process.argv.slice(2);
assert.equal(process.getuid?.(), index === "foreign" ? 1103 : 1102);
assert.equal(process.getgid?.(), 2100);
assert.match(await readFile("/proc/self/status", "utf8"), /^CapEff:\s+0000000000000000$/m);
const vectors = JSON.parse(await readFile("/vectors.json", "utf8")) as {
  binding: { customer: string; epoch: string };
  generation: { generationId: string; notAfter: number; draining: boolean };
  cases: { name?: string; text?: string; hex?: string; padBytes?: number;
    delayEofMs?: number; trailingHex?: string; expected: unknown }[];
  sourceCases: { kind: string; value: unknown; inventoryCount?: number; valid: boolean }[];
};
const disconnectRecovery = index.startsWith("disconnect-reconnect-");
const writerClient = index === "writer-slow" || index === "writer-nonreading";
let vector = vectors.cases[["reconnect", "restart-read"].includes(index) ? 0 : Number(index)];
if (index === "held-reconnect" || index === "cancel-reconnect" || index === "race-reconnect" ||
    index === "completion-success" || writerClient || disconnectRecovery) {
  const entry = disconnectRecovery ? Number(index.slice("disconnect-reconnect-".length)) :
    index === "held-reconnect" ? 6 : index === "race-reconnect" ? 2 :
      index === "completion-success" || writerClient ? 1 : 8;
  if (disconnectRecovery) {
    assert.ok(Number.isSafeInteger(entry) && entry >= 1 && entry <= 16);
    assert.equal(index, `disconnect-reconnect-${entry}`);
  }
  const { customer, epoch } = vectors.binding;
  vector = { ...vectors.cases[0], expected: {
    version: 1, customer, epoch, action: "inventory",
    generations: [{ ...vectors.generation, notAfter: vectors.generation.notAfter + entry }],
  } };
}
if (index === "generation-reconnect") vector = vectors.cases[1];
const passive = ["foreign", "idle", "capacity"].includes(index);
const held = ["held-source", "failed-source", "failed-generation", "no-eof", "crash-wait", "peer-held"].includes(index);
if (held) vector = { ...vectors.cases[index === "failed-generation" ? 1 : 0], expected: null };
if (index.startsWith("source:")) {
  const source = vectors.sourceCases[Number(index.split(":")[1])];
  if (source.inventoryCount !== undefined) {
    source.value = Array.from({ length: source.inventoryCount }, (_, item) => ({
      generationId: `22222222-2222-2222-2222-${item.toString(16).padStart(12, "0")}`,
      notAfter: item + 1, draining: item % 2 === 0,
    }));
  }
  const request = { version: 1, customer: vectors.binding.customer, epoch: vectors.binding.epoch,
    ...(source.kind === "inventory" ? { action: "inventory" } :
      { action: "generation", generationId: vectors.generation.generationId }) };
  vector = { text: JSON.stringify(request), expected: source.valid ? {
    ...request, ...(source.kind === "inventory" ? { generations: source.value } :
      { state: "observed", observation: source.value }),
  } : null };
}
const socket = createConnection({ path, allowHalfOpen: true, ...(writerClient ? { highWaterMark: 512 } : {}) });
const disconnectBytes: Readonly<Record<string, number>> = {
  "disconnect-empty": 0, "disconnect-header-1": 1, "disconnect-header-2": 2,
  "disconnect-header-3": 3, "disconnect-header-only": 4, "disconnect-partial": 7,
  "disconnect-body-last": Buffer.byteLength(vectors.cases[0].text!, "utf8") + 3,
  "disconnect-limit-last": 8195,
};
const halfClose = index.startsWith("half-close-");
const disconnectMode = halfClose ? index.replace("half-close-", "disconnect-") : index;
socket.setTimeout(passive || held || writerClient ? 8000 : 5000, () => socket.destroy(new Error("Cross-runtime client timed out")));
async function send() {
  if (index === "no-eof") {
    socket.write(encodeBrokerFrame(vector.text!, "request"));
  } else if (vector.delayEofMs) {
    socket.write(encodeBrokerFrame(vector.text!, "request"));
    await delay(vector.delayEofMs);
    assert.equal(socket.bytesRead, 0, "Response arrived before request EOF");
    assert.equal(socket.readableEnded, false, "Server closed before request EOF");
    if (vector.trailingHex) socket.end(Buffer.from(vector.trailingHex, "hex"));
    else socket.end();
  } else if (vector.hex !== undefined) socket.end(Buffer.from(vector.hex, "hex"));
  else await writeBrokerFrame(socket, vector.text!.padEnd(vector.padBytes ?? 0, " "), "request");
}
try {
  if (index === "stale-refused") {
    await assert.rejects(once(socket, "connect"), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ECONNREFUSED" &&
      "syscall" in error && error.syscall === "connect");
    assert.equal(socket.bytesRead, 0);
    assert.equal(socket.bytesWritten, 0);
  } else {
    await once(socket, "connect");
    if (writerClient) {
      await send();
      await delay(index === "writer-slow" ? 1000 : 6000);
      if (index === "writer-nonreading") {
        await assert.rejects(readBrokerFrame(socket, "response"), {
          message: "Truncated broker frame",
        });
        assert.ok(socket.bytesRead > 4 && socket.bytesRead < 32772,
          `Expected partial frame, received ${socket.bytesRead}`);
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of socket) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(chunk);
          await delay(20 * Math.ceil(chunk.length / 512));
        }
        const data = Buffer.concat(chunks);
        assert.ok(data.length >= 4);
        assert.equal(data.readUInt32BE(0), 32768);
        assert.equal(data.length, 32772);
        assert.deepEqual(JSON.parse(data.subarray(4).toString("utf8")), vector.expected);
      }
    } else if (index === "peer-held") {
      const ended = once(socket, "end");
      socket.resume();
      await send();
      console.log(JSON.stringify({ holdingPeer: true, clientRuntime: "node" }));
      await ended;
      assert.fail("Held peer ended before parent kill");
    } else if (Object.hasOwn(disconnectBytes, disconnectMode)) {
      const text = disconnectMode === "disconnect-limit-last" ?
        vectors.cases[0].text!.padEnd(8192, " ") : vectors.cases[0].text!;
      const frame = encodeBrokerFrame(text, "request");
      if (disconnectMode === "disconnect-body-last" || disconnectMode === "disconnect-limit-last") {
        assert.equal(frame.length, disconnectBytes[disconnectMode] + 1);
      }
      const data = frame.subarray(0, disconnectBytes[disconnectMode]);
      const ended = halfClose ? once(socket, "end") : undefined;
      if (halfClose) socket.resume();
      const finished = once(socket, "finish");
      socket.end(data);
      await Promise.all([finished, ended]);
      assert.equal(socket.bytesWritten, data.length);
      assert.equal(socket.bytesRead, 0);
      const closed = once(socket, "close");
      socket.destroy();
      await closed;
    } else if (passive || vector.expected === null) {
      let responseBytes = 0;
      socket.on("data", (chunk: Buffer) => { responseBytes += chunk.length; });
      const ended = once(socket, "end");
      try {
        await Promise.all([ended, passive ? Promise.resolve() : send()]);
      } catch (error) {
        assert.ok(vector?.name === "concatenated-valid-requests" && error instanceof Error &&
          "code" in error && error.code === "ECONNRESET" && "syscall" in error && error.syscall === "read",
        `Unexpected rejection transport error: ${String(error)}`);
      }
      assert.equal(responseBytes, 0);
    } else {
      const response = readBrokerFrame(socket, "response");
      const results = await Promise.all([
        response,
        send(),
      ]);
      assert.deepEqual(JSON.parse(results[0]), vector.expected);
    }
  }
} finally {
  socket.destroy();
}
