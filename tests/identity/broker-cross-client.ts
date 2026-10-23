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
  generation: { generationId: string };
  cases: { text?: string; hex?: string; padBytes?: number;
    delayEofMs?: number; trailingHex?: string; expected: unknown }[];
  sourceCases: { kind: string; value: unknown; valid: boolean }[];
};
let vector = vectors.cases[index === "reconnect" ? 0 : Number(index)];
if (index === "generation-reconnect") vector = vectors.cases[1];
const passive = ["foreign", "idle", "capacity"].includes(index);
const held = ["held-source", "failed-source", "failed-generation"].includes(index);
if (held) vector = { ...vectors.cases[index === "failed-generation" ? 1 : 0], expected: null };
if (index.startsWith("source:")) {
  const source = vectors.sourceCases[Number(index.split(":")[1])];
  const request = { version: 1, customer: vectors.binding.customer, epoch: vectors.binding.epoch,
    ...(source.kind === "inventory" ? { action: "inventory" } :
      { action: "generation", generationId: vectors.generation.generationId }) };
  vector = { text: JSON.stringify(request), expected: source.valid ? {
    ...request, ...(source.kind === "inventory" ? { generations: source.value } :
      { state: "observed", observation: source.value }),
  } : null };
}
const socket = createConnection({ path, allowHalfOpen: true });
socket.setTimeout(passive || held ? 8000 : 5000, () => socket.destroy(new Error("Cross-runtime client timed out")));
async function send() {
  if (vector.delayEofMs) {
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
  await once(socket, "connect");
  if (passive || vector.expected === null) {
    let responseBytes = 0;
    socket.on("data", (chunk: Buffer) => { responseBytes += chunk.length; });
    const ended = once(socket, "end");
    await Promise.all([ended, passive ? Promise.resolve() : send()]);
    assert.equal(responseBytes, 0);
  } else {
    const response = readBrokerFrame(socket, "response");
    const results = await Promise.all([
      response,
      send(),
    ]);
    assert.deepEqual(JSON.parse(results[0]), vector.expected);
  }
} finally {
  socket.destroy();
}
