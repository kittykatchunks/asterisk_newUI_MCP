import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { readBrokerFrame, writeBrokerFrame } from "../../src/agent-broker-frame.ts";

const [path, index] = process.argv.slice(2);
assert.equal(process.getuid?.(), index === "foreign" ? 1103 : 1102);
assert.equal(process.getgid?.(), 2100);
assert.match(await readFile("/proc/self/status", "utf8"), /^CapEff:\s+0000000000000000$/m);
const vectors = JSON.parse(await readFile("/vectors.json", "utf8")) as {
  binding: { customer: string; epoch: string };
  generation: { generationId: string };
  cases: { text?: string; hex?: string; padBytes?: number; expected: unknown }[];
  sourceCases: { kind: string; value: unknown; valid: boolean }[];
};
let vector = vectors.cases[index === "reconnect" ? 0 : Number(index)];
const passive = ["foreign", "idle", "capacity"].includes(index);
const held = ["held-source", "failed-source"].includes(index);
if (held) vector = { ...vectors.cases[0], expected: null };
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
try {
  await once(socket, "connect");
  if (passive || vector.expected === null) {
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    const ended = once(socket, "end");
    if (!passive) {
      if (vector.hex !== undefined) socket.end(Buffer.from(vector.hex, "hex"));
      else await writeBrokerFrame(socket, vector.text!, "request");
    }
    await ended;
    assert.equal(Buffer.concat(received).length, 0);
  } else {
    const response = readBrokerFrame(socket, "response");
    const results = await Promise.all([
      response,
      writeBrokerFrame(socket, vector.text!.padEnd(vector.padBytes ?? 0, " "), "request"),
    ]);
    assert.deepEqual(JSON.parse(results[0]), vector.expected);
  }
} finally {
  socket.destroy();
}
